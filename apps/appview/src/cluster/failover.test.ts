import type { HostProbe } from "@colibri-social/appview-db";
import { describe, expect, it, vi } from "vitest";
import { createFailoverWatch, decidePromotion, slotName, witnessesOf } from "./failover.js";
import type { NodeRow } from "./registry.js";

const NOW = 1_000_000;

const row = (id: string, overrides: Partial<NodeRow> = {}): NodeRow => {
	return {
		id,
		region: "eu",
		roles: ["api"],
		publicUrl: `https://${id}.test`,
		tailnetUrl: `http://${id}:3100`,
		version: "1",
		state: "active",
		connections: 0,
		activeCalls: 0,
		heartbeatAt: null,
		drainDeadline: null,
		...overrides,
	};
};

const alive = (primaryDownSince: number | null) => {
	return { node: "x", main: false, draining: false, primaryDownSince };
};

describe("witnessesOf", () => {
	it("counts only nodes without a database role that aren't parked", () => {
		const nodes = [
			row("hel-1", { roles: ["main", "api"] }),
			row("fsn-1", { roles: ["failover", "api"] }),
			row("eu-2"),
			row("us-1", { state: "down" }),
			row("eu-3", { state: "maintenance" }),
		];

		expect(witnessesOf(nodes, "fsn-1").map((node) => node.id)).toEqual(["eu-2", "us-1"]);
	});
});

describe("decidePromotion", () => {
	const decide = (selfDownSince: number | null, answers: (number | null | "silent")[]) => {
		return decidePromotion({
			selfDownSince,
			witnesses: answers.map((answer, index) => ({
				node: `n${index}`,
				answer: answer === "silent" ? null : alive(answer),
			})),
			now: NOW,
			afterMs: 60_000,
		});
	};

	it("promotes once this node and a majority of witnesses lost the primary for 60 s", () => {
		expect(decide(NOW - 60_000, [NOW - 61_000, NOW - 70_000, null]).promote).toBe(true);
	});

	it("waits while this node still reaches the primary or lost it recently", () => {
		expect(decide(null, [NOW - 70_000])).toMatchObject({ promote: false });
		expect(decide(NOW - 30_000, [NOW - 70_000])).toMatchObject({ promote: false });
	});

	it("waits without a majority, counting silent nodes against it", () => {
		expect(decide(NOW - 90_000, [NOW - 70_000, null])).toMatchObject({ promote: false });
		expect(decide(NOW - 90_000, [NOW - 70_000, "silent"])).toMatchObject({ promote: false });
		expect(decide(NOW - 90_000, [NOW - 10_000, NOW - 70_000, NOW - 80_000]).promote).toBe(true);
	});

	it("never promotes without a witness", () => {
		expect(decide(NOW - 600_000, [])).toEqual({
			promote: false,
			reason: "no other node can confirm that the primary is gone",
		});
	});
});

describe("createFailoverWatch", () => {
	const probe = (overrides: Partial<HostProbe> = {}) => {
		return async (url: string): Promise<HostProbe> => ({
			url,
			reachable: false,
			recovery: false,
			readOnly: false,
			epoch: 0,
			...overrides,
		});
	};

	const setup = (overrides: Partial<Parameters<typeof createFailoverWatch>[0]> = {}) => {
		const promote = vi.fn(async () => {});
		const onPromoted = vi.fn();
		let primaryDown: number | null = null;
		const watch = createFailoverWatch({
			nodeId: "fsn-1",
			localUrl: "postgres://u:p@postgres:5432/db",
			databaseUrl: "postgres://u:p@hel:5432,postgres:5432/db",
			afterMs: 60_000,
			primary: () => primaryDown,
			nodes: async () => [
				row("hel-1", { roles: ["main"] }),
				row("fsn-1", { roles: ["failover"] }),
				row("eu-2"),
			],
			ask: async () => alive(NOW - 90_000),
			probe: async (url) =>
				url.includes("@postgres")
					? { url, reachable: true, recovery: true, readOnly: false, epoch: 1 }
					: { url, reachable: false, recovery: false, readOnly: false, epoch: 0 },
			promote,
			onPromoted,
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			now: () => NOW,
			...overrides,
		});

		return {
			watch,
			promote,
			onPromoted,
			down: (since: number | null) => {
				primaryDown = since;
			},
		};
	};

	it("promotes the local standby once and creates slots for the other nodes", async () => {
		const { watch, promote, onPromoted, down } = setup();

		await watch.tick();
		down(NOW - 90_000);

		expect(await watch.tick()).toBe("promoted");
		expect(promote).toHaveBeenCalledWith(
			expect.objectContaining({
				nodeId: "fsn-1",
				slots: [slotName("hel-1"), slotName("eu-2")],
			}),
		);
		expect(onPromoted).toHaveBeenCalledTimes(1);
		expect(await watch.tick()).toBe("skipped");
	});

	it("backs off when a host in DATABASE_URL accepts writes again", async () => {
		const { watch, promote, down } = setup({
			probe: async (url) => ({
				url,
				reachable: true,
				recovery: url.includes("@postgres"),
				readOnly: false,
				epoch: 1,
			}),
		});

		await watch.tick();
		down(NOW - 90_000);

		expect(await watch.tick()).toBe("waiting");
		expect(promote).not.toHaveBeenCalled();
	});

	it("refuses when the local Postgres isn't a standby", async () => {
		const { watch, promote, down } = setup({ probe: probe({ reachable: false }) });

		await watch.tick();
		down(NOW - 90_000);

		expect(await watch.tick()).toBe("failed");
		expect(promote).not.toHaveBeenCalled();
	});
});
