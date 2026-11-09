import type { AddressInfo } from "node:net";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "./context.js";
import {
	createDrainState,
	drainGraceMs,
	hasPeers,
	SOLO_DRAIN_MS,
	waitForConnections,
} from "./drain.js";
import { createAppServer } from "./server.js";

const never = new Promise<void>(() => {});

describe("createDrainState", () => {
	it("counts a parked node as draining", () => {
		const state = createDrainState();

		state.park();

		expect(state.parked).toBe(true);
		expect(state.draining).toBe(true);
		expect(state.deadline).toBeNull();
	});

	it("starts idle and keeps the first deadline", () => {
		const state = createDrainState();
		const first = new Date("2026-11-07T12:00:00Z");

		expect(state.draining).toBe(false);

		state.begin(first);
		state.begin(new Date("2026-11-07T13:00:00Z"));

		expect(state.draining).toBe(true);
		expect(state.deadline).toEqual(first);
	});
});

describe("drainGraceMs", () => {
	it("waits the full grace period when other nodes can take the clients", () => {
		expect(drainGraceMs(120, true)).toBe(120 * 60_000);
	});

	it("waits only briefly when the node is alone", () => {
		expect(drainGraceMs(120, false)).toBe(SOLO_DRAIN_MS);
	});

	it("never waits longer than the configured grace period", () => {
		expect(drainGraceMs(0, false)).toBe(0);
	});
});

describe("waitForConnections", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("finishes as soon as the last connection leaves", async () => {
		vi.useFakeTimers();

		let open = 2;
		const result = waitForConnections({
			count: () => open,
			deadline: new Date(Date.now() + 60_000),
			skip: never,
		});

		await vi.advanceTimersByTimeAsync(3_000);

		open = 0;

		await vi.advanceTimersByTimeAsync(1_000);

		expect(await result).toBe("empty");
	});

	it("gives up at the deadline", async () => {
		vi.useFakeTimers();

		const result = waitForConnections({
			count: () => 1,
			deadline: new Date(Date.now() + 5_000),
			skip: never,
		});

		await vi.advanceTimersByTimeAsync(5_000);

		expect(await result).toBe("deadline");
	});

	it("stops waiting when the operator skips the drain", async () => {
		let skip: () => void = () => {};
		const skipped = new Promise<void>((resolve) => {
			skip = resolve;
		});
		const result = waitForConnections({
			count: () => 1,
			deadline: new Date(Date.now() + 60_000),
			skip: skipped,
		});

		skip();

		expect(await result).toBe("skipped");
	});
});

describe("hasPeers", () => {
	let database: TestDatabase;
	const now = new Date("2026-11-07T12:00:00Z");

	const insertNode = async (id: string, state: "active" | "draining", heartbeatAgoMs: number) => {
		await database.db.insert(database.tables.nodes).values({
			id,
			region: "eu-north",
			roles: ["api", "live"],
			publicUrl: `https://${id}.nodes.example.com`,
			tailnetUrl: `http://${id}:3000`,
			state,
			registeredAt: now.toISOString(),
			heartbeatAt: new Date(now.getTime() - heartbeatAgoMs).toISOString(),
		});
	};

	beforeEach(async () => {
		database = await openTestDatabase();
	});

	afterEach(async () => {
		await database.destroy();
	});

	it("is false with an empty registry", async () => {
		expect(await hasPeers(database, "self", now)).toBe(false);
	});

	it("ignores the node itself, draining nodes and stale heartbeats", async () => {
		await insertNode("self", "active", 1_000);
		await insertNode("leaving", "draining", 1_000);
		await insertNode("silent", "active", 10 * 60_000);

		expect(await hasPeers(database, "self", now)).toBe(false);
	});

	it("is true when another active node has a fresh heartbeat", async () => {
		await insertNode("self", "active", 1_000);
		await insertNode("peer", "active", 5_000);

		expect(await hasPeers(database, "self", now)).toBe(true);
	});
});

describe("the health route", () => {
	let close: () => Promise<void> = async () => {};

	afterEach(async () => {
		await close();
	});

	const serve = async (ctx: Partial<AppContext>, api: boolean) => {
		const server = createAppServer(ctx as AppContext, { api });
		const http = server.router.listen(0);

		await new Promise((resolve) => http.once("listening", resolve));

		close = () => new Promise<void>((resolve) => http.close(() => resolve()));

		const { port } = http.address() as AddressInfo;

		return (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
	};

	const fakeContext = () => {
		return {
			config: { corsOrigins: [], APPVIEW_DID: "did:web:appview.example.com" },
			log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
			database: { ping: vi.fn(async () => {}) },
			drain: createDrainState(),
			didDocument: { id: "did:web:appview.example.com" },
		} as unknown as Partial<AppContext> & { drain: ReturnType<typeof createDrainState> };
	};

	it("answers ok while the node runs", async () => {
		const request = await serve(fakeContext(), false);
		const response = await request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "ok" });
	});

	it("answers 503 with the deadline while the node drains", async () => {
		const ctx = fakeContext();
		const deadline = new Date("2026-11-07T14:00:00Z");

		ctx.drain.begin(deadline);

		const request = await serve(ctx, false);
		const response = await request("/health");

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			status: "draining",
			deadline: deadline.toISOString(),
		});
	});

	it("serves no XRPC routes on a node without the api role", async () => {
		const request = await serve(fakeContext(), false);
		const response = await request("/xrpc/social.colibri.beta.server.describeServer");

		expect(response.status).not.toBe(200);
	});
});
