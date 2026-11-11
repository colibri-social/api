import type { HostProbe } from "@colibri-social/appview-db";
import { describe, expect, it, vi } from "vitest";
import { createFencing, nodeDatabaseUrl, stale } from "./fencing.js";
import type { NodeRow } from "./registry.js";

const row = (id: string, roles: NodeRow["roles"]): NodeRow => {
	return {
		id,
		region: "eu",
		roles,
		publicUrl: `https://${id}.test`,
		tailnetUrl: `http://${id}:3100`,
		version: "1",
		state: "active",
		connections: 0,
		activeCalls: 0,
		heartbeatAt: null,
		drainDeadline: null,
	};
};

const probe = (url: string, overrides: Partial<HostProbe>): HostProbe => {
	return { url, reachable: true, recovery: false, readOnly: false, epoch: 1, ...overrides };
};

describe("stale", () => {
	it("flags a writable host behind a primary with a higher epoch", () => {
		expect(stale(probe("a", { epoch: 1 }), probe("b", { epoch: 2 }))).toBe(true);
		expect(stale(probe("a", { epoch: 2 }), probe("b", { epoch: 2 }))).toBe(false);
		expect(stale(probe("a", { recovery: true }), probe("b", { epoch: 2 }))).toBe(false);
		expect(stale(probe("a", { epoch: 1 }), null)).toBe(false);
	});
});

describe("nodeDatabaseUrl", () => {
	it("points the database URL at a node's tailnet address", () => {
		expect(
			nodeDatabaseUrl("postgres://u:p@postgres:5432,fsn:5432/db", row("hel-1", ["main"])),
		).toBe("postgres://u:p@hel-1:5432/db");
	});
});

describe("createFencing", () => {
	it("fences its own stale primary and rebuilds it from the other hosts", async () => {
		const fence = vi.fn(async () => {});
		const rejoin = vi.fn(async () => true);
		const fencing = createFencing({
			nodeId: "hel-1",
			localUrl: "postgres://u:p@postgres:5432/db",
			databaseUrl: "postgres://u:p@postgres:5432,fsn-1:5432/db",
			ownTailnetHost: "hel-1",
			isMain: () => false,
			nodes: async () => [],
			rejoin,
			fence,
			probe: async (url) => probe(url, { epoch: url.includes("fsn-1") ? 2 : 1 }),
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		});

		expect(await fencing.tick()).toBe("rejoining");
		expect(fence).toHaveBeenCalledWith("postgres://u:p@postgres:5432/db");
		expect(rejoin).toHaveBeenCalledWith(null, ["fsn-1"]);
		expect(await fencing.tick()).toBe("fenced");
		expect(rejoin).toHaveBeenCalledTimes(1);
	});

	it("leaves a healthy standby alone", async () => {
		const rejoin = vi.fn(async () => true);
		const fencing = createFencing({
			nodeId: "fsn-1",
			localUrl: "postgres://u:p@postgres:5432/db",
			databaseUrl: "postgres://u:p@hel-1:5432,postgres:5432/db",
			ownTailnetHost: "fsn-1",
			isMain: () => false,
			nodes: async () => [],
			rejoin,
			probe: async (url) => probe(url, { recovery: url.includes("@postgres:") }),
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		});

		expect(await fencing.tick()).toBe("healthy");
		expect(rejoin).not.toHaveBeenCalled();
	});

	it("rebuilds another node's stale primary from the main node", async () => {
		const rejoin = vi.fn(async () => true);
		const fence = vi.fn(async () => {});
		const fencing = createFencing({
			nodeId: "hel-1",
			localUrl: "postgres://u:p@postgres:5432/db",
			databaseUrl: "postgres://u:p@postgres:5432,fsn-1:5432/db",
			ownTailnetHost: "hel-1",
			isMain: () => true,
			nodes: async () => [row("hel-1", ["main"]), row("fsn-1", ["failover"])],
			rejoin,
			fence,
			probe: async (url) =>
				url.includes("@postgres")
					? probe(url, { epoch: 3 })
					: probe(url, { epoch: 2, readOnly: true }),
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		});

		await fencing.tick();

		expect(fence).not.toHaveBeenCalled();
		expect(rejoin).toHaveBeenCalledWith(expect.objectContaining({ id: "fsn-1" }), ["hel-1"]);
	});
});
