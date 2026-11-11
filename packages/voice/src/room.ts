import type {
	AudioLevelObserver,
	Consumer,
	DtlsParameters,
	MediaKind,
	Producer,
	Router,
	RouterRtpCodecCapability,
	RtcpFeedback,
	RtpCapabilities,
	RtpParameters,
	WebRtcServer,
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

export type VoiceSharing = { camera: boolean; screen: boolean };

export type ConsumerPreference = {
	spatialLayer: number;
	temporalLayer?: number;
	paused: boolean;
};

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
	paused: boolean;
};

export type ServerVoiceState = {
	serverMuted: boolean;
	serverDeafened: boolean;
};

export type ModerationStore = Map<string, ServerVoiceState>;

export type TransportSample = {
	iceState: string;
	recvBitrate: number;
	sendBitrate: number;
	lossReceived: number;
	lossSent: number;
};

export type ParticipantLeftReason = "superseded" | "channelGone";

export type VoiceRoomEvents = {
	"participant-joined": [{ did: string }];
	"participant-left": [{ did: string; reason?: ParticipantLeftReason }];
	"producer-added": [
		{ did: string; producerId: string; kind: MediaKind; source: string; paused: boolean },
	];
	"producer-removed": [{ did: string; producerId: string; source: string }];
	"codec-unsupported": [{ did: string; producerId: string }];
	"speaking-changed": [{ did: string; speaking: boolean }];
	"voice-state-changed": [{ did: string; origin: VoiceStateOrigin } & VoiceState];
	"router-lost": [];
};

export type WebRtcListenOptions = {
	listenIp: string;
	announcedIp?: string;
	webRtcServer?: WebRtcServer;
	initialAvailableOutgoingBitrate?: number;
};

export type RoomRouter = {
	router: Router;
	webRtcTransportOptions: WebRtcTransportOptions;
	worker?: number;
};

export type ExtraRouterSource = (busyWorkers: readonly number[]) => Promise<RoomRouter>;

export type VoiceRoomOptions = {
	webRtcTransportOptions: WebRtcTransportOptions;
	speakingDebounceMs?: number;
	moderation?: ModerationStore;
	worker?: number;
	extraRouter?: ExtraRouterSource;
	participantsPerRouter?: number;
	maxRouters?: number;
};

type RouterSlot = RoomRouter & {
	members: Set<string>;
	piped: Map<string, Promise<void>>;
};

export const DEFAULT_PARTICIPANTS_PER_ROUTER = 20;

type ParticipantRecord = {
	slot: RouterSlot | null;
	transports: Map<string, WebRtcTransport>;
	producers: Map<string, { producer: Producer; source: string }>;
	consumers: Map<string, Consumer>;
	viewerPaused: Set<string>;
	voice: ParticipantVoice;
};

const AUDIO_LEVEL_OBSERVER_OPTIONS = {
	maxEntries: 20,
	threshold: -80,
	interval: 400,
};

const DEFAULT_SPEAKING_DEBOUNCE_MS = 1_000;

export const SCREEN_KEYFRAME_REQUEST_DELAY_MS = 400;

export const SEND_MAX_INCOMING_BITRATE = 20_000_000;

export const SCREEN_CONSUMER_PRIORITY = 2;

const VIDEO_RTCP_FEEDBACK: RtcpFeedback[] = [
	{ type: "nack" },
	{ type: "nack", parameter: "pli" },
	{ type: "ccm", parameter: "fir" },
	{ type: "goog-remb" },
	{ type: "transport-cc" },
];

export function mediaCodecs(): RouterRtpCodecCapability[] {
	return [
		{
			kind: "audio",
			mimeType: "audio/opus",
			clockRate: 48000,
			channels: 2,
			parameters: { useinbandfec: 1, usedtx: 1 },
			rtcpFeedback: [{ type: "transport-cc" }],
		},
		{
			kind: "video",
			mimeType: "video/VP8",
			clockRate: 90000,
			parameters: {},
			rtcpFeedback: VIDEO_RTCP_FEEDBACK,
		},
		{
			kind: "video",
			mimeType: "video/VP9",
			clockRate: 90000,
			parameters: { "profile-id": 0 },
			rtcpFeedback: VIDEO_RTCP_FEEDBACK,
		},
		{
			kind: "video",
			mimeType: "video/H264",
			clockRate: 90000,
			parameters: {
				"packetization-mode": 1,
				"profile-level-id": "42e028",
				"level-asymmetry-allowed": 1,
			},
			rtcpFeedback: VIDEO_RTCP_FEEDBACK,
		},
		{
			kind: "video",
			mimeType: "video/H264",
			clockRate: 90000,
			parameters: {
				"packetization-mode": 1,
				"profile-level-id": "640028",
				"level-asymmetry-allowed": 1,
			},
			rtcpFeedback: VIDEO_RTCP_FEEDBACK,
		},
	];
}

export function buildWebRtcTransportOptions(options: WebRtcListenOptions): WebRtcTransportOptions {
	const bitrate =
		options.initialAvailableOutgoingBitrate !== undefined
			? { initialAvailableOutgoingBitrate: options.initialAvailableOutgoingBitrate }
			: {};

	if (options.webRtcServer) {
		return {
			webRtcServer: options.webRtcServer,
			enableUdp: true,
			enableTcp: true,
			preferUdp: true,
			...bitrate,
		};
	}

	const baseListenInfo = {
		ip: options.listenIp,
		announcedAddress: options.announcedIp,
	};

	return {
		listenInfos: [
			{ ...baseListenInfo, protocol: "udp" },
			{ ...baseListenInfo, protocol: "tcp" },
		],
		...bitrate,
	};
}

function isMicProducer(kind: MediaKind, source: string): boolean {
	return kind === "audio" && source === "mic";
}

function silencesProducer(voice: ParticipantVoice, kind: MediaKind, source: string): boolean {
	if (kind !== "audio") return false;
	return voice.serverMuted || (voice.selfMuted && source === "mic");
}

function isScreenVideo(kind: MediaKind, source: string): boolean {
	return kind === "video" && source === "screen";
}

function isDeafenable(kind: MediaKind): boolean {
	return kind === "audio";
}

function hasLayers(consumer: Consumer): boolean {
	return consumer.type === "simulcast" || consumer.type === "svc";
}

export class VoiceRoom extends TypedEmitter<VoiceRoomEvents> {
	readonly channelRef: string;

	private readonly router: Router;
	private readonly primary: RouterSlot;
	private readonly slots: RouterSlot[];
	private readonly audioLevelObserver: AudioLevelObserver;
	private readonly speakingDebounceMs: number;
	private readonly extraRouter: ExtraRouterSource | undefined;
	private readonly participantsPerRouter: number;
	private readonly maxRouters: number;
	private addingSlot: Promise<RouterSlot> | null = null;
	private readonly participants = new Map<string, ParticipantRecord>();
	private readonly producerIndex = new Map<string, { did: string; source: string }>();
	private readonly codecUnsupportedReported = new Set<string>();
	private readonly speakingTracker: SpeakingTracker = createSpeakingTracker();
	private readonly clientSpeaking = new Map<string, boolean>();
	private readonly moderation: ModerationStore;
	private speakingSettleTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;

	private constructor(
		channelRef: string,
		router: Router,
		audioLevelObserver: AudioLevelObserver,
		options: VoiceRoomOptions,
	) {
		super();
		this.channelRef = channelRef;
		this.router = router;
		this.primary = {
			router,
			webRtcTransportOptions: options.webRtcTransportOptions,
			...(options.worker === undefined ? {} : { worker: options.worker }),
			members: new Set(),
			piped: new Map(),
		};
		this.slots = [this.primary];
		this.audioLevelObserver = audioLevelObserver;
		this.speakingDebounceMs = options.speakingDebounceMs ?? DEFAULT_SPEAKING_DEBOUNCE_MS;
		this.moderation = options.moderation ?? new Map();
		this.extraRouter = options.extraRouter;
		this.participantsPerRouter = options.participantsPerRouter ?? DEFAULT_PARTICIPANTS_PER_ROUTER;
		this.maxRouters = options.maxRouters ?? 1;
		this.wireAudioLevelObserver();
	}

	static async create(
		router: Router,
		channelRef: string,
		options: VoiceRoomOptions,
	): Promise<VoiceRoom> {
		const audioLevelObserver = await router.createAudioLevelObserver(AUDIO_LEVEL_OBSERVER_OPTIONS);
		return new VoiceRoom(channelRef, router, audioLevelObserver, options);
	}

	get routerCount(): number {
		return this.slots.length;
	}

	routerLoad(): number[] {
		return this.slots.map((slot) => slot.members.size);
	}

	get rtpCapabilities(): RtpCapabilities {
		return this.router.rtpCapabilities;
	}

	get participantCount(): number {
		return this.participants.size;
	}

	get participantDids(): string[] {
		return [...this.participants.keys()];
	}

	async transportStats(): Promise<TransportSample[]> {
		const transports = [...this.participants.values()].flatMap((participant) => [
			...participant.transports.values(),
		]);
		const samples = await Promise.all(
			transports.map(async (transport) => {
				const [stats] = await transport.getStats().catch(() => []);

				return {
					iceState: transport.iceState,
					recvBitrate: stats?.recvBitrate ?? 0,
					sendBitrate: stats?.sendBitrate ?? 0,
					lossReceived: stats?.rtpPacketLossReceived ?? 0,
					lossSent: stats?.rtpPacketLossSent ?? 0,
				};
			}),
		);

		return samples;
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

	getSharing(did: string): VoiceSharing {
		const sharing = { camera: false, screen: false };
		for (const { producer, source } of this.participants.get(did)?.producers.values() ?? []) {
			if (producer.kind !== "video") continue;
			if (source === "camera") sharing.camera = true;
			if (source === "screen") sharing.screen = true;
		}
		return sharing;
	}

	snapshotProducers(): ProducerSnapshot[] {
		const snapshot: ProducerSnapshot[] = [];
		for (const [did, participant] of this.participants) {
			for (const [producerId, entry] of participant.producers) {
				snapshot.push({
					did,
					producerId,
					kind: entry.producer.kind,
					source: entry.source,
					paused: entry.producer.paused,
				});
			}
		}
		return snapshot;
	}

	admit(did: string): void {
		this.assertOpen();
		this.ensureParticipant(did);
	}

	async createTransport(did: string, direction: TransportDirection): Promise<WebRtcTransport> {
		this.assertOpen();
		const participant = this.ensureParticipant(did);
		const slot = await this.slotFor(did, participant);
		const transport = await slot.router.createWebRtcTransport({
			...slot.webRtcTransportOptions,
			appData: { did, direction },
		});

		if (direction === "send") {
			await transport.setMaxIncomingBitrate(SEND_MAX_INCOMING_BITRATE);
		}

		if (this.participants.get(did) !== participant) {
			transport.close();
			throw new Error(`${did} left room ${this.channelRef} while its transport was being created`);
		}

		participant.transports.set(transport.id, transport);
		transport.on("dtlsstatechange", (state) => {
			if (state === "closed" || state === "failed") {
				participant.transports.delete(transport.id);
				transport.close();
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
		const participant = this.getParticipant(did);
		const transport = this.getTransport(did, transportId);
		const startPaused = silencesProducer(participant.voice, options.kind, options.source);

		const producer = await transport.produce({
			kind: options.kind,
			rtpParameters: options.rtpParameters,
			paused: startPaused,
			...(isScreenVideo(options.kind, options.source)
				? { keyFrameRequestDelay: SCREEN_KEYFRAME_REQUEST_DELAY_MS }
				: {}),
		});

		if (this.participants.get(did) !== participant) {
			producer.close();
			throw new Error(`${did} left room ${this.channelRef} while its producer was being created`);
		}

		participant.producers.set(producer.id, { producer, source: options.source });
		this.producerIndex.set(producer.id, { did, source: options.source });

		producer.on("transportclose", () => {
			this.forgetProducer(did, producer.id);
		});

		const home = participant.slot ?? this.primary;

		for (const slot of this.slots) {
			if (slot !== home) this.pipe(producer.id, home, slot);
		}

		if (isMicProducer(options.kind, options.source)) {
			await this.primary.piped.get(producer.id);
			await this.audioLevelObserver.addProducer({ producerId: producer.id });
		}

		this.emit("producer-added", {
			did,
			producerId: producer.id,
			kind: options.kind,
			source: options.source,
			paused: producer.paused,
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
		const participant = this.getParticipant(did);
		const transport = this.getTransport(did, transportId);
		const slot = participant.slot ?? this.primary;

		await slot.piped.get(options.producerId);

		if (this.isScreenVideoProducer(options.producerId) && !slot.router.canConsume(options)) {
			this.reportCodecUnsupported(options.producerId);
			throw new Error(
				`${did} cannot decode the codec of screen share ${options.producerId} in room ${this.channelRef}`,
			);
		}

		const consumer = await transport.consume({
			producerId: options.producerId,
			rtpCapabilities: options.rtpCapabilities,
			paused: true,
		});

		if (this.isScreenVideoProducer(options.producerId)) {
			await consumer.setPriority(SCREEN_CONSUMER_PRIORITY);
		}

		if (this.participants.get(did) !== participant) {
			consumer.close();
			throw new Error(`${did} left room ${this.channelRef} while its consumer was being created`);
		}

		participant.consumers.set(consumer.id, consumer);
		consumer.on("transportclose", () => this.forgetConsumer(participant, consumer.id));
		consumer.on("producerclose", () => this.forgetConsumer(participant, consumer.id));

		return consumer;
	}

	async resumeConsumer(did: string, consumerId: string): Promise<void> {
		const participant = this.getParticipant(did);
		const consumer = this.getConsumer(did, consumerId);
		if (participant.viewerPaused.has(consumerId)) {
			return;
		}
		await this.resumeUnlessDeafened(participant, consumer);
	}

	async setConsumerPreference(
		did: string,
		consumerId: string,
		preference: ConsumerPreference,
	): Promise<void> {
		const participant = this.getParticipant(did);
		const consumer = this.getConsumer(did, consumerId);

		if (hasLayers(consumer)) {
			await consumer.setPreferredLayers({
				spatialLayer: preference.spatialLayer,
				...(preference.temporalLayer === undefined
					? {}
					: { temporalLayer: preference.temporalLayer }),
			});
		}

		if (preference.paused) {
			participant.viewerPaused.add(consumerId);
			if (!consumer.paused) await consumer.pause();
			return;
		}

		participant.viewerPaused.delete(consumerId);
		if (consumer.paused) await this.resumeUnlessDeafened(participant, consumer);
	}

	private async resumeUnlessDeafened(
		participant: ParticipantRecord,
		consumer: Consumer,
	): Promise<void> {
		if (isDeafenable(consumer.kind) && effectiveVoice(participant.voice).deafened) {
			return;
		}
		await consumer.resume();
		if (consumer.kind === "video") {
			await consumer.requestKeyFrame();
		}
	}

	async setSelfState(did: string, patch: VoicePatch): Promise<void> {
		await this.applyVoiceState(did, "self", patch);
	}

	setSpeaking(did: string, speaking: boolean): void {
		const participant = this.getParticipant(did);
		const wasSpeaking = this.isSpeaking(did);
		forgetSpeaker(this.speakingTracker, did);
		const next = speaking && !effectiveVoice(participant.voice).muted;
		this.clientSpeaking.set(did, next);
		if (next !== wasSpeaking) this.emit("speaking-changed", { did, speaking: next });
	}

	async setServerState(did: string, patch: VoicePatch): Promise<void> {
		const enforced = this.moderation.get(did) ?? { serverMuted: false, serverDeafened: false };
		if (patch.muted !== undefined) enforced.serverMuted = patch.muted;
		if (patch.deafened !== undefined) enforced.serverDeafened = patch.deafened;

		if (enforced.serverMuted || enforced.serverDeafened) this.moderation.set(did, enforced);
		else this.moderation.delete(did);

		if (!this.participants.has(did)) {
			this.emit("voice-state-changed", {
				did,
				origin: "server",
				muted: enforced.serverMuted,
				deafened: enforced.serverDeafened,
				...enforced,
			});
			return;
		}

		await this.applyVoiceState(did, "server", patch);
	}

	private async applyVoiceState(
		did: string,
		origin: VoiceStateOrigin,
		patch: VoicePatch,
	): Promise<void> {
		const participant = this.getParticipant(did);
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

		if (after.muted) this.stopSpeaking(did);

		if (patch.muted !== undefined) {
			for (const { producer, source } of participant.producers.values()) {
				const silenced = silencesProducer(participant.voice, producer.kind, source);
				if (producer.paused === silenced) continue;
				await (silenced ? producer.pause() : producer.resume());
			}
		}

		if (after.deafened !== before.deafened) {
			for (const consumer of participant.consumers.values()) {
				if (!isDeafenable(consumer.kind)) continue;
				if (!after.deafened && participant.viewerPaused.has(consumer.id)) continue;
				await (after.deafened ? consumer.pause() : consumer.resume());
			}
		}

		this.emit("voice-state-changed", { did, origin, ...after });
	}

	async leave(did: string, reason?: ParticipantLeftReason): Promise<void> {
		const participant = this.participants.get(did);
		if (!participant) {
			return;
		}

		this.releaseMedia(participant);
		this.participants.delete(did);
		this.releaseSlot(did, participant);
		this.stopSpeaking(did);
		this.clientSpeaking.delete(did);
		this.emit("participant-left", { did, ...(reason ? { reason } : {}) });
	}

	private async slotFor(did: string, participant: ParticipantRecord): Promise<RouterSlot> {
		if (participant.slot) {
			return participant.slot;
		}

		const lightest = this.lightestSlot();
		const slot =
			lightest.members.size < this.participantsPerRouter || !this.canAddSlot()
				? lightest
				: await this.addSlot().catch(() => this.lightestSlot());

		if (participant.slot) {
			return participant.slot;
		}

		participant.slot = slot;
		slot.members.add(did);

		return slot;
	}

	private lightestSlot(): RouterSlot {
		return this.slots.reduce((best, slot) => (slot.members.size < best.members.size ? slot : best));
	}

	private canAddSlot(): boolean {
		return this.extraRouter !== undefined && this.slots.length < this.maxRouters;
	}

	private addSlot(): Promise<RouterSlot> {
		if (this.addingSlot) {
			return this.addingSlot;
		}

		const source = this.extraRouter;

		if (!source) {
			return Promise.resolve(this.lightestSlot());
		}

		const busy = this.slots.flatMap((slot) => (slot.worker === undefined ? [] : [slot.worker]));

		this.addingSlot = source(busy)
			.then((extra) => {
				if (this.closed) {
					extra.router.close();

					throw new Error(`room ${this.channelRef} is closed`);
				}

				const slot: RouterSlot = { ...extra, members: new Set(), piped: new Map() };

				this.slots.push(slot);
				extra.router.on("workerclose", () => this.emit("router-lost"));

				for (const [producerId] of this.producerIndex) {
					const home = this.homeOf(producerId);

					if (home) this.pipe(producerId, home, slot);
				}

				return slot;
			})
			.finally(() => {
				this.addingSlot = null;
			});

		return this.addingSlot;
	}

	private homeOf(producerId: string): RouterSlot | null {
		const owner = this.producerIndex.get(producerId);

		if (!owner) {
			return null;
		}

		return this.participants.get(owner.did)?.slot ?? this.primary;
	}

	private pipe(producerId: string, from: RouterSlot, to: RouterSlot): void {
		const piping = from.router
			.pipeToRouter({ producerId, router: to.router })
			.then(() => {})
			.catch(() => {});

		to.piped.set(producerId, piping);
	}

	private releaseSlot(did: string, participant: ParticipantRecord): void {
		const slot = participant.slot;

		participant.slot = null;

		if (!slot) {
			return;
		}

		slot.members.delete(did);

		if (slot === this.primary || slot.members.size > 0) {
			return;
		}

		this.slots.splice(this.slots.indexOf(slot), 1);
		slot.router.close();
	}

	dropMedia(did: string): void {
		const participant = this.participants.get(did);
		if (!participant) {
			return;
		}

		const producers = [...participant.producers].map(([producerId, { source }]) => ({
			producerId,
			source,
		}));
		this.releaseMedia(participant);
		this.stopSpeaking(did);
		for (const { producerId, source } of producers) {
			this.emit("producer-removed", { did, producerId, source });
		}
	}

	private releaseMedia(participant: ParticipantRecord): void {
		for (const consumer of participant.consumers.values()) {
			consumer.close();
		}
		participant.consumers.clear();
		participant.viewerPaused.clear();

		for (const { producer } of participant.producers.values()) {
			producer.close();
			this.producerIndex.delete(producer.id);
			for (const slot of this.slots) {
				slot.piped.delete(producer.id);
			}
			this.codecUnsupportedReported.delete(producer.id);
		}
		participant.producers.clear();

		for (const transport of participant.transports.values()) {
			transport.close();
		}
		participant.transports.clear();
	}

	private isSpeaking(did: string): boolean {
		return this.clientSpeaking.get(did) ?? this.speakingTracker.get(did)?.speaking ?? false;
	}

	private stopSpeaking(did: string): void {
		const wasSpeaking = this.isSpeaking(did);
		forgetSpeaker(this.speakingTracker, did);
		if (this.clientSpeaking.has(did)) this.clientSpeaking.set(did, false);
		if (wasSpeaking) this.emit("speaking-changed", { did, speaking: false });
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		if (this.speakingSettleTimer) {
			clearTimeout(this.speakingSettleTimer);
			this.speakingSettleTimer = null;
		}
		for (const did of [...this.participants.keys()]) {
			await this.leave(did, "channelGone");
		}
		this.audioLevelObserver.close();
		for (const slot of this.slots) {
			slot.router.close();
		}
	}

	private ensureParticipant(did: string): ParticipantRecord {
		let participant = this.participants.get(did);
		if (!participant) {
			const enforced = this.moderation.get(did);
			participant = {
				slot: null,
				transports: new Map(),
				producers: new Map(),
				consumers: new Map(),
				viewerPaused: new Set(),
				voice: {
					...SILENT,
					serverMuted: enforced?.serverMuted ?? false,
					serverDeafened: enforced?.serverDeafened ?? false,
				},
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

	private getConsumer(did: string, consumerId: string): Consumer {
		const consumer = this.getParticipant(did).consumers.get(consumerId);
		if (!consumer) {
			throw new Error(`no consumer ${consumerId} for ${did} in room ${this.channelRef}`);
		}
		return consumer;
	}

	private forgetConsumer(participant: ParticipantRecord, consumerId: string): void {
		participant.consumers.delete(consumerId);
		participant.viewerPaused.delete(consumerId);
	}

	private isScreenVideoProducer(producerId: string): boolean {
		const owner = this.producerIndex.get(producerId);
		if (!owner) return false;
		const entry = this.participants.get(owner.did)?.producers.get(producerId);
		return entry !== undefined && isScreenVideo(entry.producer.kind, entry.source);
	}

	private reportCodecUnsupported(producerId: string): void {
		const owner = this.producerIndex.get(producerId);
		if (!owner || this.codecUnsupportedReported.has(producerId)) return;
		this.codecUnsupportedReported.add(producerId);
		this.emit("codec-unsupported", { did: owner.did, producerId });
	}

	private forgetProducer(did: string, producerId: string): void {
		const participant = this.participants.get(did);
		const entry = participant?.producers.get(producerId);
		if (participant && entry) {
			participant.producers.delete(producerId);
			this.producerIndex.delete(producerId);
			for (const slot of this.slots) {
				slot.piped.delete(producerId);
			}
			this.codecUnsupportedReported.delete(producerId);
			this.emit("producer-removed", { did, producerId, source: entry.source });
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
				.filter((did): did is string => did !== undefined && !this.clientSpeaking.has(did));
			this.tickSpeaking(activeDids);
		});
		this.audioLevelObserver.on("silence", () => this.tickSpeaking([]));
	}

	private tickSpeaking(activeDids: string[]): void {
		if (this.speakingSettleTimer) {
			clearTimeout(this.speakingSettleTimer);
			this.speakingSettleTimer = null;
		}

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

		this.armSpeakingSettle();
	}

	private armSpeakingSettle(): void {
		if (this.closed || this.speakingSettleTimer) return;

		let pending = false;
		for (const entry of this.speakingTracker.values()) {
			if (entry.speaking) {
				pending = true;
				break;
			}
		}
		if (!pending) return;

		this.speakingSettleTimer = setTimeout(() => {
			this.speakingSettleTimer = null;
			this.tickSpeaking([]);
		}, this.speakingDebounceMs);
		this.speakingSettleTimer.unref?.();
	}
}
