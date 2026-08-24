import { describe, expect, it } from "vitest";
import { KeyedWorkQueue } from "./queue.js";

const deferred = () => {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
};

describe("KeyedWorkQueue", () => {
	it("runs a key once and settles idle", async () => {
		const runs: string[] = [];
		const queue = new KeyedWorkQueue(async (key) => void runs.push(key), { concurrency: 2 });

		queue.push("a");
		await queue.onIdle();

		expect(runs).toEqual(["a"]);
	});

	it("re-runs a key that was pushed while it was running", async () => {
		const runs: string[] = [];
		const gate = deferred();
		const queue = new KeyedWorkQueue(
			async (key) => {
				runs.push(key);
				if (runs.length === 1) await gate.promise;
			},
			{ concurrency: 2 },
		);

		queue.push("a");
		await Promise.resolve();
		await Promise.resolve();
		queue.push("a");
		gate.resolve();
		await queue.onIdle();

		expect(runs).toEqual(["a", "a"]);
	});

	it("never overlaps two runs of the same key", async () => {
		let running = 0;
		let overlapped = false;
		const queue = new KeyedWorkQueue(
			async () => {
				running += 1;
				if (running > 1) overlapped = true;
				await new Promise((resolve) => setTimeout(resolve, 5));
				running -= 1;
			},
			{ concurrency: 4 },
		);

		queue.push("a");
		queue.push("a");
		queue.push("a");
		await queue.onIdle();

		expect(overlapped).toBe(false);
	});

	it("collapses several pushes during one run into a single re-run", async () => {
		const runs: string[] = [];
		const gate = deferred();
		const queue = new KeyedWorkQueue(
			async (key) => {
				runs.push(key);
				if (runs.length === 1) await gate.promise;
			},
			{ concurrency: 2 },
		);

		queue.push("a");
		await Promise.resolve();
		await Promise.resolve();
		queue.push("a");
		queue.push("a");
		queue.push("a");
		gate.resolve();
		await queue.onIdle();

		expect(runs).toEqual(["a", "a"]);
	});

	it("keeps onIdle pending until the coalesced re-run finishes", async () => {
		const order: string[] = [];
		const gate = deferred();
		const queue = new KeyedWorkQueue(
			async () => {
				const attempt = order.filter((entry) => entry.startsWith("run")).length + 1;
				order.push(`run${attempt}`);
				if (attempt === 1) await gate.promise;
			},
			{ concurrency: 2 },
		);

		queue.push("a");
		await Promise.resolve();
		await Promise.resolve();
		queue.push("a");
		const idle = queue.onIdle().then(() => void order.push("idle"));
		gate.resolve();
		await idle;

		expect(order).toEqual(["run1", "run2", "idle"]);
	});

	it("forgets a key that was pushed while running once the queue stops", async () => {
		const runs: string[] = [];
		const gate = deferred();
		const queue = new KeyedWorkQueue(
			async (key) => {
				runs.push(key);
				if (runs.length === 1) await gate.promise;
			},
			{ concurrency: 2 },
		);

		queue.push("a");
		await Promise.resolve();
		await Promise.resolve();
		queue.push("a");
		queue.stop();
		gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(runs).toEqual(["a"]);
	});

	it("reports an error without losing the rest of the queue", async () => {
		const failures: string[] = [];
		const runs: string[] = [];
		const queue = new KeyedWorkQueue(
			async (key) => {
				runs.push(key);
				if (key === "a") throw new Error("boom");
			},
			{ concurrency: 1, onError: (key) => void failures.push(key) },
		);

		queue.push("a");
		queue.push("b");
		await queue.onIdle();

		expect(failures).toEqual(["a"]);
		expect(runs).toEqual(["a", "b"]);
	});

	it("runs distinct keys up to the concurrency limit", async () => {
		let running = 0;
		let peak = 0;
		const queue = new KeyedWorkQueue(
			async () => {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 5));
				running -= 1;
			},
			{ concurrency: 2 },
		);

		queue.pushAll(["a", "b", "c", "d"]);
		await queue.onIdle();

		expect(peak).toBe(2);
	});
});
