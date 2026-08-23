import { SpaceCredentialError } from "@colibri-social/space";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceSyncEngine } from "./engine.js";
import type { RepoCursor, SyncStore } from "./types.js";

const SPACE = "at://did:plc:community/space/social.colibri.channel.text/3lkchan";
const AUTHORITY = "did:plc:community";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";

type Remote = { did: string; rev: string };

const cursor = (
	author: string,
	appliedRev: string | null,
	overrides: Partial<RepoCursor> = {},
): RepoCursor => ({
	space: SPACE,
	author,
	appliedRev,
	setHashBase64: "state",
	state: "active",
	consecutiveFailures: 0,
	retryAfter: null,
	...overrides,
});

let cursors: Map<string, RepoCursor>;
let dropped: string[];
let droppedSpaces: string[];

const store = (): SyncStore => ({
	listSpaces: async () => [{ uri: SPACE, authority: AUTHORITY }],
	listCursors: async () => [...cursors.values()],
	loadCursor: async (_space, author) => cursors.get(author) ?? null,
	saveCursor: async (next) => void cursors.set(next.author, next),
	commit: async () => undefined,
	replace: async () => undefined,
	dropRepo: async (_space, author) => {
		dropped.push(author);
		cursors.delete(author);
	},
	dropSpace: async (space) => void droppedSpaces.push(space),
});

const client = (remotes: Remote[], options: { listThrows?: unknown } = {}) => ({
	allRepos: async function* () {
		if (options.listThrows) throw options.listThrows;
		for (const remote of remotes)
			yield { did: remote.did, rev: remote.rev, hash: new Uint8Array() };
	},
	registerNotify: vi.fn(async () => ({ expiresAt: new Date(Date.now() + 3_600_000) })),
});

const engineFor = (
	remotes: Remote[],
	sync: (space: string, author: string) => Promise<void>,
	options: { listThrows?: unknown; now?: () => Date } = {},
) => {
	const spaceClient = client(remotes, options);
	const engine = new SpaceSyncEngine({
		repos: {
			sync: async (space: string, author: string) => {
				await sync(space, author);
				return { kind: "unchanged" as const };
			},
		},
		client: spaceClient as never,
		credentials: { invalidate: async () => undefined } as never,
		store: store(),
		hosts: { hostFor: async () => "https://pds.test" },
		keys: { signingKeyFor: async () => "did:key:z" },
		syncerService: "did:web:appview#atproto_space_syncer",
		concurrency: 4,
		...(options.now ? { now: options.now } : {}),
	});

	return { engine, spaceClient };
};

beforeEach(() => {
	cursors = new Map();
	dropped = [];
	droppedSpaces = [];
});

describe("sweeping a space", () => {
	it("pulls a repo it has never seen", async () => {
		const pulled: string[] = [];
		const { engine } = engineFor([{ did: ALICE, rev: "3b" }], async (_space, author) => {
			pulled.push(author);
		});

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(pulled).toEqual([ALICE]);
	});

	it("pulls a repo whose revision moved past ours", async () => {
		cursors.set(ALICE, cursor(ALICE, "3a"));
		const pulled: string[] = [];
		const { engine } = engineFor([{ did: ALICE, rev: "3b" }], async (_space, author) => {
			pulled.push(author);
		});

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(pulled).toEqual([ALICE]);
	});

	it("leaves a repo alone when its revision has not moved", async () => {
		cursors.set(ALICE, cursor(ALICE, "3b"));
		const pulled: string[] = [];
		const { engine } = engineFor([{ did: ALICE, rev: "3b" }], async (_space, author) => {
			pulled.push(author);
		});

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(pulled).toEqual([]);
	});

	it("holds off on a repo that is backing off after a failure", async () => {
		const now = new Date("2026-08-23T00:00:00.000Z");
		cursors.set(
			ALICE,
			cursor(ALICE, "3a", {
				state: "error",
				consecutiveFailures: 3,
				retryAfter: new Date(now.getTime() + 60_000),
			}),
		);
		const pulled: string[] = [];
		const { engine } = engineFor(
			[{ did: ALICE, rev: "3b" }],
			async (_space, author) => void pulled.push(author),
			{ now: () => now },
		);

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(pulled).toEqual([]);
	});

	it("picks a backed-off repo up again once its retry time passes", async () => {
		const now = new Date("2026-08-23T00:00:00.000Z");
		cursors.set(
			ALICE,
			cursor(ALICE, "3a", {
				state: "error",
				consecutiveFailures: 3,
				retryAfter: new Date(now.getTime() - 1_000),
			}),
		);
		const pulled: string[] = [];
		const { engine } = engineFor(
			[{ did: ALICE, rev: "3b" }],
			async (_space, author) => void pulled.push(author),
			{ now: () => now },
		);

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(pulled).toEqual([ALICE]);
	});

	it("drops a repo the authority no longer lists", async () => {
		cursors.set(BOB, cursor(BOB, "3a"));
		const { engine } = engineFor([{ did: ALICE, rev: "3b" }], async () => undefined);

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(dropped).toEqual([BOB]);
	});

	it("registers for write notifications, and only once while the registration holds", async () => {
		const { engine, spaceClient } = engineFor([], async () => undefined);

		await engine.sweepSpace(SPACE);
		await engine.sweepSpace(SPACE);

		expect(spaceClient.registerNotify).toHaveBeenCalledTimes(1);
		expect(spaceClient.registerNotify).toHaveBeenCalledWith(
			SPACE,
			"did:web:appview#atproto_space_syncer",
		);
	});

	it("drops the whole space when the authority says it is gone", async () => {
		const { engine } = engineFor([], async () => undefined, {
			listThrows: new SpaceCredentialError(SPACE, "spaceDeleted", "gone"),
		});

		await engine.sweepSpace(SPACE);

		expect(droppedSpaces).toEqual([SPACE]);
	});

	it("lets an outage surface rather than treating it as a deletion", async () => {
		const { engine } = engineFor([], async () => undefined, {
			listThrows: new SpaceCredentialError(SPACE, "upstream", "bad gateway"),
		});

		await expect(engine.sweepSpace(SPACE)).rejects.toBeInstanceOf(SpaceCredentialError);
		expect(droppedSpaces).toEqual([]);
	});
});

describe("write notifications", () => {
	it("pulls immediately rather than waiting for the next sweep", async () => {
		const pulled: string[] = [];
		const { engine } = engineFor([], async (_space, author) => void pulled.push(author));

		engine.notifyWrite(SPACE, ALICE);
		await engine.drain();

		expect(pulled).toEqual([ALICE]);
	});

	it("collapses repeated notifications for the same repo into one pull", async () => {
		let running = 0;
		let overlapped = false;
		const { engine } = engineFor([], async () => {
			running += 1;
			if (running > 1) overlapped = true;
			await new Promise((resolve) => setTimeout(resolve, 5));
			running -= 1;
		});

		engine.notifyWrite(SPACE, ALICE);
		engine.notifyWrite(SPACE, ALICE);
		engine.notifyWrite(SPACE, ALICE);
		await engine.drain();

		expect(overlapped).toBe(false);
	});

	it("records a failure with a retry time instead of losing it", async () => {
		const now = new Date("2026-08-23T00:00:00.000Z");
		const { engine } = engineFor(
			[],
			async () => {
				throw new Error("upstream exploded");
			},
			{ now: () => now },
		);

		const failures: unknown[] = [];
		engine.on("failed", (_space, _author, error) => failures.push(error));

		engine.notifyWrite(SPACE, ALICE);
		await engine.drain();

		expect(failures).toHaveLength(1);
		const recorded = cursors.get(ALICE);
		expect(recorded?.state).toBe("error");
		expect(recorded?.consecutiveFailures).toBe(1);
		expect(recorded?.retryAfter?.getTime()).toBeGreaterThan(now.getTime());
	});

	it("backs off further each time a repo keeps failing", async () => {
		const now = new Date("2026-08-23T00:00:00.000Z");
		const { engine } = engineFor(
			[],
			async () => {
				throw new Error("still broken");
			},
			{ now: () => now },
		);
		engine.on("failed", () => undefined);

		engine.notifyWrite(SPACE, ALICE);
		await engine.drain();
		const first = cursors.get(ALICE)?.retryAfter?.getTime() ?? 0;

		engine.notifyWrite(SPACE, ALICE);
		await engine.drain();
		const second = cursors.get(ALICE)?.retryAfter?.getTime() ?? 0;

		expect(cursors.get(ALICE)?.consecutiveFailures).toBe(2);
		expect(second).toBeGreaterThan(first);
	});
});
