import { beforeEach, describe, expect, it } from "vitest";
import { asRouter, createFakeRouter, createFakeTransport } from "./mock-mediasoup.js";
import { buildWebRtcTransportOptions, VoiceRoom } from "./room.js";

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

describe("buildWebRtcTransportOptions", () => {
	it("declares both a udp and a tcp listen info", () => {
		const options = buildWebRtcTransportOptions({ listenIp: "0.0.0.0" });
		expect(options.listenInfos).toEqual([
			{ ip: "0.0.0.0", announcedAddress: undefined, portRange: undefined, protocol: "udp" },
			{ ip: "0.0.0.0", announcedAddress: undefined, portRange: undefined, protocol: "tcp" },
		]);
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
			{ did: "did:plc:a", producerId: producer.id, kind: "audio", source: "mic" },
		]);
		expect(room.snapshotProducers()).toEqual([
			{ did: "did:plc:a", producerId: producer.id, kind: "audio", source: "mic" },
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

		expect(removed).toEqual([{ did: "did:plc:a", producerId: producer.id }]);
		expect(room.snapshotProducers()).toEqual([]);
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

describe("VoiceRoom moderation", () => {
	it("starts a mic producer paused when the participant is already muted", async () => {
		const { room } = await createRoom();
		const transport = await room.createTransport("did:plc:a", "send");
		await room.setModeration("did:plc:a", { muted: true });

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

		await room.setModeration("did:plc:a", { muted: true });
		expect(producer.paused).toBe(true);

		await room.setModeration("did:plc:a", { muted: false });
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

		await room.setModeration("did:plc:a", { muted: true });
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

		await room.setModeration("did:plc:listener", { deafened: true });
		expect(consumer.paused).toBe(true);

		await room.resumeConsumer("did:plc:listener", consumer.id);
		expect(consumer.paused).toBe(true);

		await room.setModeration("did:plc:listener", { deafened: false });
		await room.resumeConsumer("did:plc:listener", consumer.id);
		expect(consumer.paused).toBe(false);
	});

	it("emits moderation-changed with the resulting state", async () => {
		const { room } = await createRoom();
		const changes: unknown[] = [];
		room.on("moderation-changed", (event) => changes.push(event));

		await room.createTransport("did:plc:a", "send");
		await room.setModeration("did:plc:a", { muted: true });
		await room.setModeration("did:plc:a", { deafened: true });

		expect(changes).toEqual([
			{ did: "did:plc:a", muted: true, deafened: false },
			{ did: "did:plc:a", muted: true, deafened: true },
		]);
		expect(room.getModeration("did:plc:a")).toEqual({ muted: true, deafened: true });
	});

	it("reports an unmoderated default for a did that never joined", async () => {
		const { room } = await createRoom();
		expect(room.getModeration("did:plc:unknown")).toEqual({ muted: false, deafened: false });
	});
});

describe("VoiceRoom speaking detection", () => {
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

	it("removes a transport bookkeeping entry once mediasoup reports it closed", async () => {
		const { room } = await createRoom(router);
		const rawTransport = createFakeTransport();
		router.createWebRtcTransport.mockResolvedValueOnce(rawTransport);

		await room.createTransport("did:plc:a", "send");
		rawTransport.emit("dtlsstatechange", "closed");

		await expect(room.connectTransport("did:plc:a", rawTransport.id, {} as never)).rejects.toThrow(
			/no transport/,
		);
	});
});
