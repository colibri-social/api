import type { Server as HttpServer, IncomingHttpHeaders } from "node:http";
import { type ActorAuthz, type ChannelState, canPost } from "@colibri-social/community";
import { ServiceAuthError } from "@colibri-social/identity";
import { asDid, asSpaceRef, SPACE_TYPES, social } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import type { VoiceSfu } from "@colibri-social/voice";
import { type WebSocket, WebSocketServer } from "ws";
import type { AppContext } from "../context.js";
import { voiceStateIn } from "../views/voice-state.js";
import { bearerToken, selectSubprotocol } from "./auth.js";
import type { EventServer, ServerFrame } from "./events.js";
import { channelTopic, TopicIndex } from "./topics.js";

const VOICE_PATH = "/xrpc/social.colibri.beta.voice.subscribeSignals";
const HEARTBEAT_MS = 30_000;

type Connection = {
	socket: WebSocket;
	did: string;
	channel: string | null;
	alive: boolean;
	queue: Promise<void>;
};

const clientFrames = {
	join: social.colibri.beta.voice.defs.join,
	leave: social.colibri.beta.voice.defs.leave,
	getRtpCapabilities: social.colibri.beta.voice.defs.getRtpCapabilities,
	createTransport: social.colibri.beta.voice.defs.createTransport,
	connectTransport: social.colibri.beta.voice.defs.connectTransport,
	produce: social.colibri.beta.voice.defs.produce,
	closeProducer: social.colibri.beta.voice.defs.closeProducer,
	consume: social.colibri.beta.voice.defs.consume,
	resumeConsumer: social.colibri.beta.voice.defs.resumeConsumer,
	setSelfState: social.colibri.beta.voice.defs.setSelfState,
	heartbeat: social.colibri.beta.voice.defs.heartbeat,
} as const;

type ClientFrameName = keyof typeof clientFrames;

export type VoiceRoster = {
	isJoined: (channel: string, did: string) => boolean;
	disconnect: (channel: string, did: string) => Promise<void>;
};

const frameName = (value: unknown): ClientFrameName | null => {
	if (!value || typeof value !== "object") return null;
	const type = (value as { $type?: unknown }).$type;
	if (typeof type !== "string") return null;
	const suffix = type.startsWith("social.colibri.beta.voice.defs#")
		? type.slice(type.indexOf("#") + 1)
		: null;
	return suffix && suffix in clientFrames ? (suffix as ClientFrameName) : null;
};

const toInternalSource = (source: string): string => (source === "microphone" ? "mic" : source);
const toWireSource = (source: string): string => (source === "mic" ? "microphone" : source);

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : "the sfu rejected this request";

export class VoiceServer {
	private readonly wss = new WebSocketServer({
		noServer: true,
		handleProtocols: (protocols) => selectSubprotocol(protocols),
	});
	private readonly topics = new TopicIndex<Connection>();
	private readonly connections = new Set<Connection>();
	private heartbeat: NodeJS.Timeout | null = null;
	private readonly stopWatchingAuthz: () => void;

	constructor(
		private readonly ctx: AppContext,
		private readonly events: EventServer | null = null,
	) {
		if (ctx.voice) this.wireVoiceEvents(ctx.voice);
		this.stopWatchingAuthz = ctx.authzChanges.subscribe((change) => {
			void this.revalidate(change.community).catch((error: unknown) => {
				ctx.log.warn(
					{ community: change.community, reason: error instanceof Error ? error.message : error },
					"voice.revalidate.failed",
				);
			});
		});
	}

	get connectionCount(): number {
		return this.connections.size;
	}

	isJoined(channel: string, did: string): boolean {
		return this.joined(channel, did).length > 0;
	}

	async disconnect(channel: string, did: string): Promise<void> {
		for (const connection of this.joined(channel, did)) this.detach(connection, "moderator");
		await this.ctx.voice?.leave(channel, did);
	}

	async revalidate(community: string): Promise<void> {
		const affected = [...this.connections].filter(
			(connection) =>
				connection.channel && parseSpaceRef(connection.channel).authority === community,
		);
		if (affected.length === 0) return;

		const channels = new Map<string, ChannelState | null>();
		const rights = new Map<string, ActorAuthz>();

		for (const connection of affected) {
			const space = connection.channel;
			if (!space) continue;

			if (!channels.has(space)) channels.set(space, await this.ctx.loader.channel(space));
			const channel = channels.get(space) ?? null;

			if (!rights.has(connection.did)) {
				rights.set(connection.did, await this.ctx.loader.authz(community, connection.did));
			}
			const authz = rights.get(connection.did);

			if (channel && authz && canPost(authz, channel)) continue;

			this.detach(connection, channel ? "forbidden" : "channelGone");
			await this.ctx.voice?.leave(space, connection.did);
		}
	}

	attach(http: HttpServer): void {
		http.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.pathname !== VOICE_PATH) return;

			if (!this.ctx.voice) {
				socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
				socket.destroy();
				return;
			}

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
		for (const connection of this.connections) {
			this.topics.forget(connection);
			connection.socket.close(1001, "shutting down");
		}
		this.connections.clear();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
	}

	private async authenticate(headers: IncomingHttpHeaders, url: URL): Promise<string | null> {
		const token = bearerToken(headers, url);
		if (!token) return null;
		const caller = await this.ctx.serviceAuth
			.verify(token, "social.colibri.beta.voice.subscribeSignals")
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
			channel: null,
			alive: true,
			queue: Promise.resolve(),
		};
		this.connections.add(connection);

		socket.on("pong", () => {
			connection.alive = true;
		});
		socket.on("message", (raw) => this.enqueue(connection, raw.toString()));
		socket.on("close", () => this.dropped(connection));
		socket.on("error", () => socket.close());
	}

	private enqueue(connection: Connection, raw: string): void {
		connection.alive = true;
		connection.queue = connection.queue.then(() =>
			this.receive(connection, raw).catch((cause: unknown) => {
				this.ctx.log.error({ did: connection.did, reason: messageOf(cause) }, "voice.frame.failed");
				this.error(connection, "InternalServerError", messageOf(cause));
			}),
		);
	}

	private dropped(connection: Connection): void {
		this.connections.delete(connection);
		const channel = this.forgetChannel(connection);
		this.topics.forget(connection);
		if (channel) void this.ctx.voice?.leave(channel, connection.did);
	}

	private forgetChannel(connection: Connection): string | null {
		const channel = connection.channel;
		connection.channel = null;
		this.topics.unsubscribe(connection, this.topics.topicsOf(connection));
		return channel;
	}

	private joined(channel: string, did: string): Connection[] {
		return [...this.topics.subscribersOf(channelTopic(channel))].filter(
			(connection) => connection.did === did,
		);
	}

	private detach(connection: Connection, reason: string): void {
		this.send(connection, {
			$type: "social.colibri.beta.voice.defs#disconnected",
			reason,
		});
		this.forgetChannel(connection);
	}

	private send(connection: Connection, frame: ServerFrame): void {
		if (connection.socket.readyState !== connection.socket.OPEN) return;
		connection.socket.send(JSON.stringify(frame));
	}

	private error(connection: Connection, error: string, message: string): void {
		this.send(connection, {
			$type: "social.colibri.beta.voice.defs#error",
			error,
			message,
		});
	}

	private tell(channel: string, did: string, frame: ServerFrame): void {
		for (const connection of [...this.topics.subscribersOf(channelTopic(channel))]) {
			if (connection.did !== did) continue;
			this.send(connection, frame);
			this.forgetChannel(connection);
		}
	}

	private broadcast(channel: string, frame: ServerFrame, exclude?: string): void {
		for (const connection of this.topics.subscribersOf(channelTopic(channel))) {
			if (exclude && connection.did === exclude) continue;
			this.send(connection, frame);
		}
	}

	private async receive(connection: Connection, raw: string): Promise<void> {
		const voice = this.ctx.voice;
		if (!voice) return;

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

		if (name !== "join" && !connection.channel) {
			this.error(connection, "NotJoined", "join a channel before sending this frame");
			return;
		}

		switch (name) {
			case "join":
				await this.handleJoin(connection, voice, result.value as never);
				return;
			case "leave":
				await this.handleLeave(connection, voice);
				return;
			case "heartbeat":
				this.send(connection, { $type: "social.colibri.beta.voice.defs#ack" });
				return;
			case "getRtpCapabilities":
				await this.handleGetRtpCapabilities(connection, voice);
				return;
			case "createTransport":
				await this.handleCreateTransport(connection, voice, result.value as never);
				return;
			case "connectTransport":
				await this.handleConnectTransport(connection, voice, result.value as never);
				return;
			case "produce":
				await this.handleProduce(connection, voice, result.value as never);
				return;
			case "closeProducer":
				this.handleCloseProducer(connection, voice, result.value as never);
				return;
			case "consume":
				await this.handleConsume(connection, voice, result.value as never);
				return;
			case "resumeConsumer":
				await this.handleResumeConsumer(connection, voice, result.value as never);
				return;
			case "setSelfState":
				await this.handleSetSelfState(connection, voice, result.value as never);
				return;
			default:
				return;
		}
	}

	private async handleJoin(
		connection: Connection,
		voice: VoiceSfu,
		frame: { channel: string },
	): Promise<void> {
		const state = await this.ctx.loader.channel(frame.channel);
		if (!state) {
			this.error(connection, "ChannelNotFound", `no channel matches ${frame.channel}`);
			return;
		}

		const parsed = parseSpaceRef(frame.channel);
		if (parsed.spaceType !== SPACE_TYPES.channelVoice) {
			this.error(connection, "NotVoiceChannel", `${frame.channel} is not a voice channel`);
			return;
		}

		const authz = await this.ctx.loader.authz(parsed.authority, connection.did);
		if (!canPost(authz, state)) {
			this.error(connection, "Forbidden", "you cannot speak in this channel");
			return;
		}

		await this.supersedeOtherSessions(connection, voice, frame.channel);

		const previous = this.forgetChannel(connection);
		if (previous) await voice.leave(previous, connection.did);

		connection.channel = frame.channel;
		this.topics.subscribe(connection, [channelTopic(frame.channel)]);
		await voice.join(frame.channel, connection.did);
		this.send(connection, {
			$type: "social.colibri.beta.voice.defs#joined",
			channel: frame.channel,
		});

		for (const did of voice.listParticipants(frame.channel)) {
			if (did === connection.did) continue;
			this.send(connection, { $type: "social.colibri.beta.voice.defs#peerJoined", did });
			const state = voice.getVoiceState(frame.channel, did);
			this.send(connection, {
				$type: "social.colibri.beta.voice.defs#moderationChanged",
				did,
				muted: state.muted,
				deafened: state.deafened,
				serverMuted: state.serverMuted,
				serverDeafened: state.serverDeafened,
			});
		}

		const producers = await voice.listProducers(frame.channel);
		for (const producer of producers) {
			if (producer.did === connection.did) continue;
			this.send(connection, {
				$type: "social.colibri.beta.voice.defs#producerInfo",
				producerId: producer.producerId,
				did: producer.did,
				kind: producer.kind,
				paused: producer.paused,
				source: toWireSource(producer.source),
			});
		}
	}

	private async supersedeOtherSessions(
		connection: Connection,
		voice: VoiceSfu,
		channel: string,
	): Promise<void> {
		for (const other of [...this.connections]) {
			if (other === connection || other.did !== connection.did) continue;

			const heldChannel = other.channel;
			this.detach(other, "superseded");
			if (!heldChannel) continue;

			if (heldChannel === channel) {
				voice.supersede(heldChannel, connection.did);
			} else {
				await voice.leave(heldChannel, connection.did);
			}
		}
	}

	private async handleLeave(connection: Connection, voice: VoiceSfu): Promise<void> {
		const channel = this.forgetChannel(connection);
		if (channel) await voice.leave(channel, connection.did);
	}

	private async handleGetRtpCapabilities(connection: Connection, voice: VoiceSfu): Promise<void> {
		if (!connection.channel) return;
		const payload = await voice.rtpCapabilities(connection.channel);
		this.send(connection, { $type: "social.colibri.beta.voice.defs#rtpCapabilities", payload });
	}

	private async handleCreateTransport(
		connection: Connection,
		voice: VoiceSfu,
		frame: { direction: string },
	): Promise<void> {
		if (!connection.channel) return;
		if (frame.direction !== "send" && frame.direction !== "recv") {
			this.error(connection, "InvalidFrame", "direction must be send or recv");
			return;
		}

		try {
			const transport = await voice.createTransport(
				connection.channel,
				connection.did,
				frame.direction,
			);
			this.send(connection, {
				$type: "social.colibri.beta.voice.defs#transportOptions",
				id: transport.id,
				iceParameters: transport.iceParameters,
				iceCandidates: transport.iceCandidates,
				dtlsParameters: transport.dtlsParameters,
				direction: frame.direction,
				...(voice.iceServers.length > 0 ? { iceServers: voice.iceServers } : {}),
			});
		} catch (cause) {
			this.error(connection, "NotFound", messageOf(cause));
		}
	}

	private ack(connection: Connection): void {
		this.send(connection, { $type: "social.colibri.beta.voice.defs#ack" });
	}

	private async handleConnectTransport(
		connection: Connection,
		voice: VoiceSfu,
		frame: { transportId: string; dtlsParameters: unknown },
	): Promise<void> {
		if (!connection.channel) {
			this.error(connection, "NotJoined", "join a channel before connecting a transport");
			return;
		}
		try {
			await voice.connectTransport(
				connection.channel,
				connection.did,
				frame.transportId,
				frame.dtlsParameters as never,
			);
			this.ack(connection);
		} catch (cause) {
			this.error(connection, "NotFound", messageOf(cause));
		}
	}

	private async handleProduce(
		connection: Connection,
		voice: VoiceSfu,
		frame: { transportId: string; kind: string; rtpParameters: unknown; source: string },
	): Promise<void> {
		if (!connection.channel) return;
		const kind = frame.kind === "audio" || frame.kind === "video" ? frame.kind : null;
		if (!kind) {
			this.error(connection, "InvalidFrame", "kind must be audio or video");
			return;
		}

		const source = toInternalSource(frame.source);
		if (kind === "audio" && voice.getVoiceState(connection.channel, connection.did).serverMuted) {
			this.error(connection, "Forbidden", "you are server-muted");
			return;
		}

		try {
			const producer = await voice.produce(connection.channel, connection.did, frame.transportId, {
				kind,
				rtpParameters: frame.rtpParameters as never,
				source,
			});
			this.send(connection, {
				$type: "social.colibri.beta.voice.defs#producerInfo",
				producerId: producer.id,
				did: connection.did,
				kind: producer.kind,
				paused: producer.paused,
				source: frame.source,
			});
		} catch (cause) {
			this.error(connection, "NotFound", messageOf(cause));
		}
	}

	private handleCloseProducer(
		connection: Connection,
		voice: VoiceSfu,
		frame: { producerId: string },
	): void {
		if (!connection.channel) {
			this.error(connection, "NotJoined", "join a channel before closing a producer");
			return;
		}
		voice.closeProducer(connection.channel, connection.did, frame.producerId);
		this.ack(connection);
	}

	private async handleConsume(
		connection: Connection,
		voice: VoiceSfu,
		frame: { transportId: string; producerId: string; rtpCapabilities: unknown },
	): Promise<void> {
		if (!connection.channel) return;
		try {
			const consumer = await voice.consume(connection.channel, connection.did, frame.transportId, {
				producerId: frame.producerId,
				rtpCapabilities: frame.rtpCapabilities as never,
			});
			this.send(connection, {
				$type: "social.colibri.beta.voice.defs#consumerOptions",
				id: consumer.id,
				producerId: consumer.producerId,
				kind: consumer.kind,
				rtpParameters: consumer.rtpParameters,
			});
		} catch (cause) {
			this.error(connection, "NotFound", messageOf(cause));
		}
	}

	private async handleResumeConsumer(
		connection: Connection,
		voice: VoiceSfu,
		frame: { consumerId: string },
	): Promise<void> {
		if (!connection.channel) {
			this.error(connection, "NotJoined", "join a channel before resuming a consumer");
			return;
		}
		try {
			await voice.resume(connection.channel, connection.did, frame.consumerId);
			this.ack(connection);
		} catch (cause) {
			this.error(connection, "NotFound", messageOf(cause));
		}
	}

	private async handleSetSelfState(
		connection: Connection,
		voice: VoiceSfu,
		frame: { muted?: boolean; deafened?: boolean },
	): Promise<void> {
		if (!connection.channel) {
			this.error(connection, "NotJoined", "join a channel before setting your own state");
			return;
		}
		if (frame.muted !== undefined || frame.deafened !== undefined) {
			await voice.setSelfState(connection.channel, connection.did, {
				...(frame.muted === undefined ? {} : { muted: frame.muted }),
				...(frame.deafened === undefined ? {} : { deafened: frame.deafened }),
			});
		}
		this.ack(connection);
	}

	private wireVoiceEvents(voice: VoiceSfu): void {
		voice.on("participant-joined", ({ channel, did }) => {
			this.broadcast(channel, { $type: "social.colibri.beta.voice.defs#peerJoined", did }, did);
			this.announce(channel, did, "join", voiceStateIn(voice, channel, did));
		});
		voice.on("participant-left", ({ channel, did, reason }) => {
			this.broadcast(channel, { $type: "social.colibri.beta.voice.defs#peerLeft", did }, did);
			if (reason) {
				this.tell(channel, did, {
					$type: "social.colibri.beta.voice.defs#disconnected",
					reason,
				});
			}
			this.announce(channel, did, "leave");
		});
		voice.on("producer-added", ({ channel, did, producerId, kind, source, paused }) => {
			this.broadcast(
				channel,
				{
					$type: "social.colibri.beta.voice.defs#producerInfo",
					producerId,
					did,
					kind,
					paused,
					source: toWireSource(source),
				},
				did,
			);
		});
		voice.on("producer-removed", ({ channel, did, producerId }) => {
			this.broadcast(
				channel,
				{ $type: "social.colibri.beta.voice.defs#producerRemoved", producerId, did },
				did,
			);
		});
		voice.on("speaking-changed", ({ channel, did, speaking }) => {
			this.broadcast(channel, {
				$type: "social.colibri.beta.voice.defs#speakingUpdate",
				did,
				speaking,
			});
		});
		voice.on("voice-state-changed", ({ channel, did, muted, deafened, ...server }) => {
			this.broadcast(channel, {
				$type: "social.colibri.beta.voice.defs#moderationChanged",
				did,
				muted,
				deafened,
				serverMuted: server.serverMuted,
				serverDeafened: server.serverDeafened,
			});
			this.announce(channel, did, "update", {
				channel: asSpaceRef(channel),
				muted,
				deafened,
				serverMuted: server.serverMuted,
				serverDeafened: server.serverDeafened,
			});
		});
	}

	private announce(
		channel: string,
		did: string,
		event: "join" | "leave" | "update",
		voice?: social.colibri.beta.actor.defs.VoiceState,
	): void {
		if (!this.events) return;
		this.events.publishToCommunity(parseSpaceRef(channel).authority, {
			$type: "social.colibri.beta.sync.defs#voiceEvent",
			event,
			channel: asSpaceRef(channel),
			did: asDid(did),
			...(voice ? { voice } : {}),
		});
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
