import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { runFailback } from "./failback.js";
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

const fakeConnect = (answers: Record<string, Record<string, unknown>>) => {
	return async (url: string) => {
		const host = new URL(url.replace(/^postgres:/, "http:")).hostname;

		return {
			query: async () => ({ rows: [answers[host] ?? {}] }),
			end: async () => {},
		} as unknown as pg.Client;
	};
};

const deps = (answers: Record<string, Record<string, unknown>>) => {
	return {
		self: "fsn-1",
		localUrl: "postgres://u:p@local:5432/db",
		databaseUrl: "postgres://u:p@hel-1:5432,local:5432/db",
		nodes: async () => [row("hel-1", ["main"]), row("fsn-1", ["failover"])],
		yieldMain: vi.fn(async () => true),
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		connect: fakeConnect(answers),
	};
};

describe("runFailback", () => {
	it("refuses when this node's Postgres isn't the primary", async () => {
		const result = await runFailback(deps({ local: { recovery: true } }), undefined);

		expect(result).toEqual({ ok: false, message: "this node's Postgres isn't the primary" });
	});

	it("refuses when the target isn't streaming", async () => {
		const result = await runFailback(
			deps({ local: { recovery: false, epoch: 2 }, "hel-1": { recovery: true, status: null } }),
			undefined,
		);

		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/isn't a streaming replica/);
	});

	it("refuses an unknown target and a node without a local Postgres", async () => {
		expect((await runFailback(deps({}), "us-9")).message).toBe("no other node is called us-9");
		expect((await runFailback({ ...deps({}), localUrl: null }, undefined)).ok).toBe(false);
	});
});
