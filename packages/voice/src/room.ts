import type {
	AudioLevelObserver,
	Consumer,
	DtlsParameters,
	MediaKind,
	Producer,
	Router,
	RouterRtpCodecCapability,
	RtpCapabilities,
	RtpParameters,
	WebRtcTransport,
	WebRtcTransportOptions,
} from "mediasoup/types";
import {
	applySpeakingTick,
	createSpeakingTracker,
	forgetSpeaker,
	type SpeakingTracker,
} from "./speaking.js";
import { TypedEmitter } from "./typed-emitter.js";

export type TransportDirection = "send" | "recv";

export type VoiceState = {
	muted: boolean;
	deafened: boolean;
	serverMuted: boolean;
	serverDeafened: boolean;
};

export type VoicePatch = { muted?: boolean; deafened?: boolean };

export type VoiceStateOrigin = "self" | "server";

type ParticipantVoice = {
	selfMuted: boolean;
	selfDeafened: boolean;
	serverMuted: boolean;
	serverDeafened: boolean;
};

const effectiveVoice = (voice: ParticipantVoice): VoiceState => ({
	muted: voice.selfMuted || voice.serverMuted,
	deafened: voice.selfDeafened || voice.serverDeafened,
	serverMuted: voice.serverMuted,
	serverDeafened: voice.serverDeafened,
});

const SILENT: ParticipantVoice = {
	selfMuted: false,
	selfDeafened: false,
	serverMuted: false,
	serverDeafened: false,
};

export type ProducerSnapshot = {
	did: string;
	producerId: string;
	kind: MediaKind;
	source: string;
};

export type VoiceRoomEvents = {
	"participant-joined": [{ did: string }];
	"participant-left": [{ did: string }];
	"producer-added": [{ did: string; producerId: string; kind: MediaKind; source: string }];
	"producer-removed": [{ did: string; producerId: string }];
	"speaking-changed": [{ did: string; speaking: boolean }];
	"voice-state-changed": [{ did: string; origin: VoiceStateOrigin } & VoiceState];
};

export type WebRtcListenOptions = {
	listenIp: string;
	announcedIp?: string;
	rtcMinPort?: number;
	rtcMaxPort?: number;
};

export type VoiceRoomOptions = {
	webRtcTransportOptions: WebRtcTransportOptions;
	speakingDebounceMs?: number;
};

type ParticipantRecord = {
	transports: Map<string, WebRtcTransport>;
	producers: Map<string, { producer: Producer; source: string }>;
	consumers: Map<string, Consumer>;
	voice: ParticipantVoice;
};

const AUDIO_LEVEL_OBSERVER_OPTIONS = {
	maxEntries: 20,
	threshold: -80,
	interval: 400,
};

const DEFAULT_SPEAKING_DEBOUNCE_MS = 1_000;

export function mediaCodecs(): RouterRtpCodecCapability[] {
	return [
		{
			kind: "audio",
			mimeType: "audio/opus",
			clockRate: 48000,
			channels: 2,
			parameters: { useinbandfec: 1 },
			rtcpFeedback: [{ type: "transport-cc" }],
		},
		{
			kind: "video",
			mimeType: "video/VP8",
			clockRate: 90000,
			parameters: {},
			rtcpFeedback: [
				{ type: "nack" },
				{ type: "nack", parameter: "pli" },
				{ type: "ccm", parameter: "fir" },
				{ type: "goog-remb" },
				{ type: "transport-cc" },
			],
		},
		{
			kind: "video",
			mimeType: "video/H264",
			clockRate: 90000,
			parameters: {
				"packetization-mode": 1,
				"profile-level-id": "42e01f",
				"level-asymmetry-allowed": 1,
			},
			rtcpFeedback: [
				{ type: "nack" },
				{ type: "nack", parameter: "pli" },
				{ type: "ccm", parameter: "fir" },
				{ type: "goog-remb" },
				{ type: "transport-cc" },
			],
		},
	];
}

export function buildWebRtcTransportOptions(options: WebRtcListenOptions): WebRtcTransportOptions {
	const portRange =
		options.rtcMinPort !== undefined && options.rtcMaxPort !== undefined
			? { min: options.rtcMinPort, max: options.rtcMaxPort }
			: undefined;

	const baseListenInfo = {
		ip: options.listenIp,
		announcedAddress: options.announcedIp,
		portRange,
	};

	return {
		listenInfos: [
			{ ...baseListenInfo, protocol: "udp" },
			{ ...baseListenInfo, protocol: "tcp" },
		],
	};
}

function isMicProducer(kind: MediaKind, source: string): boolean {
	return kind === "audio" && source === "mic";
}

export class VoiceRoom extends TypedEmitter<VoiceRoomEvents> {
	readonly channelRef: string;

	private readonly router: Router;
	private readonly audioLevelObserver: AudioLevelObserver;
	private readonly webRtcTransportOptions: WebRtcTransportOptions;
	private readonly speakingDebounceMs: number;
	private readonly participants = new Map<string, ParticipantRecord>();
	private readonly producerIndex = new Map<string, { did: string; source: string }>();
	private readonly speakingTracker: SpeakingTracker = createSpeakingTracker();
	private closed = false;

	private constructor(
		channelRef: string,
		router: Router,
		audioLevelObserver: AudioLevelObserver,
		webRtcTransportOptions: WebRtcTransportOptions,
		speakingDebounceMs: number,
	) {
		super();
		this.channelRef = channelRef;
		this.router = router;
		this.audioLevelObserver = audioLevelObserver;
		this.webRtcTransportOptions = webRtcTransportOptions;
		this.speakingDebounceMs = speakingDebounceMs;
		this.wireAudioLevelObserver();
	}

	static async create(
		router: Router,
		channelRef: string,
		options: VoiceRoomOptions,
	): Promise<VoiceRoom> {
		const audioLevelObserver = await router.createAudioLevelObserver(AUDIO_LEVEL_OBSERVER_OPTIONS);
		return new VoiceRoom(
			channelRef,
			router,
			audioLevelObserver,
			options.webRtcTransportOptions,
			options.speakingDebounceMs ?? DEFAULT_SPEAKING_DEBOUNCE_MS,
		);
	}

	get rtpCapabilities(): RtpCapabilities {
		return this.router.rtpCapabilities;
	}

	get participantCount(): number {
		return this.participants.size;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	hasParticipant(did: string): boolean {
		return this.participants.has(did);
	}

	getVoiceState(did: string): VoiceState {
		return effectiveVoice(this.participants.get(did)?.voice ?? SILENT);
	}

	snapshotProducers(): ProducerSnapshot[] {
		const snapshot: ProducerSnapshot[] = [];
		for (const [did, participant] of this.participants) {
			for (const [producerId, entry] of participant.producers) {
				snapshot.push({ did, producerId, kind: entry.producer.kind, source: entry.source });
			}
		}
		return snapshot;
	}

	async createTransport(did: string, direction: TransportDirection): Promise<WebRtcTransport> {
		this.assertOpen();
		const participant = this.ensureParticipant(did);
		const transport = await this.router.createWebRtcTransport({
			...this.webRtcTransportOptions,
			appData: { did, direction },
		});
		participant.transports.set(transport.id, transport);
		transport.on("dtlsstatechange", (state) => {
			if (state === "closed") {
				participant.transports.delete(transport.id);
			}
		});
		return transport;
	}

	async connectTransport(
		did: string,
		transportId: string,
		dtlsParameters: DtlsParameters,
	): Promise<void> {
		const transport = this.getTransport(did, transportId);
		await transport.connect({ dtlsParameters });
	}

	async produce(
		did: string,
		transportId: string,
		options: { kind: MediaKind; rtpParameters: RtpParameters; source: string },
	): Promise<Producer> {
		this.assertOpen();
		const participant = this.ensureParticipant(did);
		const transport = this.getTransport(did, transportId);
		const startPaused =
			isMicProducer(options.kind, options.source) && effectiveVoice(participant.voice).muted;

		const producer = await transport.produce({
			kind: options.kind,
			rtpParameters: options.rtpParameters,
			paused: startPaused,
		});

		participant.producers.set(producer.id, { producer, source: options.source });
		this.producerIndex.set(producer.id, { did, source: options.source });

		producer.on("transportclose", () => {
			this.forgetProducer(did, producer.id);
		});

		if (isMicProducer(options.kind, options.source)) {
			await this.audioLevelObserver.addProducer({ producerId: producer.id });
		}

		this.emit("producer-added", {
			did,
			producerId: producer.id,
			kind: options.kind,
			source: options.source,
		});
		return producer;
	}

	closeProducer(did: string, producerId: string): void {
		const participant = this.participants.get(did);
		const entry = participant?.producers.get(producerId);
		if (!entry) {
			return;
		}
		entry.producer.close();
		this.forgetProducer(did, producerId);
	}

	async consume(
		did: string,
		transportId: string,
		options: { producerId: string; rtpCapabilities: RtpCapabilities },
	): Promise<Consumer> {
		this.assertOpen();
		const participant = this.ensureParticipant(did);
		const transport = this.getTransport(did, transportId);

		const consumer = await transport.consume({
			producerId: options.producerId,
			rtpCapabilities: options.rtpCapabilities,
			paused: true,
		});

		participant.consumers.set(consumer.id, consumer);
		consumer.on("transportclose", () => participant.consumers.delete(consumer.id));
		consumer.on("producerclose", () => participant.consumers.delete(consumer.id));

		return consumer;
	}

	async resumeConsumer(did: string, consumerId: string): Promise<void> {
		const participant = this.getParticipant(did);
		if (effectiveVoice(participant.voice).deafened) {
			return;
		}
		const consumer = participant.consumers.get(consumerId);
		if (!consumer) {
			throw new Error(`no consumer ${consumerId} for ${did} in room ${this.channelRef}`);
		}
		await consumer.resume();
	}

	async setSelfState(did: string, patch: VoicePatch): Promise<void> {
		await this.applyVoiceState(did, "self", patch);
	}

	async setServerState(did: string, patch: VoicePatch): Promise<void> {
		await this.applyVoiceState(did, "server", patch);
	}

	private async applyVoiceState(
		did: string,
		origin: VoiceStateOrigin,
		patch: VoicePatch,
	): Promise<void> {
		const participant = this.ensureParticipant(did);
		const before = effectiveVoice(participant.voice);

		if (patch.muted !== undefined) {
			if (origin === "self") participant.voice.selfMuted = patch.muted;
			else participant.voice.serverMuted = patch.muted;
		}
		if (patch.deafened !== undefined) {
			if (origin === "self") participant.voice.selfDeafened = patch.deafened;
			else participant.voice.serverDeafened = patch.deafened;
		}

		const after = effectiveVoice(participant.voice);

		if (after.muted !== before.muted) {
			for (const { producer, source } of participant.producers.values()) {
				if (isMicProducer(producer.kind, source)) {
					await (after.muted ? producer.pause() : producer.resume());
				}
			}
		}

		if (after.deafened !== before.deafened) {
			for (const consumer of participant.consumers.values()) {
				await (after.deafened ? consumer.pause() : consumer.resume());
			}
		}

		this.emit("voice-state-changed", { did, origin, ...after });
	}

	async leave(did: string): Promise<void> {
		const participant = this.participants.get(did);
		if (!participant) {
			return;
		}

		for (const consumer of participant.consumers.values()) {
			consumer.close();
		}
		for (const { producer } of participant.producers.values()) {
			producer.close();
			this.producerIndex.delete(producer.id);
		}
		for (const transport of participant.transports.values()) {
			transport.close();
		}

		this.participants.delete(did);
		forgetSpeaker(this.speakingTracker, did);
		this.emit("participant-left", { did });
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const did of [...this.participants.keys()]) {
			await this.leave(did);
		}
		this.audioLevelObserver.close();
		this.router.close();
	}

	private ensureParticipant(did: string): ParticipantRecord {
		let participant = this.participants.get(did);
		if (!participant) {
			participant = {
				transports: new Map(),
				producers: new Map(),
				consumers: new Map(),
				voice: { ...SILENT },
			};
			this.participants.set(did, participant);
			this.emit("participant-joined", { did });
		}
		return participant;
	}

	private getParticipant(did: string): ParticipantRecord {
		const participant = this.participants.get(did);
		if (!participant) {
			throw new Error(`no participant ${did} in room ${this.channelRef}`);
		}
		return participant;
	}

	private getTransport(did: string, transportId: string): WebRtcTransport {
		const participant = this.getParticipant(did);
		const transport = participant.transports.get(transportId);
		if (!transport) {
			throw new Error(`no transport ${transportId} for ${did} in room ${this.channelRef}`);
		}
		return transport;
	}

	private forgetProducer(did: string, producerId: string): void {
		const participant = this.participants.get(did);
		if (participant?.producers.delete(producerId)) {
			this.producerIndex.delete(producerId);
			this.emit("producer-removed", { did, producerId });
		}
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error(`room ${this.channelRef} is closed`);
		}
	}

	private wireAudioLevelObserver(): void {
		this.audioLevelObserver.on("volumes", (volumes) => {
			const activeDids = volumes
				.map((volume) => this.producerIndex.get(volume.producer.id)?.did)
				.filter((did): did is string => did !== undefined);
			this.tickSpeaking(activeDids);
		});
		this.audioLevelObserver.on("silence", () => this.tickSpeaking([]));
	}

	private tickSpeaking(activeDids: string[]): void {
		const { started, stopped } = applySpeakingTick(
			this.speakingTracker,
			activeDids,
			Date.now(),
			this.speakingDebounceMs,
		);
		for (const did of started) {
			this.emit("speaking-changed", { did, speaking: true });
		}
		for (const did of stopped) {
			this.emit("speaking-changed", { did, speaking: false });
		}
	}
}
