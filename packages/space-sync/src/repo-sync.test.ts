import { randomBytes } from "node:crypto";
import { P256Keypair } from "@atproto/crypto";
import type { LexMap } from "@atproto/lex-data";
import {
	COMMIT_MAC_PROFILE,
	createCommitMacHeaders,
	encapsulate,
	formatMacRequest,
	parseMacRequest,
	RepoCommit,
	type SpaceCommit,
	serializeRecord,
	writeRepoStar,
} from "@atproto/space";
import type { DidString, NsidString, RecordKeyString, TidString } from "@atproto/syntax";
import {
	type MacProof,
	type ProvenCommit,
	type RepoStar,
	RepoUnverifiedError,
	XrpcError,
} from "@colibri-social/space";
import { beforeEach, describe, expect, it } from "vitest";
import { RepoHostMissingError, RepoSync, RepoTooLargeError } from "./repo-sync.js";
import type { RepoChange, RepoCursor, SyncStore } from "./types.js";

const SPACE = "at://did:plc:2hnjxkqm6bpuvvpjbztkxxxx/space/social.colibri.beta.channel.text/3lkabc";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkyyyy";
const HOST = "https://pds.test";
const MESSAGE = "social.colibri.beta.message";
const REV1 = "3mwcj3b6uak22";
const REV2 = "3mwcj3b6uak23";
const REV9 = "3mwcj3b6uak2z";

type StoredRecord = {
	collection: string;
	rkey: string;
	cid: string;
	value: Record<string, unknown>;
};

const memoryStore = () => {
	const records = new Map<string, StoredRecord>();
	const cursors = new Map<string, RepoCursor>();
	const key = (collection: string, rkey: string) => `${collection}/${rkey}`;

	const store: SyncStore = {
		listSpaces: async () => [{ uri: SPACE, authority: "did:plc:2hnjxkqm6bpuvvpjbztkxxxx" }],
		listCursors: async () => [...cursors.values()],
		loadCursor: async (_space, author) => cursors.get(author) ?? null,
		saveCursor: async (cursor) => void cursors.set(cursor.author, cursor),
		commit: async (change, cursor) => {
			for (const put of change.puts) records.set(key(put.collection, put.rkey), put);
			for (const del of change.deletes) records.delete(key(del.collection, del.rkey));
			cursors.set(cursor.author, { ...blank(cursor.author), ...cursor });
		},
		replace: async (change, cursor) => {
			const held = [...records.values()].map(({ collection, rkey, cid }) => ({
				collection,
				rkey,
				cid,
			}));
			records.clear();
			for (const put of change.puts) records.set(key(put.collection, put.rkey), put);
			cursors.set(cursor.author, { ...blank(cursor.author), ...cursor });
			return held;
		},
		dropRepo: async (_space, author) => {
			records.clear();
			cursors.delete(author);
		},
		dropSpace: async () => {
			records.clear();
			cursors.clear();
		},
	};

	return { store, records, cursors };
};

const blank = (author: string): RepoCursor => ({
	space: SPACE,
	author,
	appliedRev: null,
	setHashBase64: null,
	state: "pending",
	consecutiveFailures: 0,
	retryAfter: null,
});

let secret: Uint8Array;
let keyShare: DidString;

const proofFor = (commit: SpaceCommit, macSecret: Uint8Array): MacProof => {
	const request = parseMacRequest(
		formatMacRequest(COMMIT_MAC_PROFILE, keyShare),
		COMMIT_MAC_PROFILE,
	);
	if (!request) throw new Error("the MAC request did not parse");

	const { headers } = createCommitMacHeaders(commit, { ...request, sharedSecret: macSecret });

	return { keyShare, sharedSecret: secret, headers };
};

const sign = async (
	records: StoredRecord[],
	rev: string,
	sharedSecret: Uint8Array = secret,
): Promise<{ commit: ProvenCommit; serialized: Awaited<ReturnType<typeof serializeRecord>>[] }> => {
	const serialized = (
		await Promise.all(
			records.map((record) =>
				serializeRecord(
					record.collection as NsidString,
					record.rkey as RecordKeyString,
					record.value as LexMap,
				),
			),
		)
	).sort((a, b) => (`${a.collection}/${a.rkey}` < `${b.collection}/${b.rkey}` ? -1 : 1));
	const commit = RepoCommit.fromRecords(serialized).toCommit({
		space: SPACE as never,
		repo: AUTHOR as DidString,
		rev: rev as TidString,
	});
	return {
		commit: { commit, ...proofFor(commit, sharedSecret) },
		serialized,
	};
};

const starFor = async (
	records: StoredRecord[],
	rev: string,
	macSecret: Uint8Array = secret,
): Promise<RepoStar> => {
	const { commit, serialized } = await sign(records, rev, macSecret);
	const { commit: repoCommit, ...proof } = commit;
	return { star: writeRepoStar(repoCommit, serialized), ...proof };
};

const message = (rkey: string, text: string): StoredRecord => ({
	collection: MESSAGE,
	rkey,
	cid: "",
	value: { $type: MESSAGE, text, createdAt: "2026-08-23T00:00:00.000Z" },
});

const cidsFor = async (records: StoredRecord[]): Promise<StoredRecord[]> => {
	const serialized = await Promise.all(
		records.map((record) =>
			serializeRecord(
				record.collection as NsidString,
				record.rkey as RecordKeyString,
				record.value as LexMap,
			),
		),
	);
	return records.map((record, index) => ({
		...record,
		cid: serialized[index]?.cid.toString() as string,
	}));
};

type FakeBehaviour = {
	ops?: Array<{
		rev: string;
		collection: string;
		rkey: string;
		cid: string | null;
		prev: string | null;
		value?: Record<string, unknown>;
	}>;
	commit?: ProvenCommit;
	car?: () => Promise<RepoStar>;
	opsError?: XrpcError;
	carError?: XrpcError;
};

const fakeClient = (behaviour: FakeBehaviour) => {
	const calls = { listRepoOps: 0, getRepoCar: 0 };
	const client = {
		listRepoOps: async () => {
			calls.listRepoOps += 1;
			if (behaviour.opsError) throw behaviour.opsError;
			if (!behaviour.commit) throw new Error("no commit configured");
			return { ops: behaviour.ops ?? [], commit: behaviour.commit, cursor: null };
		},
		getRepoStar: async () => {
			calls.getRepoCar += 1;
			if (behaviour.carError) throw behaviour.carError;
			if (!behaviour.car) throw new Error("no archive configured");
			return behaviour.car();
		},
	};
	return { client, calls };
};

const kemKeys = () => {
	const refreshes: string[] = [];
	return {
		refreshes,
		kemKeyFor: async (did: string, forceRefresh?: boolean) => {
			if (forceRefresh) refreshes.push(did);
			return "did:key:unused";
		},
	};
};

const syncerFor = (behaviour: FakeBehaviour, store: SyncStore, maxRepoBytes?: number) => {
	const { client, calls } = fakeClient(behaviour);
	const keys = kemKeys();
	const sync = new RepoSync({
		client: client as never,
		store,
		hosts: { hostFor: async () => HOST },
		keys,
		...(maxRepoBytes === undefined ? {} : { maxRepoBytes }),
	});
	return { sync, calls, refreshes: keys.refreshes };
};

beforeEach(async () => {
	const kem = await P256Keypair.create();
	const encapsulation = await encapsulate(kem.did() as DidString);
	secret = encapsulation.sharedSecret;
	keyShare = encapsulation.keyShare;
});

describe("first sync", () => {
	it("recovers the whole repo from an archive when there is no cursor", async () => {
		const records = await cidsFor([message("3a", "hello"), message("3b", "world")]);
		const { store, records: stored, cursors } = memoryStore();
		const { sync, calls } = syncerFor({ car: () => starFor(records, REV1) }, store);

		const outcome = await sync.sync(SPACE, AUTHOR);

		expect(outcome.kind).toBe("recovered");
		expect(calls.getRepoCar).toBe(1);
		expect(calls.listRepoOps).toBe(0);
		expect([...stored.keys()].sort()).toEqual([`${MESSAGE}/3a`, `${MESSAGE}/3b`]);
		expect(cursors.get(AUTHOR)?.appliedRev).toBe(REV1);
		expect(cursors.get(AUTHOR)?.setHashBase64).toBeTruthy();
	});

	it("refuses an archive that exceeds the byte cap instead of buffering it", async () => {
		const records = await cidsFor([message("3a", "hello"), message("3b", "world")]);
		const { store, records: stored } = memoryStore();
		const { sync } = syncerFor({ car: () => starFor(records, REV1) }, store, 8);

		await expect(sync.sync(SPACE, AUTHOR)).rejects.toBeInstanceOf(RepoTooLargeError);
		expect(stored.size).toBe(0);
	});

	it("refreshes the KEM key once and then refuses an archive whose MAC does not verify", async () => {
		const records = await cidsFor([message("3a", "hello")]);
		const { store, records: stored } = memoryStore();
		const other = new Uint8Array(randomBytes(32));
		const { sync, calls, refreshes } = syncerFor(
			{ car: () => starFor(records, REV1, other) },
			store,
		);

		await expect(sync.sync(SPACE, AUTHOR)).rejects.toBeInstanceOf(RepoUnverifiedError);
		expect(refreshes).toEqual([AUTHOR]);
		expect(calls.getRepoCar).toBe(2);
		expect(stored.size).toBe(0);
	});

	it("succeeds on the retry after a rotated KEM key", async () => {
		const records = await cidsFor([message("3a", "hello")]);
		const { store, cursors } = memoryStore();
		const other = new Uint8Array(randomBytes(32));
		let attempts = 0;
		const { sync, refreshes } = syncerFor(
			{ car: () => starFor(records, REV1, attempts++ === 0 ? other : secret) },
			store,
		);

		const outcome = await sync.sync(SPACE, AUTHOR);
		expect(outcome.kind).toBe("recovered");
		expect(refreshes).toEqual([AUTHOR]);
		expect(cursors.get(AUTHOR)?.appliedRev).toBe(REV1);
	});
});

describe("incremental sync", () => {
	const seed = async () => {
		const records = await cidsFor([message("3a", "hello")]);
		const { store, records: stored, cursors } = memoryStore();
		const { sync } = syncerFor({ car: () => starFor(records, REV1) }, store);
		await sync.sync(SPACE, AUTHOR);
		return { store, stored, cursors, records };
	};

	it("applies a create and agrees with the host's commit", async () => {
		const { store, stored, cursors, records } = await seed();
		const added = await cidsFor([message("3b", "second")]);
		const { commit } = await sign([...records, ...added], REV2);

		const { sync, calls } = syncerFor(
			{
				ops: added.map((record) => ({
					rev: REV2,
					collection: record.collection,
					rkey: record.rkey,
					cid: record.cid,
					prev: null,
					value: record.value,
				})),
				commit,
			},
			store,
		);

		const outcome = await sync.sync(SPACE, AUTHOR);

		expect(outcome.kind).toBe("advanced");
		expect(calls.getRepoCar).toBe(0);
		expect([...stored.keys()].sort()).toEqual([`${MESSAGE}/3a`, `${MESSAGE}/3b`]);
		expect(cursors.get(AUTHOR)?.appliedRev).toBe(REV2);
		expect(outcome.kind === "advanced" && outcome.change.puts.map((put) => put.rev)).toEqual([
			REV2,
		]);
	});

	it("applies a delete and removes its element from the set hash", async () => {
		const { store, stored, records } = await seed();
		const { commit } = await sign([], REV2);
		const removed = records[0] as StoredRecord;

		const { sync, calls } = syncerFor(
			{
				ops: [
					{
						rev: REV2,
						collection: removed.collection,
						rkey: removed.rkey,
						cid: null,
						prev: removed.cid,
					},
				],
				commit,
			},
			store,
		);

		const outcome = await sync.sync(SPACE, AUTHOR);

		expect(outcome.kind).toBe("advanced");
		expect(calls.getRepoCar).toBe(0);
		expect(stored.size).toBe(0);
	});

	it("applies an update by swapping the old element for the new one", async () => {
		const { store, stored, records } = await seed();
		const previous = records[0] as StoredRecord;
		const [updated] = await cidsFor([message("3a", "edited")]);
		const { commit } = await sign([updated as StoredRecord], REV2);

		const { sync, calls } = syncerFor(
			{
				ops: [
					{
						rev: REV2,
						collection: MESSAGE,
						rkey: "3a",
						cid: (updated as StoredRecord).cid,
						prev: previous.cid,
						value: (updated as StoredRecord).value,
					},
				],
				commit,
			},
			store,
		);

		const outcome = await sync.sync(SPACE, AUTHOR);

		expect(outcome.kind).toBe("advanced");
		expect(calls.getRepoCar).toBe(0);
		expect(stored.get(`${MESSAGE}/3a`)?.value.text).toBe("edited");
		expect(outcome.kind === "advanced" && outcome.change.puts[0]?.rev).toBeUndefined();
	});

	it("falls back to a full recovery when the set hash disagrees with the commit", async () => {
		const { store, stored, records } = await seed();
		const added = await cidsFor([message("3b", "second"), message("3c", "third")]);
		const truth = [...records, ...added];
		const { commit } = await sign(truth, REV2);
		const missed = added[0] as StoredRecord;

		const { sync, calls } = syncerFor(
			{
				ops: [
					{
						rev: REV2,
						collection: missed.collection,
						rkey: missed.rkey,
						cid: missed.cid,
						prev: null,
						value: missed.value,
					},
				],
				commit,
				car: () => starFor(truth, REV2),
			},
			store,
		);

		const outcome = await sync.sync(SPACE, AUTHOR);

		expect(outcome.kind).toBe("recovered");
		expect(calls.getRepoCar).toBe(1);
		expect([...stored.keys()].sort()).toEqual([`${MESSAGE}/3a`, `${MESSAGE}/3b`, `${MESSAGE}/3c`]);
	});

	it("reports no change when the oplog is empty", async () => {
		const { store, records } = await seed();
		const { commit } = await sign(records, REV1);
		const { sync } = syncerFor({ ops: [], commit }, store);
		expect((await sync.sync(SPACE, AUTHOR)).kind).toBe("unchanged");
	});
});

describe("failures", () => {
	const seeded = async () => {
		const records = await cidsFor([message("3a", "hello")]);
		const { store, cursors } = memoryStore();
		const { sync } = syncerFor({ car: () => starFor(records, REV1) }, store);
		await sync.sync(SPACE, AUTHOR);
		return { store, cursors, records };
	};

	it("recovers when the host no longer retains the requested revision", async () => {
		const { store, records } = await seeded();
		const { sync, calls } = syncerFor(
			{
				opsError: new XrpcError(400, "CursorNotFound", "gone", "listRepoOps"),
				car: () => starFor(records, REV9),
			},
			store,
		);
		expect((await sync.sync(SPACE, AUTHOR)).kind).toBe("recovered");
		expect(calls.getRepoCar).toBe(1);
	});

	it("marks records it already held unchanged as replayed when it recovers", async () => {
		const { store } = await seeded();
		const records = await cidsFor([
			message("3a", "hello"),
			message("3b", "world"),
			message("3c", "again"),
		]);
		const { sync } = syncerFor(
			{
				opsError: new XrpcError(400, "CursorNotFound", "gone", "listRepoOps"),
				car: () => starFor(records, REV9),
			},
			store,
		);

		const outcome = await sync.sync(SPACE, AUTHOR);

		expect(outcome.kind).toBe("recovered");
		const puts = outcome.kind === "recovered" ? outcome.change.puts : [];
		expect(puts.map((put) => [put.rkey, put.replayed === true])).toEqual([
			["3a", true],
			["3b", false],
			["3c", false],
		]);
	});

	it("drops a repo whose account is gone", async () => {
		const { store, cursors } = await seeded();
		const { sync } = syncerFor(
			{ opsError: new XrpcError(400, "RepoTakendown", "gone", "listRepoOps") },
			store,
		);
		expect((await sync.sync(SPACE, AUTHOR)).kind).toBe("gone");
		expect(cursors.has(AUTHOR)).toBe(false);
	});

	it("clears a repo its host no longer has and keeps it synced as empty", async () => {
		const { store, cursors } = await seeded();
		const { sync, calls } = syncerFor(
			{ opsError: new XrpcError(400, "RepoNotFound", "missing", "listRepoOps") },
			store,
		);

		const outcome = await sync.sync(SPACE, AUTHOR);

		expect(outcome.kind).toBe("recovered");
		expect(outcome.kind === "recovered" && outcome.change.deletes).toEqual([
			{ collection: MESSAGE, rkey: "3a" },
		]);
		expect(cursors.get(AUTHOR)?.state).toBe("active");
		expect(cursors.get(AUTHOR)?.appliedRev).toBeNull();
		expect(calls.getRepoCar).toBe(0);

		const again = await sync.sync(SPACE, AUTHOR);

		expect(again.kind).toBe("unchanged");
		expect(calls.listRepoOps).toBe(2);
		expect(calls.getRepoCar).toBe(0);
	});

	it("treats a never-written repo as empty on its first sync", async () => {
		const { store, records, cursors } = memoryStore();
		const { sync } = syncerFor(
			{ carError: new XrpcError(400, "RepoNotFound", "missing", "getRepo") },
			store,
		);

		expect((await sync.sync(SPACE, AUTHOR)).kind).toBe("unchanged");
		expect(records.size).toBe(0);
		expect(cursors.get(AUTHOR)?.state).toBe("active");
	});

	it("parks a repo whose author publishes no host", async () => {
		const { store, cursors } = await seeded();
		const { client, calls } = fakeClient({});
		const sync = new RepoSync({
			client: client as never,
			store,
			hosts: {
				hostFor: async (did) => {
					throw new RepoHostMissingError(did);
				},
			},
			keys: kemKeys(),
		});

		expect((await sync.sync(SPACE, AUTHOR)).kind).toBe("gone");
		expect(cursors.get(AUTHOR)?.state).toBe("gone");
		expect(cursors.get(AUTHOR)?.appliedRev).toBeNull();
		expect(calls.listRepoOps + calls.getRepoCar).toBe(0);
	});

	it("propagates an outage rather than treating it as divergence", async () => {
		const { store } = await seeded();
		const { sync, calls } = syncerFor(
			{ opsError: new XrpcError(502, "UpstreamFailure", "bad gateway", "listRepoOps") },
			store,
		);
		await expect(sync.sync(SPACE, AUTHOR)).rejects.toBeInstanceOf(XrpcError);
		expect(calls.getRepoCar).toBe(0);
	});
});

describe("change reporting", () => {
	it("reports exactly what was applied so a projection can follow", async () => {
		const records = await cidsFor([message("3a", "hello")]);
		const { store } = memoryStore();
		const { sync } = syncerFor({ car: () => starFor(records, REV1) }, store);
		const outcome = await sync.sync(SPACE, AUTHOR);

		const change = (outcome as { change: RepoChange }).change;
		expect(change.space).toBe(SPACE);
		expect(change.author).toBe(AUTHOR);
		expect(change.puts).toHaveLength(1);
		expect(change.puts[0]?.value.text).toBe("hello");
	});
});
