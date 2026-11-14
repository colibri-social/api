import { describe, expect, it } from "vitest";
import {
	blocking,
	type NodeProbe,
	readDatabaseStatus,
	SWITCHOVER_MAX_LAG_BYTES,
	switchoverChecks,
} from "./db-status.js";
import type { NodeRow } from "./registry.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");

const row = (id: string, roles: NodeRow["roles"], extra: Partial<NodeRow> = {}): NodeRow => {
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
		heartbeatAt: new Date(NOW - 10_000).toISOString(),
		drainDeadline: null,
		databaseHosts: ["hel-1", "fsn-1", "postgres"],
		...extra,
	};
};

const probe = (answers: Record<string, NodeProbe | null>) => {
	return async (url: string) => {
		return answers[new URL(url.replace(/^postgres:/, "http:")).hostname] ?? null;
	};
};

const primary = (slotLag: Record<string, number>, epoch = 3): NodeProbe => {
	return { recovery: false, readOnly: false, epoch, receiver: null, replayedAt: null, slotLag };
};

const replica = (receiver: string | null = "streaming", epoch = 3): NodeProbe => {
	return {
		recovery: true,
		readOnly: true,
		epoch,
		receiver,
		replayedAt: "2026-11-14 11:59:58+00",
		slotLag: {},
	};
};

const nodes = [row("hel-1", ["main"]), row("fsn-1", ["failover"]), row("eu-2", ["api"])];

describe("readDatabaseStatus", () => {
	it("names the primary, the replicas' lag and a fenced old primary", async () => {
		const status = await readDatabaseStatus({
			databaseUrl: "postgres://u:p@hel-1:5432,fsn-1:5432/db",
			nodes: [...nodes, row("fra-1", ["failover"])],
			probe: probe({
				"hel-1": primary({ fsn_1: 4096 }, 3),
				"fsn-1": replica(),
				"fra-1": { ...primary({}, 2), readOnly: true },
			}),
		});

		expect(status.primary).toBe("hel-1");
		expect(status.nodes).toEqual([
			expect.objectContaining({ id: "hel-1", postgres: "primary", epoch: 3 }),
			expect.objectContaining({
				id: "fsn-1",
				postgres: "replica",
				streaming: true,
				lagBytes: 4096,
			}),
			expect.objectContaining({ id: "fra-1", postgres: "fenced", epoch: 2 }),
		]);
	});

	it("reports unreachable nodes and no primary", async () => {
		const status = await readDatabaseStatus({
			databaseUrl: "postgres://u:p@hel-1:5432/db",
			nodes,
			probe: probe({ "fsn-1": replica(null) }),
		});

		expect(status.primary).toBeNull();
		expect(status.nodes.map((node) => node.postgres)).toEqual(["unreachable", "replica"]);
	});
});

describe("switchoverChecks", () => {
	const status = {
		primary: "hel-1",
		nodes: [
			{
				id: "hel-1",
				postgres: "primary" as const,
				epoch: 3,
				streaming: false,
				lagBytes: null,
				replayedAt: null,
			},
			{
				id: "fsn-1",
				postgres: "replica" as const,
				epoch: 3,
				streaming: true,
				lagBytes: 0,
				replayedAt: null,
			},
		],
	};
	const input = {
		status,
		nodes,
		target: "fsn-1",
		version: "1",
		now: NOW,
		rolloutRunning: false,
		busy: null,
	};

	it("passes a healthy failover node", () => {
		expect(blocking(switchoverChecks(input), false)).toEqual([]);
	});

	it("warns about lag, a stale target and nodes that can't reach it", () => {
		const checks = switchoverChecks({
			...input,
			status: {
				...status,
				nodes: [status.nodes[0], { ...status.nodes[1], lagBytes: SWITCHOVER_MAX_LAG_BYTES + 1 }],
			} as typeof status,
			nodes: [
				row("hel-1", ["main"]),
				row("fsn-1", ["failover"], { version: "0" }),
				row("eu-2", ["api"], { databaseHosts: null }),
			],
		});
		const failed = blocking(checks, false);

		expect(failed.map((check) => check.required)).toEqual([false, false, false]);
		expect(failed.at(-1)?.detail).toMatch(/eu-2 doesn't report its DATABASE_URL/);
		expect(blocking(checks, true)).toEqual([]);
	});

	it("never lets force skip a running rollout or backup", () => {
		const checks = switchoverChecks({ ...input, rolloutRunning: true, busy: "backup" });

		expect(blocking(checks, true).map((check) => check.label)).toEqual([
			"no rollout is running",
			"no backup or other switchover is running",
		]);
	});

	it("refuses the current primary and nodes without the main or failover role", () => {
		expect(blocking(switchoverChecks({ ...input, target: "hel-1" }), true)).not.toEqual([]);
		expect(blocking(switchoverChecks({ ...input, target: "eu-2" }), true)[0]?.label).toBe(
			"eu-2 can hold the main role",
		);
	});
});
