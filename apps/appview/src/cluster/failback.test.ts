import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseStatus } from "./db-status.js";
import { checkSwitchover, runFailback } from "./failback.js";
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

const healthy: DatabaseStatus = {
	primary: "fsn-1",
	nodes: [
		{ id: "hel-1", postgres: "replica", epoch: 2, streaming: true, lagBytes: 0, replayedAt: null },
		{
			id: "fsn-1",
			postgres: "primary",
			epoch: 2,
			streaming: false,
			lagBytes: null,
			replayedAt: null,
		},
	],
};

const fakeConnect = (answers: Record<string, Record<string, unknown>>) => {
	return async (url: string) => {
		const host = new URL(url.replace(/^postgres:/, "http:")).hostname;

		return {
			query: async () => ({ rows: [answers[host] ?? {}] }),
			end: async () => {},
		} as unknown as pg.Client;
	};
};

const deps = (
	answers: Record<string, Record<string, unknown>>,
	options: { status?: DatabaseStatus; nodes?: NodeRow[]; running?: boolean } = {},
) => {
	return {
		self: "fsn-1",
		localUrl: "postgres://u:p@127.0.0.1:1/db",
		databaseUrl: "postgres://u:p@hel-1:5432,127.0.0.1:1/db",
		nodes: async () =>
			options.nodes ?? [
				row("hel-1", ["main"]),
				row("fsn-1", ["failover"]),
				row("eu-2", ["api", "live"]),
			],
		yieldMain: vi.fn(async () => true),
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		version: "1",
		status: async () => options.status ?? healthy,
		rollouts: {
			running: () => options.running ?? false,
			rolloutPaused: vi.fn(async () => false),
			pauseRollout: vi.fn(async () => {}),
			resumeRollout: vi.fn(async () => {}),
		},
		connect: fakeConnect(answers),
		now: () => NOW,
	};
};

const primary = { "127.0.0.1": { recovery: false } };

describe("runFailback", () => {
	it("refuses when this node's Postgres isn't the primary", async () => {
		const result = await runFailback(deps({ "127.0.0.1": { recovery: true } }), undefined);

		expect(result).toEqual({ ok: false, message: "this node's Postgres isn't the primary" });
	});

	it("refuses when the target isn't streaming", async () => {
		const result = await runFailback(
			deps(primary, {
				status: {
					...healthy,
					nodes: [{ ...healthy.nodes[0], streaming: false } as DatabaseStatus["nodes"][number]],
				},
			}),
			undefined,
		);

		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/FAIL hel-1's Postgres streams from the primary/);
	});

	it("refuses a switchover to a node that can't hold the main role", async () => {
		const result = await runFailback(deps(primary), "eu-2");

		expect(result.message).toMatch(/FAIL eu-2 can hold the main role/);
	});

	it("refuses an unknown target and a node without a local Postgres", async () => {
		expect((await runFailback(deps(primary), "us-9")).message).toMatch(
			/FAIL us-9 is a registered node/,
		);
		expect((await runFailback({ ...deps({}), localUrl: null }, undefined)).ok).toBe(false);
	});

	it("refuses while a rollout runs, even with force", async () => {
		const result = await runFailback(deps(primary, { running: true }), "hel-1", { force: true });

		expect(result.message).toMatch(/FAIL no rollout is running/);
	});

	it("refuses warnings unless forced", async () => {
		const nodes = [
			row("hel-1", ["main"], { version: "0" }),
			row("fsn-1", ["failover"]),
			row("eu-2", ["api"], { databaseHosts: ["fsn-1"] }),
		];
		const result = await runFailback(deps(primary, { nodes }), "hel-1");

		expect(result.message).toMatch(/WARN hel-1 is active, heartbeating and on version 1/);
		expect(result.message).toMatch(/eu-2's DATABASE_URL lists fsn-1/);
	});

	it("pauses rollouts for the move and resumes them when it fails", async () => {
		const failing = deps(primary);

		await expect(runFailback(failing, "hel-1")).rejects.toThrow();
		expect(failing.rollouts.pauseRollout).toHaveBeenCalledTimes(1);
		expect(failing.rollouts.resumeRollout).toHaveBeenCalledTimes(1);
	});
});

describe("checkSwitchover", () => {
	it("picks the main node that isn't the primary", async () => {
		const plan = await checkSwitchover(deps(primary), undefined);

		expect(plan.target).toBe("hel-1");
		expect(plan.checks.every((check) => check.ok)).toBe(true);
	});
});
