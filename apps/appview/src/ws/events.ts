import type { Server as HttpServer, IncomingHttpHeaders } from "node:http";
import { canRead } from "@colibri-social/community";
import { ServiceAuthError } from "@colibri-social/identity";
import { social } from "@colibri-social/lexicons";
import { type WebSocket, WebSocketServer } from "ws";
import type { AppContext } from "../context.js";
import { isOnlineState, PresenceTracker } from "../presence.js";
import { bearerToken, selectSubprotocol } from "./auth.js";
import { channelTopic, communityTopic, type Topic, TopicIndex, userTopic } from "./topics.js";

export type ServerFrame = { $type: string } & Record<string, unknown>;

const EVENTS_PATH = "/xrpc/social.colibri.beta.sync.subscribeEvents";
const HEARTBEAT_MS = 30_000;

type Connection = {
	socket: WebSocket;
	did: string;
	alive: boolean;
};

const clientFrames = {
	subscribe: social.colibri.beta.sync.defs.subscribe,
	unsubscribe: social.colibri.beta.sync.defs.unsubscribe,
	heartbeat: social.colibri.beta.sync.defs.heartbeat,
	typing: social.colibri.beta.sync.defs.typing,
	viewChannel: social.colibri.beta.sync.defs.viewChannel,
	setPresence: social.colibri.beta.sync.defs.setPresence,
} as const;

type ClientFrameName = keyof typeof clientFrames;

const frameName = (value: unknown): ClientFrameName | null => {
	if (!value || typeof value !== "object") return null;
	const type = (value as { $type?: unknown }).$type;
	if (typeof type !== "string") return null;
	const suffix = type.startsWith("social.colibri.beta.sync.defs#")
		? type.slice(type.indexOf("#") + 1)
		: null;
	return suffix && suffix in clientFrames ? (suffix as ClientFrameName) : null;
};

export class EventServer {
	private readonly wss = new WebSocketServer({
		noServer: true,
		handleProtocols: (protocols) => selectSubprotocol(protocols),
	});
	private readonly topics = new TopicIndex<Connection>();
	private readonly connections = new Set<Connection>();
	private readonly presence: PresenceTracker;
	private heartbeat: NodeJS.Timeout | null = null;

	constructor(private readonly ctx: AppContext) {
		this.presence = new PresenceTracker({
			ctx,
			publish: (did, communities, frame) =>
				this.publishTo([userTopic(did), ...communities.map(communityTopic)], frame),
		});
	}

	get connectionCount(): number {
		return this.connections.size;
	}

	attach(http: HttpServer): void {
		http.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.pathname !== EVENTS_PATH) return;

			void this.authenticate(request.headers, url).then((did) => {
				if (!did) {
					socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
					socket.destroy();
					return;
				}
				this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, did));
			});
		});

		this.heartbeat = setInterval(() => this.reap(), HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	async close(): Promise<void> {
		if (this.heartbeat) clearInterval(this.heartbeat);
		for (const connection of this.connections) connection.socket.close(1001, "shutting down");
		this.connections.clear();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
	}

	private async authenticate(headers: IncomingHttpHeaders, url: URL): Promise<string | null> {
		const token = bearerToken(headers, url);
		if (!token) return null;
		const caller = await this.ctx.serviceAuth
			.verify(token, "social.colibri.beta.sync.subscribeEvents")
			.catch((error: unknown) => {
				this.ctx.log.warn(
					{
						failure: error instanceof ServiceAuthError ? error.failure : "unknown",
						reason: error instanceof Error ? error.message : String(error),
					},
					"ws.auth.rejected",
				);
				return null;
			});
		return caller?.did ?? null;
	}

	private accept(socket: WebSocket, did: string): void {
		const connection: Connection = { socket, did, alive: true };
		this.connections.add(connection);
		this.topics.subscribe(connection, [userTopic(did)]);
		void this.trackPresence(did, "opened", () => this.presence.opened(did));

		socket.on("pong", () => {
			connection.alive = true;
		});
		socket.on("message", (raw) => void this.receive(connection, raw.toString()));
		socket.on("close", () => {
			this.topics.forget(connection);
			this.connections.delete(connection);
			void this.trackPresence(did, "closed", () => this.presence.closed(did));
		});
		socket.on("error", () => socket.close());
	}

	private send(connection: Connection, frame: ServerFrame): void {
		if (connection.socket.readyState !== connection.socket.OPEN) return;
		connection.socket.send(JSON.stringify(frame));
	}

	private error(connection: Connection, error: string, message: string): void {
		this.send(connection, {
			$type: "social.colibri.beta.sync.defs#error",
			error,
			message,
		});
	}

	private async receive(connection: Connection, raw: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			this.error(connection, "InvalidFrame", "frames must be JSON");
			return;
		}

		const name = frameName(parsed);
		if (!name) {
			this.error(connection, "InvalidFrame", "unrecognised frame type");
			return;
		}

		const result = clientFrames[name].safeParse(parsed);
		if (!result.success) {
			this.error(connection, "InvalidFrame", result.message ?? "frame does not match its lexicon");
			return;
		}

		switch (name) {
			case "heartbeat":
				this.send(connection, { $type: "social.colibri.beta.sync.defs#ack" });
				return;
			case "subscribe":
				await this.applySubscription(connection, result.value as never, "subscribe");
				return;
			case "unsubscribe":
				await this.applySubscription(connection, result.value as never, "unsubscribe");
				return;
			case "setPresence":
				await this.applyPresence(connection, result.value as never);
				return;
			default:
				return;
		}
	}

	private async trackPresence(
		did: string,
		transition: "opened" | "closed" | "requested",
		work: () => Promise<void>,
	): Promise<void> {
		await work().catch((error: unknown) => {
			this.ctx.log.warn(
				{ did, transition, reason: error instanceof Error ? error.message : String(error) },
				"presence.failed",
			);
		});
	}

	private async applyPresence(
		connection: Connection,
		frame: { onlineState?: string },
	): Promise<void> {
		const requested = frame.onlineState;
		if (requested === undefined) return;
		if (!isOnlineState(requested)) {
			this.error(connection, "InvalidFrame", `unknown online state '${requested}'`);
			return;
		}
		await this.trackPresence(connection.did, "requested", () =>
			this.presence.requested(connection.did, requested),
		);
	}

	private async applySubscription(
		connection: Connection,
		frame: { communities?: string[]; channels?: string[] },
		mode: "subscribe" | "unsubscribe",
	): Promise<void> {
		const topics: Topic[] = [];
		const communities: string[] = [];
		const channels: string[] = [];

		if (mode === "unsubscribe") {
			for (const community of frame.communities ?? []) {
				topics.push(communityTopic(community));
				communities.push(community);
			}
			for (const channel of frame.channels ?? []) {
				topics.push(channelTopic(channel));
				channels.push(channel);
			}
			this.topics.unsubscribe(connection, topics);
		} else {
			for (const community of frame.communities ?? []) {
				const authz = await this.ctx.loader.authz(community, connection.did);
				if (!authz.member && !authz.isOwner) continue;
				topics.push(communityTopic(community));
				communities.push(community);
			}
			for (const channel of frame.channels ?? []) {
				const state = await this.ctx.loader.channel(channel);
				if (!state) continue;
				const community = channel.slice("at://".length).split("/")[0] as string;
				const authz = await this.ctx.loader.authz(community, connection.did);
				if (!canRead(authz, state)) continue;
				topics.push(channelTopic(channel));
				channels.push(channel);
			}
			this.topics.subscribe(connection, topics);
		}

		this.send(connection, {
			$type: "social.colibri.beta.sync.defs#subscribed",
			communities: this.subscribedCommunities(connection),
			channels: this.subscribedChannels(connection),
		});
	}

	private subscribedCommunities(connection: Connection): string[] {
		return this.topics
			.topicsOf(connection)
			.filter((topic) => topic.startsWith("community:"))
			.map((topic) => topic.slice("community:".length));
	}

	private subscribedChannels(connection: Connection): string[] {
		return this.topics
			.topicsOf(connection)
			.filter((topic) => topic.startsWith("channel:"))
			.map((topic) => topic.slice("channel:".length));
	}

	publishTo(topics: readonly Topic[], frame: ServerFrame): void {
		const payload = JSON.stringify(frame);
		const seen = new Set<Connection>();
		for (const topic of topics) {
			for (const connection of this.topics.subscribersOf(topic)) {
				if (seen.has(connection)) continue;
				seen.add(connection);
				if (connection.socket.readyState === connection.socket.OPEN) {
					connection.socket.send(payload);
				}
			}
		}
	}

	publish(topic: Topic, frame: ServerFrame): void {
		const payload = JSON.stringify(frame);
		for (const connection of this.topics.subscribersOf(topic)) {
			if (connection.socket.readyState === connection.socket.OPEN) connection.socket.send(payload);
		}
	}

	publishToCommunity(community: string, frame: ServerFrame): void {
		this.publish(communityTopic(community), frame);
	}

	publishToChannel(space: string, frame: ServerFrame): void {
		this.publish(channelTopic(space), frame);
	}

	publishToUser(did: string, frame: ServerFrame): void {
		this.publish(userTopic(did), frame);
	}

	private reap(): void {
		for (const connection of this.connections) {
			if (!connection.alive) {
				connection.socket.terminate();
				continue;
			}
			connection.alive = false;
			connection.socket.ping();
		}
	}
}
