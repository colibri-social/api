import type {
	Consumer,
	DtlsParameters,
	MediaKind,
	Producer,
	RtpCapabilities,
	RtpParameters,
	WebRtcTransport,
} from "mediasoup/types";
import { parseVoiceSfuConfig, type VoiceSfuConfig, type VoiceSfuConfigInput } from "./config.js";
import {
	buildWebRtcTransportOptions,
	mediaCodecs,
	type ProducerSnapshot,
	type TransportDirection,
	type VoicePatch,
	VoiceRoom,
	type VoiceState,
	type VoiceStateOrigin,
} from "./room.js";
import { TypedEmitter } from "./typed-emitter.js";
import { WorkerPool, type WorkerPoolLike } from "./worker-pool.js";

export type VoiceSfuEvents = {
	"room-created": [{ channel: string }];
	"room-closed": [{ channel: string }];
	"worker-died": [{ pid: number; error: Error }];
	"worker-restarted": [{ pid: number }];
	"participant-joined": [{ channel: string; did: string }];
	"participant-left": [{ channel: string; did: string }];
	"producer-added": [
		{ channel: string; did: string; producerId: string; kind: MediaKind; source: string },
	];
	"producer-removed": [{ channel: string; did: string; producerId: string }];
	"speaking-changed": [{ channel: string; did: string; speaking: boolean }];
	"voice-state-changed": [{ channel: string; did: string; origin: VoiceStateOrigin } & VoiceState];
};

export type VoiceSfuDependencies = {
	workerPool?: WorkerPoolLike;
};

export class VoiceSfu extends TypedEmitter<VoiceSfuEvents> {
	private readonly config: VoiceSfuConfig;
	private readonly workerPool: WorkerPoolLike;
	private readonly webRtcTransportOptions: ReturnType<typeof buildWebRtcTransportOptions>;
	private readonly rooms = new Map<string, VoiceRoom>();
	private readonly roomCreations = new Map<string, Promise<VoiceRoom>>();
	private readonly roomGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly presence = new Map<string, string>();
	private closed = false;

	private constructor(config: VoiceSfuConfig, workerPool: WorkerPoolLike) {
		super();
		this.config = config;
		this.workerPool = workerPool;
		this.webRtcTransportOptions = buildWebRtcTransportOptions(config);
	}

	static async create(
		input: VoiceSfuConfigInput = {},
		deps: VoiceSfuDependencies = {},
	): Promise<VoiceSfu> {
		const config = parseVoiceSfuConfig(input);
		const workerPool =
			deps.workerPool ?? (await WorkerPool.create({ workerCount: config.workerCount }));
		const sfu = new VoiceSfu(config, workerPool);
		if (workerPool instanceof WorkerPool) {
			workerPool.on("worker-died", (event) => sfu.emit("worker-died", event));
			workerPool.on("worker-restarted", (event) => sfu.emit("worker-restarted", event));
		}
		return sfu;
	}

	presenceOf(did: string): string | undefined {
		return this.presence.get(did);
	}

	async rtpCapabilities(channel: string): Promise<RtpCapabilities> {
		const room = await this.getOrCreateRoom(channel);
		return room.rtpCapabilities;
	}

	async listProducers(channel: string): Promise<ProducerSnapshot[]> {
		const room = this.rooms.get(channel);
		return room ? room.snapshotProducers() : [];
	}

	getVoiceState(channel: string, did: string): VoiceState {
		const room = this.rooms.get(channel);
		return room
			? room.getVoiceState(did)
			: { muted: false, deafened: false, serverMuted: false, serverDeafened: false };
	}

	async createTransport(
		channel: string,
		did: string,
		direction: TransportDirection,
	): Promise<WebRtcTransport> {
		const room = await this.getOrCreateRoom(channel);
		await this.movePresence(channel, did);
		return room.createTransport(did, direction);
	}

	async connectTransport(
		channel: string,
		did: string,
		transportId: string,
		dtlsParameters: DtlsParameters,
	): Promise<void> {
		const room = this.requireRoom(channel);
		await room.connectTransport(did, transportId, dtlsParameters);
	}

	async produce(
		channel: string,
		did: string,
		transportId: string,
		options: { kind: MediaKind; rtpParameters: RtpParameters; source: string },
	): Promise<Producer> {
		const room = this.requireRoom(channel);
		return room.produce(did, transportId, options);
	}

	closeProducer(channel: string, did: string, producerId: string): void {
		this.rooms.get(channel)?.closeProducer(did, producerId);
	}

	async consume(
		channel: string,
		did: string,
		transportId: string,
		options: { producerId: string; rtpCapabilities: RtpCapabilities },
	): Promise<Consumer> {
		const room = this.requireRoom(channel);
		return room.consume(did, transportId, options);
	}

	async resume(channel: string, did: string, consumerId: string): Promise<void> {
		const room = this.requireRoom(channel);
		await room.resumeConsumer(did, consumerId);
	}

	async moderate(channel: string, did: string, patch: VoicePatch): Promise<void> {
		const room = this.requireRoom(channel);
		await room.setServerState(did, patch);
	}

	async setSelfState(channel: string, did: string, patch: VoicePatch): Promise<void> {
		const room = this.requireRoom(channel);
		await room.setSelfState(did, patch);
	}

	async leave(channel: string, did: string): Promise<void> {
		const room = this.rooms.get(channel);
		if (!room) {
			return;
		}
		await room.leave(did);
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;

		for (const timer of this.roomGraceTimers.values()) {
			clearTimeout(timer);
		}
		this.roomGraceTimers.clear();

		for (const room of this.rooms.values()) {
			await room.close();
		}
		this.rooms.clear();
		this.presence.clear();

		await this.workerPool.close();
	}

	private async getOrCreateRoom(channel: string): Promise<VoiceRoom> {
		if (this.closed) {
			throw new Error("voice sfu is closed");
		}

		const existing = this.rooms.get(channel);
		if (existing) {
			this.cancelGraceTimer(channel);
			return existing;
		}

		const pending = this.roomCreations.get(channel);
		if (pending) {
			return pending;
		}

		const creation = this.createRoom(channel).finally(() => {
			this.roomCreations.delete(channel);
		});
		this.roomCreations.set(channel, creation);
		return creation;
	}

	private async createRoom(channel: string): Promise<VoiceRoom> {
		const router = await this.workerPool.createRouter({ mediaCodecs: mediaCodecs() });
		const room = await VoiceRoom.create(router, channel, {
			webRtcTransportOptions: this.webRtcTransportOptions,
			speakingDebounceMs: this.config.speakingDebounceMs,
		});
		this.rooms.set(channel, room);
		this.wireRoomEvents(channel, room);
		this.emit("room-created", { channel });
		return room;
	}

	private wireRoomEvents(channel: string, room: VoiceRoom): void {
		room.on("participant-joined", ({ did }) => {
			this.emit("participant-joined", { channel, did });
		});
		room.on("participant-left", ({ did }) => {
			this.emit("participant-left", { channel, did });
			if (this.presence.get(did) === channel) {
				this.presence.delete(did);
			}
			if (room.participantCount === 0) {
				this.scheduleGraceTeardown(channel);
			}
		});
		room.on("producer-added", (event) => this.emit("producer-added", { channel, ...event }));
		room.on("producer-removed", (event) => this.emit("producer-removed", { channel, ...event }));
		room.on("speaking-changed", (event) => this.emit("speaking-changed", { channel, ...event }));
		room.on("voice-state-changed", (event) =>
			this.emit("voice-state-changed", { channel, ...event }),
		);
	}

	private async movePresence(channel: string, did: string): Promise<void> {
		const previousChannel = this.presence.get(did);
		if (previousChannel && previousChannel !== channel) {
			const previousRoom = this.rooms.get(previousChannel);
			if (previousRoom) {
				await previousRoom.leave(did);
			}
		}
		this.presence.set(did, channel);
	}

	private scheduleGraceTeardown(channel: string): void {
		this.cancelGraceTimer(channel);
		const timer = setTimeout(() => {
			this.roomGraceTimers.delete(channel);
			const room = this.rooms.get(channel);
			if (!room || room.participantCount > 0) {
				return;
			}
			this.rooms.delete(channel);
			this.emit("room-closed", { channel });
			void room.close();
		}, this.config.roomGraceMs);
		this.roomGraceTimers.set(channel, timer);
	}

	private cancelGraceTimer(channel: string): void {
		const timer = this.roomGraceTimers.get(channel);
		if (timer) {
			clearTimeout(timer);
			this.roomGraceTimers.delete(channel);
		}
	}

	private requireRoom(channel: string): VoiceRoom {
		const room = this.rooms.get(channel);
		if (!room) {
			throw new Error(`no voice room for channel ${channel}`);
		}
		return room;
	}
}
