import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { admitCommunityWrites, CommunityLoader } from "@colibri-social/community";
import {
	COLLECTIONS,
	channelSpace,
	communitySpaces,
	preferencesSpace,
	SELF,
	SPACE_TYPES,
} from "@colibri-social/lexicons";
import { applyChange, type ProjectionDeps, type SpaceChange } from "@colibri-social/projections";
import { nextTid, spaceRecordUri } from "@colibri-social/space";
import type { FetchedRepo, RepoChange } from "@colibri-social/space-sync";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzleSyncStore } from "../stores.js";
import { canTransition, hostedAuthorsIn, parseHostMode } from "./host-mode.js";
import { beginMigration, checkFallback, completeMigration, listForMigration } from "./migration.js";
import { foldSetHash, heldRecords, loadActor, loadRepo, type PolyfillDeps } from "./state.js";
import { getPolyfillStatus } from "./status.js";
import { applyPolyfillWrites, getPolyfillRecord, listPolyfillRecords } from "./writes.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxx";
const SYNCED = "did:plc:syncedxxxxxxxxxxxxxxxxxxxxx";
const OUTSIDER = "did:plc:outsiderxxxxxxxxxxxxxxxxxxx";
const SPACES = communitySpaces(COMMUNITY);
const CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel001");
const PDS = "https://pds.test";

let database: TestDatabase;
let projections: ProjectionDeps;
let published: RepoChange[];
let supported: boolean | undefined;
let fetched: FetchedRepo;
let now: string;

const deps = (): PolyfillDeps => ({
	database,
	projections,
	loader: new CommunityLoader({ db: database.db, tables: database.tables }),
	support: { check: async () => supported },
	pdsOf: async () => PDS,
	publish: (change) => published.push(change),
	fetchRepo: async () => fetched,
});

const synced = async (change: SpaceChange) => {
	for (const entry of change.puts) {
		await database.db.insert(database.tables.records).values({
			space: change.space,
			author: change.author,
			collection: entry.collection,
			rkey: entry.rkey,
			cid: entry.cid,
			value: entry.value,
			indexedAt: now,
		});
	}
	await applyChange(projections, change);
};

const authorityPut = (space: string, collection: string, rkey: string, value: object) => {
	return synced({
		space,
		author: COMMUNITY,
		puts: [{ collection, rkey, cid: "bafytest", value: { $type: collection, ...value } }],
		deletes: [],
	});
};

const message = (text: string, rkey = nextTid()) => ({
	kind: "create" as const,
	collection: COLLECTIONS.message,
	rkey,
	value: { $type: COLLECTIONS.message, text, createdAt: now },
});

const write = (writes: Parameters<typeof applyPolyfillWrites>[2]["writes"], space = CHANNEL) => {
	return applyPolyfillWrites(deps(), MEMBER, { space, writes });
};

const adoptMember = async () => {
	await database.db.insert(database.tables.polyfillActors).values({
		did: MEMBER,
		mode: "polyfill",
		pds: PDS,
		pdsSupportsSpaces: false,
		checkedAt: now,
	});
};

const errorCode = async (run: Promise<unknown>) => {
	try {
		await run;
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return "resolved";
};

beforeEach(async () => {
	now = new Date().toISOString();
	database = await openTestDatabase();
	published = [];
	supported = false;
	projections = {
		db: database.db,
		tables: database.tables,
		now: () => now,
		admit: admitCommunityWrites(database.tables),
	};

	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Protocol Nerds",
		labelers: [],
		profileSpace: SPACES.profile,
		configSpace: SPACES.configuration,
		membersSpace: SPACES.members,
		moderationSpace: SPACES.moderation,
		indexedAt: now,
	});
	await database.db.insert(database.tables.spaces).values({
		uri: CHANNEL,
		authority: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey: "3lkchannel001",
		community: COMMUNITY,
		host: PDS,
		createdAt: now,
	});
	await authorityPut(CHANNEL, COLLECTIONS.channel, SELF, { name: "general" });

	for (const did of [MEMBER, SYNCED]) {
		await authorityPut(SPACES.members, COLLECTIONS.member, did, {
			subject: did,
			joinedAt: now,
			roles: [],
		});
	}
});

afterEach(async () => {
	await database.destroy();
});

describe("host modes", () => {
	it("never lets a repo skip the migrating state", () => {
		expect(canTransition("polyfill", "native")).toBe(false);
		expect(canTransition("polyfill", "migrating")).toBe(true);
		expect(canTransition("migrating", "native")).toBe(true);
		expect(canTransition("migrating", "polyfill")).toBe(true);
		expect(canTransition("native", "polyfill")).toBe(true);
		expect(canTransition("native", "migrating")).toBe(false);
	});

	it("reads an unknown stored mode as polyfill", () => {
		expect(parseHostMode("nonsense")).toBe("polyfill");
		expect(parseHostMode(null)).toBe("polyfill");
		expect(parseHostMode("native")).toBe("native");
	});
});

describe("applyWrites", () => {
	it("refuses someone who isn't a member of the channel", async () => {
		const code = await errorCode(
			applyPolyfillWrites(deps(), OUTSIDER, { space: CHANNEL, writes: [message("hi")] }),
		);

		expect(code).toBe("NotAuthorized");
	});

	it("refuses writes to another user's preferences", async () => {
		await adoptMember();

		const code = await errorCode(
			write(
				[
					{
						kind: "create",
						collection: COLLECTIONS.mute,
						value: {
							$type: COLLECTIONS.mute,
							subject: { $type: "social.colibri.beta.actor.defs#mutedActor", did: SYNCED },
							createdAt: now,
						},
					},
				],
				preferencesSpace(SYNCED),
			),
		);

		expect(code).toBe("NotAuthorized");
	});

	it("answers RepoNotHosted for a repo that lives on the user's server", async () => {
		supported = true;

		expect(await errorCode(write([message("hi")]))).toBe("RepoNotHosted");
		expect(await loadActor({ db: database.db, tables: database.tables }, MEMBER)).toBeNull();
	});

	it("starts hosting a user whose server lacks spaces on the first write", async () => {
		await write([message("hi")]);

		expect((await loadActor({ db: database.db, tables: database.tables }, MEMBER))?.mode).toBe(
			"polyfill",
		);
	});

	it("answers RecordNotFound for an update of a missing record", async () => {
		await adoptMember();

		const code = await errorCode(
			write([
				{
					kind: "update",
					collection: COLLECTIONS.message,
					rkey: nextTid(),
					value: { $type: COLLECTIONS.message, text: "hi", createdAt: now },
				},
			]),
		);

		expect(code).toBe("RecordNotFound");
	});

	it("rejects a record that doesn't match its lexicon", async () => {
		await adoptMember();

		const code = await errorCode(
			write([
				{
					kind: "create",
					collection: COLLECTIONS.message,
					value: { $type: COLLECTIONS.message, text: 42 },
				},
			]),
		);

		expect(code).toBe("InvalidRecord");
	});

	it("projects a write the same way as a synced write", async () => {
		await adoptMember();

		const rkey = nextTid();
		const outcome = await write([message("same text", rkey)]);
		const [result] = outcome.results as { uri: string; cid: string }[];
		const store = drizzleSyncStore(database, projections, {
			threadIdleSeconds: 60,
			probe: async () => true,
		});

		await store.commit(
			{
				space: CHANNEL,
				author: SYNCED,
				puts: [
					{
						collection: COLLECTIONS.message,
						rkey,
						cid: result?.cid ?? "",
						value: { $type: COLLECTIONS.message, text: "same text", createdAt: now },
						rev: outcome.rev,
					},
				],
				deletes: [],
			},
			{
				space: CHANNEL,
				author: SYNCED,
				appliedRev: outcome.rev,
				setHashBase64: null,
				state: "active",
			},
		);

		const rows = await database.db.select().from(database.tables.messages);
		const shape = (author: string) => {
			const {
				indexedAt: _indexedAt,
				author: _author,
				...rest
			} = rows.find((row) => row.author === author) ?? {};

			return rest;
		};

		expect(rows).toHaveLength(2);
		expect(shape(MEMBER)).toEqual(shape(SYNCED));
		expect(result?.uri).toBe(spaceRecordUri(CHANNEL, MEMBER, COLLECTIONS.message, rkey));
		expect(published).toHaveLength(1);
		expect(published[0]?.puts[0]?.rkey).toBe(rkey);
	});

	it("keeps the set hash in step with the records it holds", async () => {
		await adoptMember();

		const first = nextTid();
		const tables = { db: database.db, tables: database.tables };

		await write([message("one", first), message("two")]);
		await write([{ kind: "delete", collection: COLLECTIONS.message, rkey: first }]);

		const repo = await loadRepo(tables, CHANNEL, MEMBER);
		const held = await heldRecords(tables, CHANNEL, MEMBER);

		expect(held).toHaveLength(1);
		expect(repo?.setHash).toBe(foldSetHash(held));
		expect(published[1]?.deletes[0]?.previous?.text).toBe("one");
	});

	it("serves the user's own records back", async () => {
		await adoptMember();

		const rkey = nextTid();

		await write([message("hello", rkey)]);

		const record = await getPolyfillRecord(deps(), MEMBER, {
			space: CHANNEL,
			collection: COLLECTIONS.message,
			rkey,
		});
		const list = await listPolyfillRecords(deps(), MEMBER, {
			space: CHANNEL,
			collection: COLLECTIONS.message,
		});

		expect(record.value.text).toBe("hello");
		expect(list.records.map((entry) => entry.cid)).toEqual([record.cid]);
	});
});

describe("migration", () => {
	const tables = () => ({ db: database.db, tables: database.tables });

	const pdsCopy = async (): Promise<FetchedRepo> => {
		const held = await heldRecords(tables(), CHANNEL, MEMBER);

		return {
			rev: nextTid(),
			setHashBase64: foldSetHash(held),
			records: held.map((record) => ({ ...record, value: {} })),
		};
	};

	beforeEach(async () => {
		await adoptMember();
		await write([message("one"), message("two")]);
		supported = true;
	});

	it("hands a verified repo to the user's server and seeds the sync cursor", async () => {
		expect(await beginMigration(deps(), MEMBER)).toEqual({ spaces: [CHANNEL] });

		fetched = await pdsCopy();

		expect(await completeMigration(deps(), MEMBER, { space: CHANNEL })).toEqual({
			mode: "native",
		});

		const [cursor] = await database.db
			.select()
			.from(database.tables.spaceRepos)
			.where(
				and(
					eq(database.tables.spaceRepos.space, CHANNEL),
					eq(database.tables.spaceRepos.author, MEMBER),
				),
			);

		expect(cursor?.appliedRev).toBe(fetched.rev);
		expect(cursor?.setHashBase64).toBe(fetched.setHashBase64);
		expect((await getPolyfillStatus(deps(), MEMBER)).mode).toBe("native");
		expect(await errorCode(write([message("after")]))).toBe("RepoNotHosted");
	});

	it("returns a mismatched repo to polyfill and lists what differs", async () => {
		await beginMigration(deps(), MEMBER);

		const copy = await pdsCopy();
		const [kept, dropped] = copy.records;
		const partial = [kept].flatMap((record) => (record ? [record] : []));

		fetched = { rev: copy.rev, setHashBase64: foldSetHash(partial), records: partial };

		const outcome = await completeMigration(deps(), MEMBER, { space: CHANNEL });

		expect(outcome.mode).toBe("polyfill");
		expect(outcome.missing).toEqual([
			spaceRecordUri(CHANNEL, MEMBER, dropped?.collection ?? "", dropped?.rkey ?? ""),
		]);
		expect((await loadRepo(tables(), CHANNEL, MEMBER))?.mode).toBe("polyfill");
		expect(await beginMigration(deps(), MEMBER)).toEqual({ spaces: [CHANNEL] });
	});

	it("refuses to complete a repo that hasn't started moving", async () => {
		expect(await errorCode(completeMigration(deps(), MEMBER, { space: CHANNEL }))).toBe(
			"MigrationNotStarted",
		);
	});

	it("keeps accepting writes while a repo is migrating", async () => {
		await beginMigration(deps(), MEMBER);
		await write([message("three")]);

		const page = await listForMigration(deps(), MEMBER, { space: CHANNEL, limit: 2 });
		const rest = await listForMigration(deps(), MEMBER, {
			space: CHANNEL,
			limit: 2,
			...(page.cursor ? { cursor: page.cursor } : {}),
		});

		expect(page.records).toHaveLength(2);
		expect(rest.records).toHaveLength(1);
		expect(rest.cursor).toBeUndefined();
		expect((await getPolyfillStatus(deps(), MEMBER)).migration).toEqual({
			spacesTotal: 1,
			spacesDone: 0,
		});
	});

	it("refuses to start when the user's server still lacks spaces", async () => {
		supported = false;

		expect(await errorCode(beginMigration(deps(), MEMBER))).toBe("SpacesUnsupported");
	});
});

describe("fallback", () => {
	it("moves a native user back to polyfill when a fresh check says their server lost spaces", async () => {
		const support = { check: async () => false };

		await database.db.insert(database.tables.polyfillRepos).values({
			space: CHANNEL,
			author: SYNCED,
			mode: "native",
			rev: null,
			setHash: "x",
			migratedRev: null,
			updatedAt: now,
		});

		expect(await checkFallback({ database, support }, SYNCED, PDS)).toBe(true);
		expect((await loadActor({ db: database.db, tables: database.tables }, SYNCED))?.mode).toBe(
			"polyfill",
		);
		expect(
			await hostedAuthorsIn({ db: database.db, tables: database.tables }, CHANNEL, [
				SYNCED,
				MEMBER,
			]),
		).toEqual([SYNCED]);
	});

	it("leaves a user alone while their server still serves spaces", async () => {
		const support = { check: async () => true };

		expect(await checkFallback({ database, support }, SYNCED, PDS)).toBe(false);
		expect(await loadActor({ db: database.db, tables: database.tables }, SYNCED)).toBeNull();
	});
});

describe("sync store", () => {
	it("leaves hosted members out of the expected repos", async () => {
		await adoptMember();

		const store = drizzleSyncStore(database, projections, {
			threadIdleSeconds: 60,
			probe: async () => true,
		});

		expect(await store.expectedRepos?.(CHANNEL)).toEqual([COMMUNITY, SYNCED]);
		expect(await store.isHosted?.(CHANNEL, MEMBER)).toBe(true);
		expect(await store.isHosted?.(CHANNEL, SYNCED)).toBe(false);
	});
});
