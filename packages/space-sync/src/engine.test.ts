import { SpaceCredentialError } from "@colibri-social/space";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceSyncEngine, type SyncEngineOptions } from "./engine.js";
import type { RepoSyncOutcome } from "./repo-sync.js";
import type { ChangeTiming, RepoCursor, SyncStore } from "./types.js";

const SPACE = "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchan";
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

const store = (expected?: string[]): SyncStore => ({
	listSpaces: async () => [{ uri: SPACE, authority: AUTHORITY }],
	listCursors: async () => [...cursors.values()],
	...(expected ? { expectedRepos: async () => expected } : {}),
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

const isOutcome = (value: unknown): value is RepoSyncOutcome =>
	typeof value === "object" && value !== null && "kind" in value;

const engineFor = (
	remotes: Remote[],
	sync: (space: string, author: string) => Promise<unknown>,
	options: {
		listThrows?: unknown;
		now?: () => Date;
		expected?: string[];
		engine?: Partial<SyncEngineOptions>;
	} = {},
) => {
	const spaceClient = client(remotes, options);
	const engine = new SpaceSyncEngine({
		repos: {
			sync: async (space: string, author: string) => {
				const outcome = await sync(space, author);
				return isOutcome(outcome) ? outcome : { kind: "unchanged" as const, appliedRev: null };
			},
		},
		client: spaceClient as never,
		credentials: { invalidate: async () => undefined } as never,
		store: store(options.expected),
		hosts: { hostFor: async () => "https://pds.test" },
		keys: { signingKeyFor: async () => "did:key:z" },
		syncerService: "did:web:appview#atproto_space_syncer",
		concurrency: 4,
		...(options.now ? { now: options.now } : {}),
		...(options.engine ?? {}),
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

	it("pulls a repo the space expects even when the authority does not list it", async () => {
		const pulled: string[] = [];
		const { engine } = engineFor([], async (_space, author) => void pulled.push(author), {
			expected: [AUTHORITY, ALICE],
		});

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(pulled.sort()).toEqual([ALICE, AUTHORITY].sort());
	});

	it("keeps pulling an expected repo after its first sync, since no revision is reported", async () => {
		cursors.set(ALICE, cursor(ALICE, "3a"));
		const pulled: string[] = [];
		const { engine } = engineFor([], async (_space, author) => void pulled.push(author), {
			expected: [ALICE],
		});

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(pulled).toEqual([ALICE]);
	});

	it("does not drop an expected repo the authority leaves out of its writer set", async () => {
		cursors.set(ALICE, cursor(ALICE, "3a"));
		const { engine } = engineFor([], async () => undefined, { expected: [ALICE] });

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(dropped).toEqual([]);
	});

	it("still drops a repo that is neither listed nor expected", async () => {
		cursors.set(BOB, cursor(BOB, "3a"));
		const { engine } = engineFor([], async () => undefined, { expected: [ALICE] });

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(dropped).toEqual([BOB]);
	});

	it("leaves an expected repo alone while it is backing off", async () => {
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
		const { engine } = engineFor([], async (_space, author) => void pulled.push(author), {
			expected: [ALICE],
			now: () => now,
		});

		await engine.sweepSpace(SPACE);
		await engine.drain();

		expect(pulled).toEqual([]);
		expect(dropped).toEqual([]);
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = () => {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

const advanced = (appliedRev: string | null): RepoSyncOutcome => ({
	kind: "advanced",
	change: { space: SPACE, author: ALICE, puts: [], deletes: [] },
	appliedRev,
});

describe("chasing a notified revision", () => {
	it("pulls again when a write lands while a pull is already running", async () => {
		let pulls = 0;
		const gate = deferred();
		const { engine } = engineFor([], async () => {
			pulls += 1;
			if (pulls === 1) await gate.promise;
		});

		engine.notifyWrite(SPACE, ALICE);
		await settle();
		engine.notifyWrite(SPACE, ALICE);
		gate.resolve();
		await engine.drain();

		expect(pulls).toBe(2);
	});

	it("keeps pulling until the applied revision reaches the notified one", async () => {
		let pulls = 0;
		const { engine } = engineFor([], async () => {
			pulls += 1;
			return advanced(pulls === 1 ? "3l0" : "3l9");
		});

		engine.notifyWrite(SPACE, ALICE, { rev: "3l9" });
		await engine.drain();

		expect(pulls).toBe(2);
	});

	it("gives up chasing after the attempt cap", async () => {
		let pulls = 0;
		const events: string[] = [];
		const { engine } = engineFor(
			[],
			async () => {
				pulls += 1;
				return advanced("3l0");
			},
			{ engine: { maxChaseAttempts: 2, log: (event) => void events.push(event) } },
		);

		engine.notifyWrite(SPACE, ALICE, { rev: "3l9" });
		await engine.drain();

		expect(pulls).toBe(2);
		expect(events).toContain("repo.chaseExhausted");
	});

	it("skips a notification for a revision that is already applied", async () => {
		let pulls = 0;
		const { engine } = engineFor([], async () => {
			pulls += 1;
			return advanced("3l5");
		});

		engine.notifyWrite(SPACE, ALICE, { rev: "3l5" });
		await engine.drain();
		engine.notifyWrite(SPACE, ALICE, { rev: "3l5" });
		await engine.drain();

		expect(pulls).toBe(1);
	});

	it("attaches the trigger and notification time to the change it emits", async () => {
		const { engine } = engineFor([], async () => advanced("3l1"));
		const timings: Array<ChangeTiming | undefined> = [];
		engine.on("changed", (change) => void timings.push(change.timing));

		engine.notifyWrite(SPACE, ALICE, {
			rev: "3l1",
			trigger: "clientHint",
			notifiedAt: 1_000,
		});
		await engine.drain();

		expect(timings[0]?.trigger).toBe("clientHint");
		expect(timings[0]?.notifiedAt).toBe(1_000);
		expect(timings[0]?.committedAt).toBeGreaterThanOrEqual(timings[0]?.startedAt ?? 0);
	});
});

describe("notify registrations", () => {
	it("renews on its own schedule before the registration lapses", async () => {
		vi.useFakeTimers();
		let clock = new Date("2026-08-23T00:00:00.000Z").getTime();
		const { engine, spaceClient } = engineFor([], async () => undefined, {
			now: () => new Date(clock),
			engine: { registrationRenewMarginMs: 60_000 },
		});
		spaceClient.registerNotify.mockImplementation(async () => ({
			expiresAt: new Date(clock + 120_000),
		}));

		await engine.start();
		expect(spaceClient.registerNotify).toHaveBeenCalledTimes(1);

		clock += 70_000;
		await vi.advanceTimersByTimeAsync(30_000);

		expect(spaceClient.registerNotify).toHaveBeenCalledTimes(2);
		await engine.stop();
		vi.useRealTimers();
	});

	it("retries a failed registration within seconds instead of waiting for a sweep", async () => {
		vi.useFakeTimers();
		let clock = new Date("2026-08-23T00:00:00.000Z").getTime();
		const events: string[] = [];
		const { engine, spaceClient } = engineFor([], async () => undefined, {
			now: () => new Date(clock),
			engine: { log: (event) => void events.push(event) },
		});
		spaceClient.registerNotify.mockRejectedValueOnce(new Error("host refused"));

		await engine.start();
		expect(spaceClient.registerNotify).toHaveBeenCalledTimes(1);
		expect(events).toContain("registerNotify.failed");

		clock += 10_000;
		await vi.advanceTimersByTimeAsync(30_000);

		expect(spaceClient.registerNotify).toHaveBeenCalledTimes(2);
		await engine.stop();
		vi.useRealTimers();
	});

	it("says so when it finds a registration that already expired", async () => {
		vi.useFakeTimers();
		let clock = new Date("2026-08-23T00:00:00.000Z").getTime();
		const events: string[] = [];
		const { engine, spaceClient } = engineFor([], async () => undefined, {
			now: () => new Date(clock),
			engine: { log: (event) => void events.push(event) },
		});
		spaceClient.registerNotify.mockImplementation(async () => ({
			expiresAt: new Date(clock + 60_000),
		}));

		await engine.start();
		clock += 120_000;
		await vi.advanceTimersByTimeAsync(30_000);

		expect(events).toContain("registerNotify.lapsed");
		await engine.stop();
		vi.useRealTimers();
	});

	it("stops renewing a space that was deleted", async () => {
		vi.useFakeTimers();
		let clock = new Date("2026-08-23T00:00:00.000Z").getTime();
		const { engine, spaceClient } = engineFor([], async () => undefined, {
			now: () => new Date(clock),
			engine: { registrationRenewMarginMs: 60_000 },
		});
		spaceClient.registerNotify.mockImplementation(async () => ({
			expiresAt: new Date(clock + 120_000),
		}));

		await engine.start();
		engine.notifySpaceDeleted(SPACE);
		await vi.advanceTimersByTimeAsync(0);

		clock += 70_000;
		await vi.advanceTimersByTimeAsync(30_000);

		expect(spaceClient.registerNotify).toHaveBeenCalledTimes(1);
		await engine.stop();
		vi.useRealTimers();
	});
});

describe("sweeping", () => {
	it("refuses to start a second sweep while one is running", async () => {
		const { engine, spaceClient } = engineFor([], async () => undefined);
		let listings = 0;
		const original = spaceClient.allRepos;
		spaceClient.allRepos = async function* () {
			listings += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			yield* original();
		};

		await Promise.all([engine.sweep(), engine.sweep()]);

		expect(listings).toBe(1);
	});
});
