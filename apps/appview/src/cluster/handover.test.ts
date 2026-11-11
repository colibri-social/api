import { describe, expect, it, vi } from "vitest";
import { createHandover, shouldDefer, takeoverCandidate } from "./handover.js";
import type { NodeRow } from "./registry.js";

const NOW = Date.parse("2026-11-11T12:00:00Z");

const row = (id: string, overrides: Partial<NodeRow> = {}): NodeRow => {
	return {
		id,
		region: "eu",
		roles: ["api"],
		publicUrl: `https://${id}.test`,
		tailnetUrl: `http://${id}:3100`,
		version: "2.0.0",
		state: "active",
		connections: 0,
		activeCalls: 0,
		heartbeatAt: new Date(NOW).toISOString(),
		drainDeadline: null,
		...overrides,
	};
};

describe("takeoverCandidate", () => {
	it("prefers a ready main node over a failover node and skips everything else", () => {
		const nodes = [
			row("fsn-1", { roles: ["failover", "api"] }),
			row("hel-1", { roles: ["main", "api"] }),
			row("eu-2"),
		];

		expect(takeoverCandidate(nodes, "fsn-1", "2.0.0", NOW)?.id).toBe("hel-1");
		expect(takeoverCandidate(nodes, "hel-1", "2.0.0", NOW)?.id).toBe("fsn-1");
		expect(takeoverCandidate(nodes, "hel-1", "3.0.0", NOW)).toBeNull();
		expect(
			takeoverCandidate(
				[row("fsn-1", { roles: ["failover"], state: "draining" })],
				"hel-1",
				"2.0.0",
				NOW,
			),
		).toBeNull();
	});
});

describe("createHandover", () => {
	const setup = (nodes: NodeRow[]) => {
		let clock = NOW;
		const yieldMain = vi.fn(async () => true);
		const handover = createHandover({
			registry: {
				list: async () =>
					nodes.map((node) => ({ ...node, heartbeatAt: new Date(clock).toISOString() })),
			},
			self: "fsn-1",
			version: "2.0.0",
			yieldMain,
			busy: () => false,
			log: { info: vi.fn(), warn: vi.fn() },
			now: () => clock,
			stableMs: 120_000,
		});

		return {
			handover,
			yieldMain,
			advance: (ms: number) => {
				clock += ms;
			},
		};
	};

	it("hands main back once the main node has been ready for two minutes", async () => {
		const { handover, yieldMain, advance } = setup([
			row("fsn-1", { roles: ["failover"] }),
			row("hel-1", { roles: ["main", "api"] }),
		]);

		expect(await handover.tick()).toBe("waiting");

		advance(60_000);

		expect(await handover.tick()).toBe("waiting");

		advance(60_000);

		expect(await handover.tick()).toBe("handedBack");
		expect(yieldMain).toHaveBeenCalledWith("hel-1");
	});

	it("keeps the main role while its own Postgres is the primary", async () => {
		let clock = NOW;
		const yieldMain = vi.fn(async () => true);
		const handover = createHandover({
			registry: {
				list: async () => [
					row("hel-1", { roles: ["main"], heartbeatAt: new Date(clock).toISOString() }),
				],
			},
			self: "fsn-1",
			version: "2.0.0",
			yieldMain,
			busy: () => false,
			holdsPrimary: async () => true,
			log: { info: vi.fn(), warn: vi.fn() },
			now: () => clock,
			stableMs: 1_000,
		});

		await handover.tick();
		clock += 5_000;

		expect(await handover.tick()).toBe("holdingPrimary");
		expect(yieldMain).not.toHaveBeenCalled();
	});

	it("waits for a main node on the same version", async () => {
		const { handover, yieldMain, advance } = setup([
			row("hel-1", { roles: ["main"], version: "1.9.0" }),
		]);

		await handover.tick();
		advance(300_000);

		expect(await handover.tick()).toBe("none");
		expect(yieldMain).not.toHaveBeenCalled();
	});
});

describe("shouldDefer", () => {
	const alive = (overrides: Partial<{ main: boolean; draining: boolean }> = {}) => {
		return { node: "hel-1", main: false, draining: false, ...overrides };
	};

	it("defers while a main node is up and holds the role", () => {
		expect(shouldDefer([alive({ main: true })], { unclaimedSince: null }, NOW)).toBe(true);
	});

	it("takes over when no main node answers or the main node drains", () => {
		expect(shouldDefer([null], { unclaimedSince: null }, NOW)).toBe(false);
		expect(shouldDefer([alive({ draining: true })], { unclaimedSince: null }, NOW)).toBe(false);
		expect(shouldDefer([], { unclaimedSince: null }, NOW)).toBe(false);
	});

	it("gives a starting main node 30 seconds to claim the role", () => {
		const state = { unclaimedSince: null };

		expect(shouldDefer([alive()], state, NOW)).toBe(true);
		expect(shouldDefer([alive()], state, NOW + 29_000)).toBe(true);
		expect(shouldDefer([alive()], state, NOW + 30_000)).toBe(false);
		expect(shouldDefer([alive({ main: true })], state, NOW + 31_000)).toBe(true);
		expect(state.unclaimedSince).toBeNull();
	});
});
