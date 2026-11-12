import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMonitoringSync, monitoringFingerprint } from "./monitoring-sync.js";

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "monitoring-sync-"));
	await mkdir(join(directory, "dashboards"));
	await writeFile(join(directory, "dashboards", "cluster.json"), "{}");
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("monitoringFingerprint", () => {
	it("changes with a file, a new file or a setting, and ignores key order", async () => {
		const base = await monitoringFingerprint([directory], { a: 1, b: 2 });

		expect(await monitoringFingerprint([directory], { b: 2, a: 1 })).toBe(base);
		expect(await monitoringFingerprint([directory], { a: 1, b: 3 })).not.toBe(base);

		await writeFile(join(directory, "dashboards", "cluster.json"), '{"panels":[]}');

		const edited = await monitoringFingerprint([directory], { a: 1, b: 2 });

		expect(edited).not.toBe(base);

		await writeFile(join(directory, "dashboards", "hosts.json"), "{}");

		expect(await monitoringFingerprint([directory], { a: 1, b: 2 })).not.toBe(edited);
		expect(await monitoringFingerprint([join(directory, "missing")], {})).toBe(
			await monitoringFingerprint([], {}),
		);
	});
});

describe("createMonitoringSync", () => {
	const setup = (overrides: { stored?: string | null; target?: string | null; ok?: boolean }) => {
		let stored = overrides.stored ?? null;
		const deploy = vi.fn(async () => overrides.ok ?? true);
		const sync = createMonitoringSync({
			fingerprint: async () => "new",
			stored: async () => stored,
			store: async (value) => {
				stored = value;
			},
			target: async () => (overrides.target === undefined ? "lau-1" : overrides.target),
			deploy,
			log: { info: vi.fn(), warn: vi.fn() },
		});

		return { sync, deploy, stored: () => stored };
	};

	it("redeploys to the monitoring node when the fingerprint changed, then remembers it", async () => {
		const { sync, deploy, stored } = setup({ stored: "old" });

		expect(await sync.sync()).toBe("redeployed");
		expect(deploy).toHaveBeenCalledWith("lau-1");
		expect(stored()).toBe("new");
		expect(await sync.sync()).toBe("unchanged");
		expect(deploy).toHaveBeenCalledTimes(1);
	});

	it("keeps the old fingerprint when the deploy fails, so the next start tries again", async () => {
		const { sync, stored } = setup({ stored: "old", ok: false });

		expect(await sync.sync()).toBe("failed");
		expect(stored()).toBe("old");
	});

	it("does nothing before monitoring was deployed once", async () => {
		const { sync, deploy } = setup({ target: null });

		expect(await sync.sync()).toBe("skipped");
		expect(deploy).not.toHaveBeenCalled();
	});

	it("runs one sync at a time", async () => {
		const { sync, deploy } = setup({ stored: "old" });

		await Promise.all([sync.sync(), sync.sync()]);

		expect(deploy).toHaveBeenCalledTimes(1);
	});
});
