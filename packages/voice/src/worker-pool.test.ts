import { describe, expect, it, vi } from "vitest";
import { asWorker, createFakeWorker } from "./mock-mediasoup.js";
import { WorkerPool } from "./worker-pool.js";

function fakeWorkerFactory(options: { autoExit?: boolean } = {}) {
	let pid = 10_000;
	const workers: ReturnType<typeof createFakeWorker>[] = [];
	const create = vi.fn(async () => {
		pid += 1;
		const worker = createFakeWorker(pid, options);
		workers.push(worker);
		return asWorker(worker);
	});
	return { create, workers };
}

function settled(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
	]);
}

describe("WorkerPool", () => {
	it("creates exactly workerCount workers", async () => {
		const { create } = fakeWorkerFactory();
		const pool = await WorkerPool.create({ workerCount: 3, createWorker: create });
		expect(pool.size).toBe(3);
		expect(create).toHaveBeenCalledTimes(3);
	});

	it("reports each worker's CPU time in seconds", async () => {
		const { create } = fakeWorkerFactory();
		const pool = await WorkerPool.create({ workerCount: 2, createWorker: create });

		expect(await pool.usage()).toEqual([
			{ worker: 0, cpuSeconds: 2 },
			{ worker: 1, cpuSeconds: 2 },
		]);
	});

	it("round robins router creation across workers", async () => {
		const { create, workers } = fakeWorkerFactory();
		const pool = await WorkerPool.create({ workerCount: 2, createWorker: create });

		await pool.createRouter({ mediaCodecs: [] });
		await pool.createRouter({ mediaCodecs: [] });
		await pool.createRouter({ mediaCodecs: [] });

		expect(workers[0]?.createRouter).toHaveBeenCalledTimes(2);
		expect(workers[1]?.createRouter).toHaveBeenCalledTimes(1);
	});

	it("replaces a dead worker with a freshly created one and keeps the pool size", async () => {
		const { create, workers } = fakeWorkerFactory();
		const pool = await WorkerPool.create({ workerCount: 2, createWorker: create });

		const died: unknown[] = [];
		const restarted: unknown[] = [];
		pool.on("worker-died", (event) => died.push(event));
		pool.on("worker-restarted", (event) => restarted.push(event));

		workers[0]?.emit("died", new Error("boom"));
		await new Promise((resolve) => setImmediate(resolve));

		expect(died).toEqual([{ pid: 10_001, error: new Error("boom") }]);
		expect(restarted).toEqual([{ pid: 10_003 }]);
		expect(pool.size).toBe(2);
		expect(create).toHaveBeenCalledTimes(3);
	});

	it("gives each worker a WebRtcServer on its own port", async () => {
		const { create, workers } = fakeWorkerFactory();
		const pool = await WorkerPool.create({
			workerCount: 2,
			createWorker: create,
			webRtcServer: { listenIp: "0.0.0.0", announcedIp: "203.0.113.1", basePort: 40_000 },
		});

		expect(pool.ports).toEqual([40_000, 40_001]);
		expect(workers[1]?.createWebRtcServer).toHaveBeenCalledWith({
			listenInfos: [
				{ ip: "0.0.0.0", announcedAddress: "203.0.113.1", port: 40_001, protocol: "udp" },
				{ ip: "0.0.0.0", announcedAddress: "203.0.113.1", port: 40_001, protocol: "tcp" },
			],
			appData: { index: 1 },
		});

		const first = await pool.createRouter({ mediaCodecs: [] });
		const second = await pool.createRouter({ mediaCodecs: [] });

		expect(first.webRtcServer).toBe(await workers[0]?.createWebRtcServer.mock.results[0]?.value);
		expect(second.webRtcServer).toBe(await workers[1]?.createWebRtcServer.mock.results[0]?.value);
	});

	it("binds a replacement worker to the dead worker's port", async () => {
		const { create, workers } = fakeWorkerFactory();
		const pool = await WorkerPool.create({
			workerCount: 2,
			createWorker: create,
			webRtcServer: { listenIp: "0.0.0.0", basePort: 40_000 },
		});

		workers[0]?.emit("died", new Error("boom"));
		await new Promise((resolve) => setImmediate(resolve));

		expect(workers[2]?.createWebRtcServer).toHaveBeenCalledWith(
			expect.objectContaining({
				listenInfos: [
					expect.objectContaining({ port: 40_000, protocol: "udp" }),
					expect.objectContaining({ port: 40_000, protocol: "tcp" }),
				],
			}),
		);
		expect(pool.size).toBe(2);
	});

	it("puts a router on the worker with the fewest routers outside the avoid list", async () => {
		const { create, workers } = fakeWorkerFactory();
		const pool = await WorkerPool.create({ workerCount: 3, createWorker: create });

		const first = await pool.createRouter({ mediaCodecs: [] });
		const avoiding = await pool.createRouter({ mediaCodecs: [] }, { avoid: [1] });

		expect(first.worker).toBe(0);
		expect(avoiding.worker).toBe(2);

		first.router.close();

		const reused = await pool.createRouter({ mediaCodecs: [] }, { avoid: [1, 2] });

		expect(reused.worker).toBe(0);
		expect(workers[0]?.createRouter).toHaveBeenCalledTimes(2);
	});

	it("stops replacing workers once closed", async () => {
		const { create } = fakeWorkerFactory();
		const pool = await WorkerPool.create({ workerCount: 1, createWorker: create });
		await pool.close();
		expect(pool.size).toBe(0);
	});

	it("closes every worker exactly once", async () => {
		const { create, workers } = fakeWorkerFactory();
		const pool = await WorkerPool.create({ workerCount: 2, createWorker: create });
		await pool.close();
		expect(workers[0]?.close).toHaveBeenCalledTimes(1);
		expect(workers[1]?.close).toHaveBeenCalledTimes(1);
	});

	it("does not close a second time", async () => {
		const { create, workers } = fakeWorkerFactory();
		const pool = await WorkerPool.create({ workerCount: 2, createWorker: create });
		await pool.close();
		await pool.close();
		expect(workers[0]?.close).toHaveBeenCalledTimes(1);
		expect(workers[1]?.close).toHaveBeenCalledTimes(1);
	});

	it("waits for every worker subprocess to exit before resolving", async () => {
		const { create, workers } = fakeWorkerFactory({ autoExit: false });
		const pool = await WorkerPool.create({ workerCount: 2, createWorker: create });

		const closing = pool.close();
		expect(await settled(closing)).toBe(false);

		workers[0]?.exitSubprocess();
		expect(await settled(closing)).toBe(false);

		workers[1]?.exitSubprocess();
		expect(await settled(closing)).toBe(true);
	});

	it("resolves immediately for a worker whose subprocess already exited", async () => {
		const { create, workers } = fakeWorkerFactory({ autoExit: false });
		const pool = await WorkerPool.create({ workerCount: 1, createWorker: create });
		workers[0]?.exitSubprocess();

		await expect(pool.close()).resolves.toBeUndefined();
	});

	it("kills a worker subprocess that never reports an exit", async () => {
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const { create, workers } = fakeWorkerFactory({ autoExit: false });
			const pool = await WorkerPool.create({
				workerCount: 1,
				createWorker: create,
				subprocessExitTimeoutMs: 1,
			});

			await pool.close();

			expect(kill).toHaveBeenCalledWith(workers[0]?.pid, "SIGKILL");
		} finally {
			kill.mockRestore();
		}
	});

	it("never signals an init process or itself", async () => {
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const create = vi.fn(async () =>
				asWorker(createFakeWorker(process.pid, { autoExit: false })),
			);
			const pool = await WorkerPool.create({
				workerCount: 1,
				createWorker: create,
				subprocessExitTimeoutMs: 1,
			});

			await pool.close();

			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});
});
