import type { Server as HttpServer, IncomingHttpHeaders } from "node:http";
import { canRead } from "@colibri-social/community";
import { ServiceAuthError } from "@colibri-social/identity";
import { social } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import { type WebSocket, WebSocketServer } from "ws";
import { channelEvent, communityEvent } from "../announce.js";
import type { AppContext } from "../context.js";
import { isOnlineState, PresenceTracker } from "../presence.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import { bearerToken, selectSubprotocol } from "./auth.js";
import { channelTopic, communityTopic, type Topic, TopicIndex, userTopic } from "./topics.js";

export type ServerFrame = { $type: string } & Record<string, unknown>;

export type FrameForViewer = (did: string) => ServerFrame;

export type ChannelFrame = ServerFrame | FrameForViewer;

const EVENTS_PATH = "/xrpc/social.colibri.beta.sync.subscribeEvents";
const HEARTBEAT_MS = 30_000;
const HINT_BUDGET = 20;
const HINT_WINDOW_MS = 10_000;

type HintBudget = {
	count: number;
	windowStartedAt: number;
};

type Connection = {
	socket: WebSocket;
	did: string;
	alive: boolean;
	hints: HintBudget;
};

const clientFrames = {
	subscribe: social.colibri.beta.sync.defs.subscribe,
	unsubscribe: social.colibri.beta.sync.defs.unsubscribe,
	heartbeat: social.colibri.beta.sync.defs.heartbeat,
	typing: social.colibri.beta.sync.defs.typing,
	viewChannel: social.colibri.beta.sync.defs.viewChannel,
	wroteTo: social.colibri.beta.sync.defs.wroteTo,
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
	private readonly communities: CommunityViews;
	private readonly stopWatchingAuthz: () => void;
	private heartbeat: NodeJS.Timeout | null = null;

	constructor(private readonly ctx: AppContext) {
		this.presence = new PresenceTracker({
			ctx,
			publish: (did, communities, frame) =>
				this.publishTo([userTopic(did), ...communities.map(communityTopic)], frame),
		});
		this.communities = new CommunityViews(ctx, new ActorViews(ctx));
		this.stopWatchingAuthz = ctx.authzChanges.subscribe((change) => {
			void this.revalidate(change.community).catch((error: unknown) => {
				ctx.log.warn(
					{ community: change.community, reason: error instanceof Error ? error.message : error },
					"events.revalidate.failed",
				);
			});
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
		this.stopWatchingAuthz();
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
		const connection: Connection = {
			socket,
			did,
			alive: true,
			hints: { count: 0, windowStartedAt: 0 },
		};
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
			case "typing":
				this.applyTyping(connection, result.value as never);
				return;
			case "viewChannel":
				await this.applyViewChannel(connection, result.value as never);
				return;
			case "wroteTo":
				this.applyWroteTo(connection, result.value as never);
				return;
			default:
				return;
		}
	}

	private async trackPresence(
		did: string,
		transition: "opened" | "closed" | "requested" | "viewing",
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

	private applyTyping(connection: Connection, frame: { channel: string }): void {
		if (!this.topics.topicsOf(connection).includes(channelTopic(frame.channel))) return;
		this.publishToChannel(
			frame.channel,
			{
				$type: "social.colibri.beta.sync.defs#typingEvent",
				did: connection.did,
				channel: frame.channel,
			},
			connection.did,
		);
	}

	private authorityOf(space: string): string | null {
		try {
			return parseSpaceRef(space).authority;
		} catch {
			return null;
		}
	}

	private mayHint(connection: Connection, space: string): boolean {
		if (this.topics.topicsOf(connection).includes(channelTopic(space))) return true;
		return this.authorityOf(space) === connection.did;
	}

	private withinHintBudget(connection: Connection, now: number): boolean {
		const budget = connection.hints;
		if (now - budget.windowStartedAt >= HINT_WINDOW_MS) {
			budget.windowStartedAt = now;
			budget.count = 0;
		}
		budget.count += 1;
		return budget.count <= HINT_BUDGET;
	}

	private applyWroteTo(connection: Connection, frame: { space: string; rev?: string }): void {
		const notifiedAt = Date.now();
		if (!this.mayHint(connection, frame.space)) return;
		if (!this.withinHintBudget(connection, notifiedAt)) {
			this.error(connection, "RateLimited", "too many write hints, slow down");
			return;
		}

		this.ctx.sync.notifyWrite(frame.space, connection.did, {
			trigger: "clientHint",
			notifiedAt,
			...(frame.rev ? { rev: frame.rev } : {}),
		});
	}

	private async applyViewChannel(
		connection: Connection,
		frame: { channel?: string },
	): Promise<void> {
		await this.trackPresence(connection.did, "viewing", () =>
			this.presence.viewing(connection.did, frame.channel ?? null),
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
				for (const space of this.channelsHeldIn(connection, community)) {
					topics.push(channelTopic(space));
				}
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
				for (const space of await this.communities.readableChannels(community, authz)) {
					topics.push(channelTopic(space));
					channels.push(space);
				}
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

		this.confirmSubscription(connection);
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

	private channelsHeldIn(connection: Connection, community: string): string[] {
		return this.subscribedChannels(connection).filter(
			(space) => this.authorityOf(space) === community,
		);
	}

	private confirmSubscription(connection: Connection): void {
		this.send(connection, {
			$type: "social.colibri.beta.sync.defs#subscribed",
			communities: this.subscribedCommunities(connection),
			channels: this.subscribedChannels(connection),
		});
	}

	async revalidate(community: string): Promise<void> {
		const affected = [...this.topics.subscribersOf(communityTopic(community))];
		if (affected.length === 0) return;

		for (const connection of affected) {
			const authz = await this.ctx.loader.authz(community, connection.did);
			const readable =
				authz.member || authz.isOwner
					? await this.communities.readableChannels(community, authz)
					: [];
			const wanted = new Set(readable);
			const held = new Set(this.channelsHeldIn(connection, community));

			const gained = readable.filter((space) => !held.has(space));
			const lost = [...held].filter((space) => !wanted.has(space));
			if (gained.length === 0 && lost.length === 0) continue;

			for (const space of lost) {
				this.send(connection, channelEvent("delete", community, space));
			}
			this.topics.unsubscribe(connection, lost.map(channelTopic));
			this.topics.subscribe(connection, gained.map(channelTopic));
			for (const space of gained) {
				this.send(connection, channelEvent("create", community, space));
			}
			this.confirmSubscription(connection);
		}
	}

	channelChanged(community: string, space: string, event: "update" | "delete"): void {
		this.publishToChannel(space, channelEvent(event, community, space));
		if (event !== "delete") return;
		for (const connection of [...this.topics.subscribersOf(channelTopic(space))]) {
			this.topics.unsubscribe(connection, [channelTopic(space)]);
			this.confirmSubscription(connection);
		}
	}

	communityDeleted(community: string): void {
		const frame = communityEvent("delete", community);
		const topic = communityTopic(community);

		for (const connection of [...this.connections]) {
			const channels = this.channelsHeldIn(connection, community);
			const held = this.topics.topicsOf(connection).includes(topic);
			if (!held && channels.length === 0) continue;

			this.send(connection, frame);
			this.topics.unsubscribe(connection, [topic, ...channels.map(channelTopic)]);
			this.confirmSubscription(connection);
		}
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

	publishToChannel(space: string, frame: ChannelFrame, except?: string): void {
		const shared = typeof frame === "function" ? null : JSON.stringify(frame);
		for (const connection of this.topics.subscribersOf(channelTopic(space))) {
			if (except !== undefined && connection.did === except) continue;
			if (connection.socket.readyState !== connection.socket.OPEN) continue;
			connection.socket.send(shared ?? JSON.stringify((frame as FrameForViewer)(connection.did)));
		}
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
