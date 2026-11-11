import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { Logger } from "../logger.js";
import {
	ALIVE_PATH,
	type Alive,
	CONFIG_PATH,
	CONTROL_PATH,
	JOIN_PATH,
	joinRequestSchema,
	type MainFrame,
	NODE_ID_HEADER,
	NODE_SECRET_HEADER,
	type NodeFrame,
	nodeFrameSchema,
	parseFrame,
} from "./protocol.js";
import type { Registry } from "./registry.js";
import { PING_PATH } from "./write-proxy.js";

const MAX_BODY_BYTES = 16 * 1024;

const PING_MS = 15_000;

export type ControlServerDeps = {
	registry: Registry;
	log: Pick<Logger, "info" | "warn">;
	nodeId: string;
	isMain: () => boolean;
	draining?: () => boolean;
	primaryDownSince?: () => number | null;
	onFrame?: (nodeId: string, frame: NodeFrame) => void;
	routes?: (request: IncomingMessage, response: ServerResponse) => boolean;
	config?: (nodeId: string) => Promise<Record<string, string>>;
	app?: (request: IncomingMessage, response: ServerResponse) => void;
};

const VERIFIED_TTL_MS = 60_000;

type Link = {
	socket: WebSocket;
	alive: boolean;
};

const readBody = async (request: IncomingMessage): Promise<string> => {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of request) {
		size += (chunk as Buffer).length;

		if (size > MAX_BODY_BYTES) {
			throw new Error("request body too large");
		}

		chunks.push(chunk as Buffer);
	}

	return Buffer.concat(chunks).toString("utf8");
};

const respond = (response: ServerResponse, status: number, body: unknown): void => {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
};

const headerOf = (request: IncomingMessage, name: string): string | null => {
	const value = request.headers[name];

	return typeof value === "string" && value !== "" ? value : null;
};

export class ControlServer {
	private readonly wss = new WebSocketServer({ noServer: true });
	private readonly links = new Map<string, Link>();
	private readonly verified = new Map<string, number>();
	private readonly http: Server;
	private ping: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly deps: ControlServerDeps) {
		this.http = createServer((request, response) => {
			void this.handle(request, response).catch((error: unknown) => {
				deps.log.warn({ err: error }, "cluster.requestFailed");
				respond(response, 500, { error: "InternalServerError" });
			});
		});

		this.http.on("upgrade", (request, socket, head) => {
			void this.upgrade(request)
				.then((nodeId) => {
					if (!nodeId) {
						socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
						socket.destroy();

						return;
					}

					this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(nodeId, ws));
				})
				.catch(() => socket.destroy());
		});
	}

	get linked(): string[] {
		return [...this.links.keys()];
	}

	listen(port: number, host: string): Promise<number> {
		return new Promise((resolve) => {
			this.http.listen(port, host, () => {
				const address = this.http.address();

				resolve(typeof address === "object" && address ? address.port : port);
			});

			this.ping = setInterval(() => this.reap(), PING_MS);
			this.ping.unref?.();
		});
	}

	send(nodeId: string, frame: MainFrame): boolean {
		const link = this.links.get(nodeId);

		if (!link || link.socket.readyState !== link.socket.OPEN) {
			return false;
		}

		link.socket.send(JSON.stringify(frame));

		return true;
	}

	async close(): Promise<void> {
		if (this.ping) clearInterval(this.ping);

		for (const link of this.links.values()) {
			link.socket.close(1001, "shutting down");
		}

		this.links.clear();

		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
		await new Promise<void>((resolve) => this.http.close(() => resolve()));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (this.deps.routes?.(request, response)) {
			return;
		}

		const path = new URL(request.url ?? "/", "http://localhost").pathname;

		if (request.method === "GET" && path === ALIVE_PATH) {
			respond(response, 200, {
				node: this.deps.nodeId,
				main: this.deps.isMain(),
				draining: this.deps.draining?.() ?? false,
				primaryDownSince: this.deps.primaryDownSince?.() ?? null,
			} satisfies Alive);

			return;
		}

		if (request.method === "GET" && path === PING_PATH) {
			if (this.deps.isMain()) {
				respond(response, 200, { status: "main" });
			} else {
				await this.notMain(response);
			}

			return;
		}

		if (path.startsWith("/xrpc/") && this.deps.app) {
			await this.forwardWrite(request, response, this.deps.app);

			return;
		}

		const known =
			(request.method === "POST" && path === JOIN_PATH) ||
			(request.method === "GET" && path === CONFIG_PATH);

		if (!known) {
			respond(response, 404, { error: "NotFound" });

			return;
		}

		if (!this.deps.isMain()) {
			await this.notMain(response);

			return;
		}

		if (path === CONFIG_PATH) {
			await this.serveConfig(request, response);

			return;
		}

		const parsed = parseFrame(joinRequestSchema, await readBody(request));

		if (!parsed) {
			respond(response, 400, { error: "InvalidRequest" });

			return;
		}

		const { token, ...address } = parsed;
		const joined = await this.deps.registry.redeem(token, address);

		if (!joined) {
			this.deps.log.warn({ publicUrl: address.publicUrl }, "cluster.joinRejected");
			respond(response, 401, { error: "InvalidJoinToken" });

			return;
		}

		this.deps.log.info({ node: joined.id }, "cluster.joined");
		respond(response, 200, joined);
	}

	private async notMain(response: ServerResponse): Promise<void> {
		const main = await this.deps.registry.mainNode().catch(() => null);

		respond(response, 503, {
			error: "NotMain",
			main: main && main.id !== this.deps.nodeId ? main.tailnetUrl : null,
		});
	}

	private async trusted(request: IncomingMessage): Promise<boolean> {
		const nodeId = headerOf(request, NODE_ID_HEADER);
		const secret = headerOf(request, NODE_SECRET_HEADER);

		if (!nodeId || !secret) {
			return false;
		}

		const key = `${nodeId}:${secret}`;

		if ((this.verified.get(key) ?? 0) > Date.now()) {
			return true;
		}

		if (!(await this.deps.registry.verify(nodeId, secret))) {
			return false;
		}

		this.verified.set(key, Date.now() + VERIFIED_TTL_MS);

		return true;
	}

	private async forwardWrite(
		request: IncomingMessage,
		response: ServerResponse,
		app: (request: IncomingMessage, response: ServerResponse) => void,
	): Promise<void> {
		if (!(await this.trusted(request))) {
			respond(response, 401, { error: "Unauthorized" });

			return;
		}

		if (!this.deps.isMain()) {
			await this.notMain(response);

			return;
		}

		delete request.headers[NODE_SECRET_HEADER];
		app(request, response);
	}

	private async serveConfig(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const nodeId = headerOf(request, NODE_ID_HEADER);
		const secret = headerOf(request, NODE_SECRET_HEADER);

		if (!nodeId || !secret || !(await this.deps.registry.verify(nodeId, secret))) {
			respond(response, 401, { error: "Unauthorized" });

			return;
		}

		const node = await this.deps.registry.node(nodeId);
		const shared = (await this.deps.config?.(nodeId)) ?? {};

		respond(response, 200, {
			values: {
				...shared,
				...(node
					? { NODE_ID: node.id, NODE_REGION: node.region, ROLES: node.roles.join(",") }
					: {}),
			},
		});
	}

	private async upgrade(request: IncomingMessage): Promise<string | null> {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		const nodeId = headerOf(request, NODE_ID_HEADER);
		const secret = headerOf(request, NODE_SECRET_HEADER);

		if (path !== CONTROL_PATH || !this.deps.isMain() || !nodeId || !secret) {
			return null;
		}

		return (await this.deps.registry.verify(nodeId, secret)) ? nodeId : null;
	}

	private accept(nodeId: string, socket: WebSocket): void {
		const previous = this.links.get(nodeId);

		previous?.socket.close(4000, "replaced");

		const link: Link = { socket, alive: true };

		this.links.set(nodeId, link);
		this.deps.log.info({ node: nodeId }, "cluster.linked");

		socket.send(
			JSON.stringify({
				t: "welcome",
				mainNodeId: this.deps.nodeId,
			} satisfies MainFrame),
		);

		socket.on("pong", () => {
			link.alive = true;
		});

		socket.on("message", (raw) => {
			const frame = parseFrame(nodeFrameSchema, raw.toString());

			if (frame) {
				this.deps.onFrame?.(nodeId, frame);
			}
		});

		socket.on("close", () => {
			if (this.links.get(nodeId) === link) {
				this.links.delete(nodeId);
				this.deps.log.info({ node: nodeId }, "cluster.unlinked");
			}
		});

		socket.on("error", () => socket.close());
	}

	private reap(): void {
		for (const link of this.links.values()) {
			if (!link.alive) {
				link.socket.terminate();
				continue;
			}

			link.alive = false;
			link.socket.ping();
		}
	}
}
