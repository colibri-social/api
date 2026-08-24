import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { COLLECTIONS, channelSpace, SPACE_TYPES } from "@colibri-social/lexicons";
import type { ProjectionDeps } from "@colibri-social/projections";
import type { RepoChange, RepoCursor, SyncStore } from "@colibri-social/space-sync";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzleSyncStore } from "./stores.js";

const COMMUNITY = "did:plc:communityaaaaaaaaaaaaaaaaaa";
const AUTHOR = "did:plc:authoraaaaaaaaaaaaaaaaaaaaaa";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel1");
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let store: SyncStore;
let projections: ProjectionDeps;

const cursor = (
	appliedRev: string,
	state: RepoCursor["state"] = "active",
): Pick<RepoCursor, "space" | "author" | "appliedRev" | "setHashBase64" | "state"> => ({
	space: SPACE,
	author: AUTHOR,
	appliedRev,
	setHashBase64: "aGFzaA==",
	state,
});

const message = (rkey: string, text: string) => ({
	collection: COLLECTIONS.message,
	rkey,
	cid: `bafy${rkey}`,
	value: { $type: COLLECTIONS.message, text, createdAt: NOW },
});

const change = (puts: RepoChange["puts"], deletes: RepoChange["deletes"] = []): RepoChange => ({
	space: SPACE,
	author: AUTHOR,
	puts,
	deletes,
});

const storedRecords = () =>
	database.db
		.select()
		.from(database.tables.records)
		.where(
			and(eq(database.tables.records.space, SPACE), eq(database.tables.records.author, AUTHOR)),
		);

const storedMessages = () =>
	database.db
		.select()
		.from(database.tables.messages)
		.where(eq(database.tables.messages.space, SPACE));

beforeEach(async () => {
	database = await openTestDatabase();
	projections = { db: database.db, tables: database.tables, now: () => NOW };
	store = drizzleSyncStore(database, projections);

	await database.db.insert(database.tables.channels).values({
		space: SPACE,
		community: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey: "3lkchannel1",
		name: "general",
		description: null,
		category: null,
		position: 0,
		ownerOnly: false,
		allowedRoles: [],
		allowedMembers: [],
		visibleToRoles: [],
		visibleToMembers: [],
		linkEmbeds: null,
		migratedFrom: null,
	});
});

afterEach(async () => {
	await database.destroy();
});

describe("commit", () => {
	it("stores records, projections and the cursor together", async () => {
		await store.commit(change([message("3lkmsg1", "hello")]), cursor("rev1"));

		expect(await storedRecords()).toHaveLength(1);
		expect((await storedMessages())[0]).toMatchObject({ rkey: "3lkmsg1", text: "hello" });
		expect(await store.loadCursor(SPACE, AUTHOR)).toMatchObject({
			appliedRev: "rev1",
			setHashBase64: "aGFzaA==",
			state: "active",
		});
	});

	it("applies deletes to both the record store and the projection", async () => {
		await store.commit(
			change([message("3lkmsg1", "hello"), message("3lkmsg2", "world")]),
			cursor("rev1"),
		);
		await store.commit(
			change([], [{ collection: COLLECTIONS.message, rkey: "3lkmsg1" }]),
			cursor("rev2"),
		);

		expect(await storedRecords()).toHaveLength(1);
		expect(await storedMessages()).toHaveLength(1);
		expect((await store.loadCursor(SPACE, AUTHOR))?.appliedRev).toBe("rev2");
	});

	it("clears a failure count when a repo recovers", async () => {
		await store.saveCursor({
			...cursor("rev1", "error"),
			consecutiveFailures: 4,
			retryAfter: new Date(NOW),
		});

		await store.commit(change([message("3lkmsg1", "hello")]), cursor("rev2"));

		expect(await store.loadCursor(SPACE, AUTHOR)).toMatchObject({
			state: "active",
			consecutiveFailures: 0,
			retryAfter: null,
		});
	});

	it("leaves neither records nor the cursor behind when projection fails", async () => {
		await store.commit(change([message("3lkmsg1", "hello")]), cursor("rev1"));

		const broken = drizzleSyncStore(database, {
			...projections,
			now: () => {
				throw new Error("projection exploded");
			},
		});

		await expect(
			broken.commit(change([message("3lkmsg2", "world")]), cursor("rev2")),
		).rejects.toThrow("projection exploded");

		expect(await storedRecords()).toHaveLength(1);
		expect(await storedMessages()).toHaveLength(1);
		expect((await store.loadCursor(SPACE, AUTHOR))?.appliedRev).toBe("rev1");
	});
});

describe("replace", () => {
	it("rebuilds a repo from scratch and drops what is no longer there", async () => {
		await store.commit(
			change([message("3lkmsg1", "hello"), message("3lkmsg2", "world")]),
			cursor("rev1"),
		);

		await store.replace(
			{ space: SPACE, author: AUTHOR, puts: [message("3lkmsg3", "rebuilt")] },
			cursor("rev9"),
		);

		expect(await storedRecords()).toHaveLength(1);
		const messages = await storedMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ rkey: "3lkmsg3", text: "rebuilt" });
		expect((await store.loadCursor(SPACE, AUTHOR))?.appliedRev).toBe("rev9");
	});
});

describe("dropRepo", () => {
	it("removes the repo's records, projections and cursor", async () => {
		await store.commit(change([message("3lkmsg1", "hello")]), cursor("rev1"));

		await store.dropRepo(SPACE, AUTHOR);

		expect(await storedRecords()).toHaveLength(0);
		expect(await storedMessages()).toHaveLength(0);
		expect(await store.loadCursor(SPACE, AUTHOR)).toBeNull();
	});
});

describe("dropSpace", () => {
	it("forgets every repo, the credential and the notify registration", async () => {
		await database.db.insert(database.tables.spaces).values({
			uri: SPACE,
			authority: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey: "3lkchannel1",
			community: COMMUNITY,
			host: "https://pds.test",
			createdAt: NOW,
		});
		await database.db.insert(database.tables.spaceCredentials).values({
			space: SPACE,
			credential: "credential",
			boundKeyThumbprint: "thumb",
			boundPrivateJwk: JSON.stringify({ kty: "EC" }),
			expiresAt: NOW,
		});
		await database.db.insert(database.tables.notifyRegistrations).values({
			space: SPACE,
			service: "did:web:appview.test#atproto_space_syncer",
			expiresAt: NOW,
		});
		await store.commit(change([message("3lkmsg1", "hello")]), cursor("rev1"));

		await store.dropSpace(SPACE);

		expect(await storedRecords()).toHaveLength(0);
		expect(await storedMessages()).toHaveLength(0);
		expect(await store.listSpaces()).toHaveLength(0);
		expect(
			await database.db
				.select()
				.from(database.tables.spaceCredentials)
				.where(eq(database.tables.spaceCredentials.space, SPACE)),
		).toHaveLength(0);
		expect(
			await database.db
				.select()
				.from(database.tables.notifyRegistrations)
				.where(eq(database.tables.notifyRegistrations.space, SPACE)),
		).toHaveLength(0);
	});
});

describe("expectedRepos", () => {
	const MEMBER = "did:plc:memberaaaaaaaaaaaaaaaaaaaaaa";

	const declareSpace = async (uri: string, spaceType: string, community: string | null) => {
		await database.db.insert(database.tables.spaces).values({
			uri,
			authority: community ?? COMMUNITY,
			spaceType,
			skey: "3lkchannel1",
			community,
			host: "https://pds.test",
			createdAt: NOW,
		});
	};

	beforeEach(async () => {
		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: MEMBER,
			roles: [],
			joinedAt: NOW,
		});
	});

	it("names the community and every member for a channel space", async () => {
		await declareSpace(SPACE, SPACE_TYPES.channelText, COMMUNITY);

		expect((await store.expectedRepos?.(SPACE))?.sort()).toEqual([COMMUNITY, MEMBER].sort());
	});

	it("names only the authority for a space members do not write to", async () => {
		const configuration = `at://${COMMUNITY}/space/${SPACE_TYPES.communityConfiguration}/self`;
		await declareSpace(configuration, SPACE_TYPES.communityConfiguration, COMMUNITY);

		expect(await store.expectedRepos?.(configuration)).toEqual([COMMUNITY]);
	});

	it("names nothing for a space it has never registered", async () => {
		expect(await store.expectedRepos?.("at://did:plc:nope/space/x.y.z/self")).toEqual([]);
	});
});
