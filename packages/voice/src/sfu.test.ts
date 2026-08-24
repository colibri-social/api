import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asRouter, createFakeRouter } from "./mock-mediasoup.js";
import { VoiceSfu } from "./sfu.js";
import type { WorkerPoolLike } from "./worker-pool.js";

const CHANNEL_A = "at://did:plc:community/social.colibri.beta.channel.voice/a";
const CHANNEL_B = "at://did:plc:community/social.colibri.beta.channel.voice/b";

function fakeWorkerPool(): WorkerPoolLike & { createRouter: ReturnType<typeof vi.fn> } {
	return {
		createRouter: vi.fn(async () => asRouter(createFakeRouter())),
		close: vi.fn(async () => {}),
	};
}

async function createSfu(overrides: Partial<Parameters<typeof VoiceSfu.create>[0]> = {}) {
	const workerPool = fakeWorkerPool();
	const sfu = await VoiceSfu.create({ roomGraceMs: 1_000, ...overrides }, { workerPool });
	return { sfu, workerPool };
}

describe("VoiceSfu room lifecycle", () => {
	it("creates a room lazily and reuses it for the same channel", async () => {
		const { sfu, workerPool } = await createSfu();

		await sfu.rtpCapabilities(CHANNEL_A);
		await sfu.rtpCapabilities(CHANNEL_A);

		expect(workerPool.createRouter).toHaveBeenCalledTimes(1);
	});

	it("creates independent rooms per channel", async () => {
		const { sfu, workerPool } = await createSfu();

		await sfu.rtpCapabilities(CHANNEL_A);
		await sfu.rtpCapabilities(CHANNEL_B);

		expect(workerPool.createRouter).toHaveBeenCalledTimes(2);
	});

	it("does not create a router until it is actually asked for", async () => {
		const { workerPool } = await createSfu();
		expect(workerPool.createRouter).not.toHaveBeenCalled();
	});

	it("emits room-created the first time a channel is touched", async () => {
		const { sfu } = await createSfu();
		const created: unknown[] = [];
		sfu.on("room-created", (event) => created.push(event));

		await sfu.rtpCapabilities(CHANNEL_A);
		await sfu.rtpCapabilities(CHANNEL_A);

		expect(created).toEqual([{ channel: CHANNEL_A }]);
	});
});

describe("VoiceSfu one room per did", () => {
	it("tracks which channel a did is present in", async () => {
		const { sfu } = await createSfu();
		expect(sfu.presenceOf("did:plc:a")).toBeUndefined();

		await sfu.createTransport(CHANNEL_A, "did:plc:a", "send");
		expect(sfu.presenceOf("did:plc:a")).toBe(CHANNEL_A);
	});

	it("moves a did to the new room when it joins from a second device", async () => {
		const { sfu } = await createSfu();

		await sfu.createTransport(CHANNEL_A, "did:plc:a", "send");
		const left: unknown[] = [];
		sfu.on("participant-left", (event) => left.push(event));

		await sfu.createTransport(CHANNEL_B, "did:plc:a", "send");

		expect(sfu.presenceOf("did:plc:a")).toBe(CHANNEL_B);
		expect(left).toEqual([{ channel: CHANNEL_A, did: "did:plc:a", reason: "superseded" }]);
	});

	it("does not move a did that joins the same channel again", async () => {
		const { sfu } = await createSfu();

		await sfu.createTransport(CHANNEL_A, "did:plc:a", "send");
		const left: unknown[] = [];
		sfu.on("participant-left", (event) => left.push(event));

		await sfu.createTransport(CHANNEL_A, "did:plc:a", "recv");

		expect(sfu.presenceOf("did:plc:a")).toBe(CHANNEL_A);
		expect(left).toEqual([]);
	});
});

describe("VoiceSfu worker death", () => {
	it("discards a room whose router died, so presence and the roster let go", async () => {
		const workerPool = fakeWorkerPool();
		const router = createFakeRouter();
		workerPool.createRouter.mockResolvedValue(asRouter(router));
		const sfu = await VoiceSfu.create({ roomGraceMs: 1_000 }, { workerPool });

		const closed: unknown[] = [];
		sfu.on("room-closed", (event) => closed.push(event));

		await sfu.createTransport(CHANNEL_A, "did:plc:a", "send");
		expect(sfu.presenceOf("did:plc:a")).toBe(CHANNEL_A);

		router.killWorker();
		await vi.waitFor(() => expect(closed).toEqual([{ channel: CHANNEL_A }]));

		expect(sfu.presenceOf("did:plc:a")).toBeUndefined();
		expect(sfu.listParticipants(CHANNEL_A)).toEqual([]);
	});
});

describe("VoiceSfu event forwarding", () => {
	it("forwards room events tagged with the channel", async () => {
		const { sfu } = await createSfu();
		const producerAdded: unknown[] = [];
		sfu.on("producer-added", (event) => producerAdded.push(event));

		const transport = await sfu.createTransport(CHANNEL_A, "did:plc:a", "send");
		const producer = await sfu.produce(CHANNEL_A, "did:plc:a", transport.id, {
			kind: "audio",
			rtpParameters: {} as never,
			source: "mic",
		});

		expect(producerAdded).toEqual([
			{
				channel: CHANNEL_A,
				did: "did:plc:a",
				producerId: producer.id,
				kind: "audio",
				source: "mic",
				paused: false,
			},
		]);
	});
});

describe("VoiceSfu grace period teardown", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("tears an empty room down after the grace period", async () => {
		const { sfu, workerPool } = await createSfu();
		const closed: unknown[] = [];
		sfu.on("room-closed", (event) => closed.push(event));

		await sfu.createTransport(CHANNEL_A, "did:plc:a", "send");
		await sfu.leave(CHANNEL_A, "did:plc:a");

		expect(closed).toEqual([]);

		await vi.advanceTimersByTimeAsync(1_000);

		expect(closed).toEqual([{ channel: CHANNEL_A }]);

		await sfu.rtpCapabilities(CHANNEL_A);
		expect(workerPool.createRouter).toHaveBeenCalledTimes(2);
	});

	it("cancels the grace teardown if a participant rejoins in time", async () => {
		const { sfu, workerPool } = await createSfu();
		const closed: unknown[] = [];
		sfu.on("room-closed", (event) => closed.push(event));

		await sfu.createTransport(CHANNEL_A, "did:plc:a", "send");
		await sfu.leave(CHANNEL_A, "did:plc:a");

		await vi.advanceTimersByTimeAsync(500);
		await sfu.createTransport(CHANNEL_A, "did:plc:b", "send");
		await vi.advanceTimersByTimeAsync(1_000);

		expect(closed).toEqual([]);
		expect(workerPool.createRouter).toHaveBeenCalledTimes(1);
	});
});
