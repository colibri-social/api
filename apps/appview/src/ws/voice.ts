import type { Server as HttpServer, IncomingHttpHeaders } from "node:http";
import { canRead } from "@colibri-social/community";
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

	constructor(
		private readonly ctx: AppContext,
		private readonly events: EventServer | null = null,
	) {
		if (ctx.voice) this.wireVoiceEvents(ctx.voice);
	}

	get connectionCount(): number {
		return this.connections.size;
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
		if (this.heartbeat) clearInterval(this.heartbeat);
		for (const connection of this.connections) connection.socket.close(1001, "shutting down");
		this.connections.clear();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
	}

	private async authenticate(headers: IncomingHttpHeaders, url: URL): Promise<string | null> {
		const token = bearerToken(headers, url);
		if (!token) return null;
		const caller = await this.ctx.serviceAuth
			.verify(token, "social.colibri.beta.voice.subscribeSignals")
			.catch(() => null);
		return caller?.did ?? null;
	}

	private accept(socket: WebSocket, did: string): void {
		const connection: Connection = { socket, did, channel: null, alive: true };
		this.connections.add(connection);

		socket.on("pong", () => {
			connection.alive = true;
		});
		socket.on("message", (raw) => void this.receive(connection, raw.toString()));
		socket.on("close", () => this.disconnect(connection));
		socket.on("error", () => socket.close());
	}

	private disconnect(connection: Connection): void {
		this.connections.delete(connection);
		const channel = this.forgetChannel(connection);
		if (channel) void this.ctx.voice?.leave(channel, connection.did);
	}

	private forgetChannel(connection: Connection): string | null {
		const channel = connection.channel;
		if (!channel) return null;
		connection.channel = null;
		this.topics.unsubscribe(connection, [channelTopic(channel)]);
		return channel;
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
		if (!canRead(authz, state)) {
			this.error(connection, "Forbidden", "you cannot read this channel");
			return;
		}

		const previous = this.forgetChannel(connection);
		if (previous) await voice.leave(previous, connection.did);

		connection.channel = frame.channel;
		this.topics.subscribe(connection, [channelTopic(frame.channel)]);
		this.send(connection, {
			$type: "social.colibri.beta.voice.defs#joined",
			channel: frame.channel,
		});

		const producers = await voice.listProducers(frame.channel);
		for (const producer of producers) {
			if (producer.did === connection.did) continue;
			this.send(connection, {
				$type: "social.colibri.beta.voice.defs#producerInfo",
				producerId: producer.producerId,
				did: producer.did,
				kind: producer.kind,
				source: toWireSource(producer.source),
			});
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
			});
		} catch (cause) {
			this.error(connection, "NotFound", messageOf(cause));
		}
	}

	private async handleConnectTransport(
		connection: Connection,
		voice: VoiceSfu,
		frame: { transportId: string; dtlsParameters: unknown },
	): Promise<void> {
		if (!connection.channel) return;
		try {
			await voice.connectTransport(
				connection.channel,
				connection.did,
				frame.transportId,
				frame.dtlsParameters as never,
			);
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
		if (!connection.channel) return;
		voice.closeProducer(connection.channel, connection.did, frame.producerId);
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
		if (!connection.channel) return;
		try {
			await voice.resume(connection.channel, connection.did, frame.consumerId);
		} catch (cause) {
			this.error(connection, "NotFound", messageOf(cause));
		}
	}

	private async handleSetSelfState(
		connection: Connection,
		voice: VoiceSfu,
		frame: { muted?: boolean; deafened?: boolean },
	): Promise<void> {
		if (!connection.channel) return;
		if (frame.muted === undefined && frame.deafened === undefined) return;
		await voice.setSelfState(connection.channel, connection.did, {
			...(frame.muted === undefined ? {} : { muted: frame.muted }),
			...(frame.deafened === undefined ? {} : { deafened: frame.deafened }),
		});
	}

	private wireVoiceEvents(voice: VoiceSfu): void {
		voice.on("participant-joined", ({ channel, did }) => {
			this.broadcast(channel, { $type: "social.colibri.beta.voice.defs#peerJoined", did }, did);
			this.announce(channel, did, "join", voiceStateIn(voice, channel, did));
		});
		voice.on("participant-left", ({ channel, did }) => {
			this.broadcast(channel, { $type: "social.colibri.beta.voice.defs#peerLeft", did }, did);
			this.announce(channel, did, "leave");
		});
		voice.on("producer-added", ({ channel, did, producerId, kind, source }) => {
			this.broadcast(
				channel,
				{
					$type: "social.colibri.beta.voice.defs#producerInfo",
					producerId,
					did,
					kind,
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
