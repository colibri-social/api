import type { IncomingMessage, ServerResponse } from "node:http";
import type { WriteMode } from "@colibri-social/appview-db";
import type { Logger } from "../logger.js";
import { NODE_ID_HEADER, NODE_SECRET_HEADER, notMainSchema } from "./protocol.js";

export const MAX_WRITE_BYTES = 21 * 1024 * 1024;

export const RESPONSE_TIMEOUT_MS = 60_000;

export const RETRY_MS = 1_000;

export const PROBE_MS = 5_000;

export const PING_PATH = "/cluster/ping";

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
	"ECONNREFUSED",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
]);

const HOP_BY_HOP: ReadonlySet<string> = new Set([
	"host",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"content-length",
	"upgrade",
	"proxy-connection",
	NODE_ID_HEADER,
	NODE_SECRET_HEADER,
]);

const PASSED_BACK = ["content-type", "cache-control", "ratelimit-limit", "ratelimit-remaining"];

export type WriteProxyDeps = {
	nodeId: string;
	secret: string;
	windowMs: number;
	mainUrl: () => Promise<string | null>;
	log: Pick<Logger, "info" | "warn">;
	onMode: (mode: WriteMode) => void;
	forwarding?: () => boolean;
	fetch?: typeof fetch;
	now?: () => number;
	retryMs?: number;
	probeMs?: number;
};

type Forward = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: Buffer;
};

type Answer = {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
};

type Held = {
	forward: Forward;
	deadline: number;
	settle: (answer: Answer) => void;
};

class Unreachable extends Error {}

const errorCode = (error: unknown): string | null => {
	const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
	const code = cause?.code ?? (error as { code?: unknown } | null)?.code;

	return typeof code === "string" ? code : null;
};

const jsonAnswer = (status: number, error: string, message: string): Answer => {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: Buffer.from(JSON.stringify({ error, message })),
	};
};

const parseJson = (body: Buffer): unknown => {
	try {
		return JSON.parse(body.toString("utf8"));
	} catch {
		return null;
	}
};

export const readOnlyAnswer = (): Answer => {
	return jsonAnswer(
		503,
		"ReadOnly",
		"Colibri can't save changes right now. They'll go through once the network is back.",
	);
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of request) {
		size += (chunk as Buffer).length;

		if (size > MAX_WRITE_BYTES) {
			throw new Error("request body too large");
		}

		chunks.push(chunk as Buffer);
	}

	return Buffer.concat(chunks);
};

const forwardedHeaders = (request: IncomingMessage): Record<string, string> => {
	const headers: Record<string, string> = {};

	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined || HOP_BY_HOP.has(name)) continue;

		headers[name] = Array.isArray(value) ? value.join(", ") : value;
	}

	return headers;
};

export const isWrite = (request: IncomingMessage): boolean => {
	return request.method === "POST" && (request.url ?? "").startsWith("/xrpc/");
};

export class WriteProxy {
	private readonly queue: Held[] = [];
	private readonly request: typeof fetch;
	private readonly now: () => number;
	private current: WriteMode = "normal";
	private draining = false;
	private probe: ReturnType<typeof setInterval> | null = null;
	private target: string | null = null;

	constructor(private readonly deps: WriteProxyDeps) {
		this.request = deps.fetch ?? fetch;
		this.now = deps.now ?? Date.now;
	}

	get mode(): WriteMode {
		return this.current;
	}

	get waiting(): number {
		return this.queue.length;
	}

	get forwarding(): boolean {
		return this.deps.forwarding?.() ?? true;
	}

	async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const arrived = this.now();
		const answer = await readBody(request).then(
			(body) =>
				this.submit(
					{ method: "POST", path: request.url ?? "/", headers: forwardedHeaders(request), body },
					arrived,
				).catch((error: unknown) => {
					this.deps.log.warn({ err: error }, "writes.forwardFailed");

					return jsonAnswer(502, "UpstreamFailure", "the main node did not answer");
				}),
			() => jsonAnswer(413, "PayloadTooLarge", "the request body is too large"),
		);

		response.writeHead(answer.status, answer.headers);
		response.end(answer.body);
	}

	stop(): void {
		if (this.probe) clearInterval(this.probe);
		this.probe = null;

		for (const held of this.queue.splice(0)) {
			held.settle(readOnlyAnswer());
		}
	}

	private submit(forward: Forward, arrived: number): Promise<Answer> {
		if (this.current === "readOnly") {
			return Promise.resolve(readOnlyAnswer());
		}

		if (this.current === "queued") {
			return this.hold(forward, arrived);
		}

		return this.send(forward).catch((error: unknown) => {
			if (error instanceof Unreachable) {
				this.deps.log.warn({ reason: error.message }, "writes.mainUnreachable");
				this.setMode("queued");

				return this.hold(forward, arrived);
			}

			throw error;
		});
	}

	private hold(forward: Forward, arrived: number): Promise<Answer> {
		return new Promise((settle) => {
			this.queue.push({ forward, deadline: arrived + this.deps.windowMs, settle });
			void this.drain();
		});
	}

	private async drain(): Promise<void> {
		if (this.draining) {
			return;
		}

		this.draining = true;

		try {
			while (this.queue.length > 0) {
				this.expire();

				const head = this.queue[0];

				if (!head) {
					break;
				}

				try {
					const answer = await this.send(head.forward);

					this.queue.shift();
					head.settle(answer);
				} catch (error) {
					if (!(error instanceof Unreachable)) {
						this.queue.shift();
						head.settle(jsonAnswer(502, "UpstreamFailure", "the main node did not answer"));
						continue;
					}

					await new Promise((resolve) => setTimeout(resolve, this.deps.retryMs ?? RETRY_MS));
				}
			}

			if (this.current === "queued") {
				this.setMode("normal");
			}
		} finally {
			this.draining = false;
		}
	}

	private expire(): void {
		const now = this.now();
		let expired = 0;

		while (this.queue.length > 0 && (this.queue[0]?.deadline ?? Number.POSITIVE_INFINITY) <= now) {
			this.queue.shift()?.settle(readOnlyAnswer());
			expired += 1;
		}

		if (expired === 0) {
			return;
		}

		this.setMode("readOnly");

		for (const held of this.queue.splice(0)) {
			held.settle(readOnlyAnswer());
		}

		this.startProbe();
	}

	private startProbe(): void {
		if (this.probe) {
			return;
		}

		this.probe = setInterval(() => {
			void this.ping().then((up) => {
				if (up && this.current === "readOnly") {
					this.deps.log.info("writes.mainBack");
					this.setMode("normal");

					if (this.probe) clearInterval(this.probe);
					this.probe = null;
				}
			});
		}, this.deps.probeMs ?? PROBE_MS);
		this.probe.unref?.();
	}

	private async ping(): Promise<boolean> {
		try {
			const base = await this.base();
			const response = await this.request(new URL(PING_PATH, base), {
				signal: AbortSignal.timeout(3_000),
			});

			return response.ok;
		} catch {
			this.target = null;

			return false;
		}
	}

	private async base(): Promise<string> {
		const base = this.target ?? (await this.deps.mainUrl());

		if (!base) {
			throw new Unreachable("no main node is known");
		}

		this.target = base;

		return base;
	}

	private async send(forward: Forward): Promise<Answer> {
		const base = await this.base();
		let response: Response;

		try {
			response = await this.request(new URL(forward.path, base), {
				method: forward.method,
				headers: {
					...forward.headers,
					[NODE_ID_HEADER]: this.deps.nodeId,
					[NODE_SECRET_HEADER]: this.deps.secret,
				},
				body: new Uint8Array(forward.body),
				signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
			});
		} catch (error) {
			const code = errorCode(error);

			if (code && RETRYABLE_CODES.has(code)) {
				this.target = null;

				throw new Unreachable(code);
			}

			throw error;
		}

		const body = Buffer.from(await response.arrayBuffer());

		if (response.status === 503) {
			const notMain = notMainSchema.safeParse(parseJson(body));

			if (notMain.success) {
				this.target = notMain.data.main;

				throw new Unreachable("NotMain");
			}
		}

		const headers: Record<string, string> = {};

		for (const name of PASSED_BACK) {
			const value = response.headers.get(name);

			if (value) headers[name] = value;
		}

		return { status: response.status, headers, body };
	}

	private setMode(mode: WriteMode): void {
		if (this.current === mode) {
			return;
		}

		this.current = mode;
		this.deps.log.info({ mode, waiting: this.queue.length }, "writes.mode");
		this.deps.onMode(mode);
	}
}
