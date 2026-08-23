import { Secp256k1Keypair } from "@atproto/crypto";
import type { LexMap } from "@atproto/lex-data";
import { RepoCommit, type SignedCommit, serializeRecord, serializeRepo } from "@atproto/space";
import { XrpcError } from "@colibri-social/space";
import { beforeEach, describe, expect, it } from "vitest";
import { RepoSync } from "./repo-sync.js";
import type { RepoChange, RepoCursor, SyncStore } from "./types.js";

const SPACE = "at://did:plc:2hnjxkqm6bpuvvpjbztkxxxx/space/social.colibri.channel.text/3lkabc";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkyyyy";
const HOST = "https://pds.test";
const MESSAGE = "social.colibri.message";

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
			records.clear();
			for (const put of change.puts) records.set(key(put.collection, put.rkey), put);
			cursors.set(cursor.author, { ...blank(cursor.author), ...cursor });
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

let keypair: Secp256k1Keypair;

const sign = async (
	records: StoredRecord[],
	rev: string,
): Promise<{ commit: SignedCommit; serialized: Awaited<ReturnType<typeof serializeRecord>>[] }> => {
	const serialized = await Promise.all(
		records.map((record) =>
			serializeRecord(record.collection, record.rkey, record.value as LexMap),
		),
	);
	const commit = await RepoCommit.fromRecords(serialized).sign(
		{ space: SPACE, author: AUTHOR, rev },
		keypair,
	);
	return { commit, serialized };
};

const carFor = async (records: StoredRecord[], rev: string): Promise<AsyncIterable<Uint8Array>> => {
	const { commit, serialized } = await sign(records, rev);
	return serializeRepo(commit, serialized);
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
			serializeRecord(record.collection, record.rkey, record.value as LexMap),
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
	commit?: SignedCommit | null;
	car?: () => Promise<AsyncIterable<Uint8Array>>;
	opsError?: XrpcError;
	carError?: XrpcError;
};

const fakeClient = (behaviour: FakeBehaviour) => {
	const calls = { listRepoOps: 0, getRepoCar: 0 };
	const client = {
		listRepoOps: async () => {
			calls.listRepoOps += 1;
			if (behaviour.opsError) throw behaviour.opsError;
			return { ops: behaviour.ops ?? [], commit: behaviour.commit ?? null, cursor: null };
		},
		getRepoCar: async () => {
			calls.getRepoCar += 1;
			if (behaviour.carError) throw behaviour.carError;
			if (!behaviour.car) throw new Error("no car configured");
			return behaviour.car();
		},
	};
	return { client, calls };
};

const syncerFor = (behaviour: FakeBehaviour, store: SyncStore) => {
	const { client, calls } = fakeClient(behaviour);
	const sync = new RepoSync({
		client: client as never,
		store,
		hosts: { hostFor: async () => HOST },
		keys: { signingKeyFor: async () => keypair.did() },
	});
	return { sync, calls };
};

beforeEach(async () => {
	keypair = await Secp256k1Keypair.create({ exportable: true });
});

describe("first sync", () => {
	it("recovers the whole repo from a car when there is no cursor", async () => {
		const records = await cidsFor([message("3a", "hello"), message("3b", "world")]);
		const { store, records: stored, cursors } = memoryStore();
		const { sync, calls } = syncerFor({ car: () => carFor(records, "3rev1") }, store);

		const outcome = await sync.sync(SPACE, AUTHOR);

		expect(outcome.kind).toBe("recovered");
		expect(calls.getRepoCar).toBe(1);
		expect(calls.listRepoOps).toBe(0);
		expect([...stored.keys()].sort()).toEqual([`${MESSAGE}/3a`, `${MESSAGE}/3b`]);
		expect(cursors.get(AUTHOR)?.appliedRev).toBe("3rev1");
		expect(cursors.get(AUTHOR)?.setHashBase64).toBeTruthy();
	});

	it("refuses a car signed by the wrong key", async () => {
		const records = await cidsFor([message("3a", "hello")]);
		const car = await carFor(records, "3rev1");
		const { store } = memoryStore();
		const impostor = await Secp256k1Keypair.create({ exportable: true });
		const { client } = fakeClient({ car: async () => car });
		const sync = new RepoSync({
			client: client as never,
			store,
			hosts: { hostFor: async () => HOST },
			keys: { signingKeyFor: async () => impostor.did() },
		});

		await expect(sync.sync(SPACE, AUTHOR)).rejects.toThrow();
	});
});

describe("incremental sync", () => {
	const seed = async () => {
		const records = await cidsFor([message("3a", "hello")]);
		const { store, records: stored, cursors } = memoryStore();
		const { sync } = syncerFor({ car: () => carFor(records, "3rev1") }, store);
		await sync.sync(SPACE, AUTHOR);
		return { store, stored, cursors, records };
	};

	it("applies a create and agrees with the host's commit", async () => {
		const { store, stored, cursors, records } = await seed();
		const added = await cidsFor([message("3b", "second")]);
		const { commit } = await sign([...records, ...added], "3rev2");

		const { sync, calls } = syncerFor(
			{
				ops: added.map((record) => ({
					rev: "3rev2",
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
		expect(cursors.get(AUTHOR)?.appliedRev).toBe("3rev2");
	});

	it("applies a delete and removes its element from the set hash", async () => {
		const { store, stored, records } = await seed();
		const { commit } = await sign([], "3rev2");
		const removed = records[0] as StoredRecord;

		const { sync, calls } = syncerFor(
			{
				ops: [
					{
						rev: "3rev2",
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
		const { commit } = await sign([updated as StoredRecord], "3rev2");

		const { sync, calls } = syncerFor(
			{
				ops: [
					{
						rev: "3rev2",
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
	});

	it("falls back to a full recovery when the set hash disagrees with the commit", async () => {
		const { store, stored, records } = await seed();
		const added = await cidsFor([message("3b", "second"), message("3c", "third")]);
		const truth = [...records, ...added];
		const { commit } = await sign(truth, "3rev2");
		const missed = added[0] as StoredRecord;

		const { sync, calls } = syncerFor(
			{
				ops: [
					{
						rev: "3rev2",
						collection: missed.collection,
						rkey: missed.rkey,
						cid: missed.cid,
						prev: null,
						value: missed.value,
					},
				],
				commit,
				car: () => carFor(truth, "3rev2"),
			},
			store,
		);

		const outcome = await sync.sync(SPACE, AUTHOR);

		expect(outcome.kind).toBe("recovered");
		expect(calls.getRepoCar).toBe(1);
		expect([...stored.keys()].sort()).toEqual([`${MESSAGE}/3a`, `${MESSAGE}/3b`, `${MESSAGE}/3c`]);
	});

	it("reports no change when the oplog is empty", async () => {
		const { store } = await seed();
		const { sync } = syncerFor({ ops: [], commit: null }, store);
		expect((await sync.sync(SPACE, AUTHOR)).kind).toBe("unchanged");
	});
});

describe("failures", () => {
	const seeded = async () => {
		const records = await cidsFor([message("3a", "hello")]);
		const { store, cursors } = memoryStore();
		const { sync } = syncerFor({ car: () => carFor(records, "3rev1") }, store);
		await sync.sync(SPACE, AUTHOR);
		return { store, cursors, records };
	};

	it("recovers when the host no longer retains the requested revision", async () => {
		const { store, records } = await seeded();
		const { sync, calls } = syncerFor(
			{
				opsError: new XrpcError(400, "CursorNotFound", "gone", "listRepoOps"),
				car: () => carFor(records, "3rev9"),
			},
			store,
		);
		expect((await sync.sync(SPACE, AUTHOR)).kind).toBe("recovered");
		expect(calls.getRepoCar).toBe(1);
	});

	it("drops a repo whose account is gone", async () => {
		const { store, cursors } = await seeded();
		const { sync } = syncerFor(
			{ opsError: new XrpcError(400, "RepoNotFound", "gone", "listRepoOps") },
			store,
		);
		expect((await sync.sync(SPACE, AUTHOR)).kind).toBe("gone");
		expect(cursors.has(AUTHOR)).toBe(false);
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
		const { sync } = syncerFor({ car: () => carFor(records, "3rev1") }, store);
		const outcome = await sync.sync(SPACE, AUTHOR);

		const change = (outcome as { change: RepoChange }).change;
		expect(change.space).toBe(SPACE);
		expect(change.author).toBe(AUTHOR);
		expect(change.puts).toHaveLength(1);
		expect(change.puts[0]?.value.text).toBe("hello");
	});
});
