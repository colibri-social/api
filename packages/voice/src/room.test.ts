import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asRouter, createFakeRouter, createFakeTransport } from "./mock-mediasoup.js";
import {
	buildWebRtcTransportOptions,
	mediaCodecs,
	SCREEN_KEYFRAME_REQUEST_DELAY_MS,
	VoiceRoom,
} from "./room.js";

const webRtcTransportOptions = buildWebRtcTransportOptions({ listenIp: "0.0.0.0" });

async function createRoom(rawRouter = createFakeRouter()) {
	const room = await VoiceRoom.create(
		asRouter(rawRouter),
		"at://did:plc:community/social.colibri.beta.channel/vc",
		{
			webRtcTransportOptions,
		},
	);
	return { room, rawRouter };
}

describe("mediaCodecs", () => {
	it("asks opus for inband fec and dtx", () => {
		const opus = mediaCodecs().find((codec) => codec.mimeType === "audio/opus");
		expect(opus?.parameters).toMatchObject({ useinbandfec: 1, usedtx: 1 });
	});

	it("keeps VP8 as the default video codec and offers VP9 and H264 up to 1080p", () => {
		const video = mediaCodecs().filter((codec) => codec.kind === "video");
		expect(video.map((codec) => codec.mimeType)).toEqual([
			"video/VP8",
			"video/VP9",
			"video/H264",
			"video/H264",
		]);
		expect(video[1]?.parameters).toEqual({ "profile-id": 0 });
		expect(video.slice(2).map((codec) => codec.parameters?.["profile-level-id"])).toEqual([
			"42e028",
			"640028",
		]);
		for (const codec of video) {
			expect(codec.rtcpFeedback).toContainEqual({ type: "nack", parameter: "pli" });
			expect(codec.rtcpFeedback).toContainEqual({ type: "transport-cc" });
		}
	});
});

describe("buildWebRtcTransportOptions", () => {
	it("declares both a udp and a tcp listen info", () => {
		const options = buildWebRtcTransportOptions({ listenIp: "0.0.0.0" });
		expect(options.listenInfos).toEqual([
			{ ip: "0.0.0.0", announcedAddress: undefined, portRange: undefined, protocol: "udp" },
			{ ip: "0.0.0.0", announcedAddress: undefined, portRange: undefined, protocol: "tcp" },
		]);
	});

	it("omits the initial outgoing bitrate when none is configured", () => {
		const options = buildWebRtcTransportOptions({ listenIp: "0.0.0.0" });
		expect(options.initialAvailableOutgoingBitrate).toBeUndefined();
	});

	it("carries a configured initial outgoing bitrate", () => {
		const options = buildWebRtcTransportOptions({
			listenIp: "0.0.0.0",
			initialAvailableOutgoingBitrate: 300_000,
		});
		expect(options.initialAvailableOutgoingBitrate).toBe(300_000);
	});

	it("carries the announced ip and port range through to both protocols", () => {
		const options = buildWebRtcTransportOptions({
			listenIp: "0.0.0.0",
			announcedIp: "203.0.113.1",
			rtcMinPort: 40_000,
			rtcMaxPort: 40_100,
		});
		expect(options.listenInfos).toEqual([
			{
				ip: "0.0.0.0",
				announcedAddress: "203.0.113.1",
				portRange: { min: 40_000, max: 40_100 },
				protocol: "udp",
			},
			{
				ip: "0.0.0.0",
				announcedAddress: "203.0.113.1",
				portRange: { min: 40_000, max: 40_100 },
				protocol: "tcp",
			},
		]);
	});
});

describe("VoiceRoom", () => {
	it("emits participant-joined the first time a did creates a transport", async () => {
		const { room } = await createRoom();
		const joined: string[] = [];
		room.on("participant-joined", ({ did }) => joined.push(did));

		await room.createTransport("did:plc:a", "send");
		await room.createTransport("did:plc:a", "recv");

		expect(joined).toEqual(["did:plc:a"]);
		expect(room.hasParticipant("did:plc:a")).toBe(true);
	});

	it("produces, tracks and reports producers in a snapshot", async () => {
		const { room } = await createRoom();
		const added: unknown[] = [];
		room.on("producer-added", (event) => added.push(event));

		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		expect(added).toEqual([
			{ did: "did:plc:a", producerId: producer.id, kind: "audio", source: "mic", paused: false },
		]);
		expect(room.snapshotProducers()).toEqual([
			{ did: "did:plc:a", producerId: producer.id, kind: "audio", source: "mic", paused: false },
		]);
	});

	it("registers mic producers with the audio level observer", async () => {
		const { room, rawRouter } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		expect(rawRouter.audioLevelObserver.addProducer).toHaveBeenCalledWith({
			producerId: producer.id,
		});
	});

	it("does not register a screen share audio producer with the audio level observer", async () => {
		const { room, rawRouter } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "screen",
		});

		expect(rawRouter.audioLevelObserver.addProducer).not.toHaveBeenCalled();
	});

	it("closes a producer and removes it from the snapshot", async () => {
		const { room } = await createRoom();
		const removed: unknown[] = [];
		room.on("producer-removed", (event) => removed.push(event));

		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		room.closeProducer("did:plc:a", producer.id);

		expect(removed).toEqual([{ did: "did:plc:a", producerId: producer.id, source: "mic" }]);
		expect(room.snapshotProducers()).toEqual([]);
	});

	it("reports camera and screen sharing from the participant's video producers", async () => {
		const { room } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		const produce = (kind: "audio" | "video", source: string) =>
			room.produce("did:plc:a", transport.id, { kind, rtpParameters: {} as never, source });

		await produce("audio", "mic");
		await produce("audio", "screen");
		expect(room.getSharing("did:plc:a")).toEqual({ camera: false, screen: false });

		const camera = await produce("video", "camera");
		await produce("video", "screen");
		expect(room.getSharing("did:plc:a")).toEqual({ camera: true, screen: true });

		room.closeProducer("did:plc:a", camera.id);
		expect(room.getSharing("did:plc:a")).toEqual({ camera: false, screen: true });
		expect(room.getSharing("did:plc:unknown")).toEqual({ camera: false, screen: false });
	});

	it("removes a participant and their producers on leave", async () => {
		const { room } = await createRoom();
		const left: unknown[] = [];
		room.on("participant-left", (event) => left.push(event));

		const transport = await room.createTransport("did:plc:a", "send");
		await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		await room.leave("did:plc:a");

		expect(left).toEqual([{ did: "did:plc:a" }]);
		expect(room.hasParticipant("did:plc:a")).toBe(false);
		expect(room.snapshotProducers()).toEqual([]);
	});
});

describe("VoiceRoom voice state", () => {
	it("starts a mic producer paused when the participant is already muted", async () => {
		const { room } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		await room.setServerState("did:plc:a", { muted: true });

		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		expect(producer.paused).toBe(true);
	});

	it("pauses an existing mic producer when muted and resumes it when unmuted", async () => {
		const { room } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		await room.setServerState("did:plc:a", { muted: true });
		expect(producer.paused).toBe(true);

		await room.setServerState("did:plc:a", { muted: false });
		expect(producer.paused).toBe(false);
	});

	it("does not pause a non mic producer when muted", async () => {
		const { room } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "video",
			rtpParameters: {} as never,
			source: "screen",
		});

		await room.setServerState("did:plc:a", { muted: true });
		expect(producer.paused).toBe(false);
	});

	it("pauses consumers when deafened and refuses to resume them until undeafened", async () => {
		const { room } = await createRoom();
		const sendTransport = await room.createTransport("did:plc:speaker", "send");
		const producer = await room.produce("did:plc:speaker", sendTransport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		const recvTransport = await room.createTransport("did:plc:listener", "recv");
		const consumer = await room.consume("did:plc:listener", recvTransport.id, {
			producerId: producer.id,
			rtpCapabilities: {},
		});

		await room.setServerState("did:plc:listener", { deafened: true });
		expect(consumer.paused).toBe(true);

		await room.resumeConsumer("did:plc:listener", consumer.id);
		expect(consumer.paused).toBe(true);

		await room.setServerState("did:plc:listener", { deafened: false });
		await room.resumeConsumer("did:plc:listener", consumer.id);
		expect(consumer.paused).toBe(false);
	});

	it("keeps video running for a deafened listener", async () => {
		const { room } = await createRoom();
		const sendTransport = await room.createTransport("did:plc:sharer", "send");
		const producer = await room.produce("did:plc:sharer", sendTransport.id, {
			kind: "video",
			rtpParameters: {} as never,
			source: "screen",
		});

		const recvTransport = await room.createTransport("did:plc:listener", "recv");
		const consumer = await room.consume("did:plc:listener", recvTransport.id, {
			producerId: producer.id,
			rtpCapabilities: {},
		});
		await room.setSelfState("did:plc:listener", { deafened: true });
		await room.resumeConsumer("did:plc:listener", consumer.id);
		expect(consumer.paused).toBe(false);

		await room.setSelfState("did:plc:listener", { deafened: false });
		await room.setSelfState("did:plc:listener", { deafened: true });
		expect(consumer.pause).not.toHaveBeenCalled();
	});

	it("asks for a keyframe when a video consumer resumes", async () => {
		const { room } = await createRoom();
		const sendTransport = await room.createTransport("did:plc:sharer", "send");
		const video = await room.produce("did:plc:sharer", sendTransport.id, {
			kind: "video",
			rtpParameters: {} as never,
			source: "screen",
		});
		const audio = await room.produce("did:plc:sharer", sendTransport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		const recvTransport = await room.createTransport("did:plc:viewer", "recv");
		const videoConsumer = await room.consume("did:plc:viewer", recvTransport.id, {
			producerId: video.id,
			rtpCapabilities: {},
		});
		const audioConsumer = await room.consume("did:plc:viewer", recvTransport.id, {
			producerId: audio.id,
			rtpCapabilities: {},
		});
		await room.resumeConsumer("did:plc:viewer", videoConsumer.id);
		await room.resumeConsumer("did:plc:viewer", audioConsumer.id);

		const fakeVideo = videoConsumer as unknown as { requestKeyFrame: ReturnType<typeof vi.fn> };
		const fakeAudio = audioConsumer as unknown as { requestKeyFrame: ReturnType<typeof vi.fn> };
		expect(fakeVideo.requestKeyFrame).toHaveBeenCalledTimes(1);
		expect(fakeAudio.requestKeyFrame).not.toHaveBeenCalled();
	});

	it("spaces keyframe requests for screen shares only", async () => {
		const { room } = await createRoom();
		const sendTransport = await room.createTransport("did:plc:sharer", "send");
		const produce = (sendTransport as unknown as { produce: ReturnType<typeof vi.fn> }).produce;
		await room.produce("did:plc:sharer", sendTransport.id, {
			kind: "video",
			rtpParameters: {} as never,
			source: "screen",
		});
		await room.produce("did:plc:sharer", sendTransport.id, {
			kind: "video",
			rtpParameters: {} as never,
			source: "camera",
		});

		expect(produce.mock.calls[0]?.[0]).toMatchObject({
			keyFrameRequestDelay: SCREEN_KEYFRAME_REQUEST_DELAY_MS,
		});
		expect(produce.mock.calls[1]?.[0]).not.toHaveProperty("keyFrameRequestDelay");
	});

	it("emits voice-state-changed with the resulting state and its origin", async () => {
		const { room } = await createRoom();
		const changes: unknown[] = [];
		room.on("voice-state-changed", (event) => changes.push(event));

		await room.createTransport("did:plc:a", "send");
		await room.setServerState("did:plc:a", { muted: true });
		await room.setSelfState("did:plc:a", { deafened: true });

		expect(changes).toEqual([
			{
				did: "did:plc:a",
				origin: "server",
				muted: true,
				deafened: false,
				serverMuted: true,
				serverDeafened: false,
			},
			{
				did: "did:plc:a",
				origin: "self",
				muted: true,
				deafened: true,
				serverMuted: true,
				serverDeafened: false,
			},
		]);
		expect(room.getVoiceState("did:plc:a")).toEqual({
			muted: true,
			deafened: true,
			serverMuted: true,
			serverDeafened: false,
		});
	});

	it("reports a silent default for a did that never joined", async () => {
		const { room } = await createRoom();
		expect(room.getVoiceState("did:plc:unknown")).toEqual({
			muted: false,
			deafened: false,
			serverMuted: false,
			serverDeafened: false,
		});
	});

	it("does not let a participant unmute themselves out of a server mute", async () => {
		const { room } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		await room.setServerState("did:plc:a", { muted: true });
		await room.setSelfState("did:plc:a", { muted: false });

		expect(producer.paused).toBe(true);
		expect(room.getVoiceState("did:plc:a")).toMatchObject({ muted: true, serverMuted: true });
	});

	it("keeps a self mute after a moderator lifts a server mute", async () => {
		const { room } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		await room.setSelfState("did:plc:a", { muted: true });
		await room.setServerState("did:plc:a", { muted: true });
		await room.setServerState("did:plc:a", { muted: false });

		expect(producer.paused).toBe(true);
		expect(room.getVoiceState("did:plc:a")).toMatchObject({ muted: true, serverMuted: false });
	});
});

describe("VoiceRoom speaking detection", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("emits speaking-changed start immediately and stop after the debounce window", async () => {
		const rawRouter = createFakeRouter();
		const room = await VoiceRoom.create(asRouter(rawRouter), "channel", {
			webRtcTransportOptions,
			speakingDebounceMs: 1_000,
		});
		const events: unknown[] = [];
		room.on("speaking-changed", (event) => events.push(event));

		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		rawRouter.audioLevelObserver.emit("volumes", [{ producer: { id: producer.id }, volume: -20 }]);
		expect(events).toEqual([{ did: "did:plc:a", speaking: true }]);

		rawRouter.audioLevelObserver.emit("silence");
		expect(events).toEqual([{ did: "did:plc:a", speaking: true }]);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(events).toEqual([
			{ did: "did:plc:a", speaking: true },
			{ did: "did:plc:a", speaking: false },
		]);
	});

	it("stops a speaker that leaves mid-word", async () => {
		const rawRouter = createFakeRouter();
		const room = await VoiceRoom.create(asRouter(rawRouter), "channel", {
			webRtcTransportOptions,
			speakingDebounceMs: 1_000,
		});
		const events: unknown[] = [];
		room.on("speaking-changed", (event) => events.push(event));

		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		rawRouter.audioLevelObserver.emit("volumes", [{ producer: { id: producer.id }, volume: -20 }]);
		await room.leave("did:plc:a");

		expect(events).toEqual([
			{ did: "did:plc:a", speaking: true },
			{ did: "did:plc:a", speaking: false },
		]);
	});
});

describe("VoiceRoom transport lifecycle", () => {
	let router: ReturnType<typeof createFakeRouter>;

	beforeEach(() => {
		router = createFakeRouter();
	});

	it("rejects work against a closed room", async () => {
		const { room } = await createRoom(router);
		await room.close();
		await expect(room.createTransport("did:plc:a", "send")).rejects.toThrow(/closed/);
	});

	it("closes a transport mediasoup reports as dead, and drops its producers", async () => {
		const { room } = await createRoom(router);
		const rawTransport = createFakeTransport();
		router.createWebRtcTransport.mockResolvedValueOnce(rawTransport);

		const transport = await room.createTransport("did:plc:a", "send");
		await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		rawTransport.emit("dtlsstatechange", "closed");

		expect(rawTransport.close).toHaveBeenCalled();
		expect(room.snapshotProducers()).toEqual([]);
		await expect(room.connectTransport("did:plc:a", rawTransport.id, {} as never)).rejects.toThrow(
			/no transport/,
		);
	});

	it("closes a transport that fails ice, not only one that closes", async () => {
		const { room } = await createRoom(router);
		const rawTransport = createFakeTransport();
		router.createWebRtcTransport.mockResolvedValueOnce(rawTransport);

		await room.createTransport("did:plc:a", "send");
		rawTransport.emit("dtlsstatechange", "failed");

		expect(rawTransport.close).toHaveBeenCalled();
	});
});

describe("VoiceRoom moderation", () => {
	it("keeps a server mute across a rejoin", async () => {
		const { room } = await createRoom();
		await room.createTransport("did:plc:a", "send");
		await room.setServerState("did:plc:a", { muted: true });

		await room.leave("did:plc:a");
		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		expect(room.getVoiceState("did:plc:a")).toMatchObject({ muted: true, serverMuted: true });
		expect(producer.paused).toBe(true);
	});

	it("pauses every audio producer a mute applies to, whatever its source", async () => {
		const { room } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		const screenAudio = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "screen",
		});

		await room.setServerState("did:plc:a", { muted: true });

		expect(screenAudio.paused).toBe(true);
	});

	it("records a mute for someone who has joined but carries no media yet", async () => {
		const { room } = await createRoom();
		await room.setServerState("did:plc:a", { muted: true });

		const transport = await room.createTransport("did:plc:a", "send");
		const producer = await room.produce("did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		expect(producer.paused).toBe(true);
	});
});

describe("VoiceRoom participant creation", () => {
	it("does not invent a participant from a frame naming an unknown transport", async () => {
		const { room } = await createRoom();
		const joined: string[] = [];
		room.on("participant-joined", ({ did }) => joined.push(did));

		await expect(
			room.consume("did:plc:a", "nope", { producerId: "x", rtpCapabilities: {} as never }),
		).rejects.toThrow(/no participant/);

		expect(joined).toEqual([]);
		expect(room.hasParticipant("did:plc:a")).toBe(false);
	});
});
