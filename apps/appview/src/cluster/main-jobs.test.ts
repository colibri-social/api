import { describe, expect, it, vi } from "vitest";
import { type MainJobs, mainJobsSlot } from "./main-jobs.js";

const pending = () => {
	let resolve: (jobs: MainJobs) => void = () => undefined;
	const promise = new Promise<MainJobs>((done) => {
		resolve = done;
	});

	return { promise, resolve };
};

describe("main jobs", () => {
	it("stops jobs that finish starting after the main role was released", async () => {
		const launch = pending();
		const stop = vi.fn(async () => undefined);
		const slot = mainJobsSlot(() => launch.promise);

		const starting = slot.start();
		const stopping = slot.stop();

		launch.resolve({ stop });
		await starting;
		await stopping;

		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("stops running jobs once", async () => {
		const stop = vi.fn(async () => undefined);
		const slot = mainJobsSlot(async () => ({ stop }));

		await slot.start();
		await Promise.all([slot.stop(), slot.stop()]);

		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("stops without jobs when the start failed", async () => {
		const slot = mainJobsSlot(async () => {
			throw new Error("jetstream refused");
		});

		await expect(slot.start()).rejects.toThrow("jetstream refused");
		await expect(slot.stop()).resolves.toBeUndefined();
	});
});
