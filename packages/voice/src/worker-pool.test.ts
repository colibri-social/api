import { describe, expect, it, vi } from "vitest";
import { asWorker, createFakeWorker } from "./mock-mediasoup.js";
import { WorkerPool } from "./worker-pool.js";

function fakeWorkerFactory() {
	let pid = 0;
	const workers: ReturnType<typeof createFakeWorker>[] = [];
	const create = vi.fn(async () => {
		pid += 1;
		const worker = createFakeWorker(pid);
		workers.push(worker);
		return asWorker(worker);
	});
	return { create, workers };
}

describe("WorkerPool", () => {
	it("creates exactly workerCount workers", async () => {
		const { create } = fakeWorkerFactory();
		const pool = await WorkerPool.create({ workerCount: 3, createWorker: create });
		expect(pool.size).toBe(3);
		expect(create).toHaveBeenCalledTimes(3);
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

		expect(died).toEqual([{ pid: 1, error: new Error("boom") }]);
		expect(restarted).toEqual([{ pid: 3 }]);
		expect(pool.size).toBe(2);
		expect(create).toHaveBeenCalledTimes(3);
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
});
