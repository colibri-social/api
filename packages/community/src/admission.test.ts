import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { channelSpace, communitySpaces, SELF, SPACE_TYPES } from "@colibri-social/lexicons";
import {
	applyChange,
	type ProjectionDeps,
	type RecordRef,
	type SpaceChange,
} from "@colibri-social/projections";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitCommunityWrites } from "./admission.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxx";
const OUTSIDER = "did:plc:outsiderxxxxxxxxxxxxxxxxxxx";
const SPACES = communitySpaces(COMMUNITY);
const CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel001");
const NOW = "2026-09-24T00:00:00.000Z";

let database: TestDatabase;
let deps: ProjectionDeps;
let skipped: Array<{ ref: RecordRef; reason: string }>;

const put = (
	space: string,
	author: string,
	collection: string,
	rkey: string,
	value: Record<string, unknown>,
): SpaceChange => ({
	space,
	author,
	puts: [{ collection, rkey, cid: "bafytest", value: { $type: collection, ...value } }],
	deletes: [],
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
			indexedAt: NOW,
		});
	}
	await applyChange(deps, change);
};

const registerSpace = (uri: string, spaceType: string, skey: string) =>
	database.db.insert(database.tables.spaces).values({
		uri,
		authority: COMMUNITY,
		spaceType,
		skey,
		community: COMMUNITY,
		host: "https://pds.test",
		createdAt: NOW,
	});

const channelRecord = (value: Record<string, unknown> = {}) =>
	put(CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, { name: "general", ...value });

const memberRecord = (did: string, roles: string[] = []) =>
	put(SPACES.members, COMMUNITY, "social.colibri.beta.member", did, {
		subject: did,
		joinedAt: NOW,
		roles,
	});

const moderationRecord = (rkey: string, action: "ban" | "unban", subject: string) =>
	put(SPACES.moderation, COMMUNITY, "social.colibri.beta.moderation", rkey, {
		action,
		subject,
		createdBy: COMMUNITY,
		createdAt: NOW,
	});

const message = (author: string, rkey: string, text = "hello") =>
	put(CHANNEL, author, "social.colibri.beta.message", rkey, { text, createdAt: NOW });

const reaction = (author: string, rkey: string) =>
	put(CHANNEL, author, "social.colibri.beta.reaction", rkey, {
		emoji: "👍",
		target: { did: MEMBER, rkey: "3lkmsg001" },
	});

const messageAuthors = async () =>
	(await database.db.select().from(database.tables.messages)).map((row) => row.author);

beforeEach(async () => {
	database = await openTestDatabase();
	skipped = [];
	deps = {
		db: database.db,
		tables: database.tables,
		now: () => NOW,
		admit: admitCommunityWrites(database.tables),
		onSkipped: (ref, reason) => skipped.push({ ref, reason }),
	};
	await registerSpace(CHANNEL, SPACE_TYPES.channelText, "3lkchannel001");
});

afterEach(async () => {
	await database.destroy();
});

describe("admitCommunityWrites", () => {
	it("admits a message from a member who may post", async () => {
		await synced(channelRecord());
		await synced(memberRecord(MEMBER));
		await synced(message(MEMBER, "3lkmsg001"));

		expect(await messageAuthors()).toEqual([MEMBER]);
		expect(skipped).toEqual([]);
	});

	it("refuses a message from someone who is not a member", async () => {
		await synced(channelRecord());
		await synced(message(OUTSIDER, "3lkmsg001"));

		expect(await messageAuthors()).toEqual([]);
		expect(skipped.map((entry) => entry.ref.author)).toEqual([OUTSIDER]);
	});

	it("refuses a message from a banned member", async () => {
		await synced(channelRecord());
		await synced(memberRecord(MEMBER));
		await synced(moderationRecord("3lkmod001", "ban", MEMBER));
		await synced(message(MEMBER, "3lkmsg001"));

		expect(await messageAuthors()).toEqual([]);
	});

	it("refuses a reaction from someone who is not a member", async () => {
		await synced(channelRecord());
		await synced(reaction(OUTSIDER, "3lkreact001"));

		expect(await database.db.select().from(database.tables.reactions)).toEqual([]);
	});

	it("refuses a message from a member outside a channel's allowed roles", async () => {
		await synced(channelRecord({ allowedRoles: ["3lkrole001"] }));
		await synced(memberRecord(MEMBER));
		await synced(message(MEMBER, "3lkmsg001"));

		expect(await messageAuthors()).toEqual([]);
	});

	it("admits the community's own message before the channel record arrives", async () => {
		await synced(message(COMMUNITY, "3lkmsg001"));

		expect(await messageAuthors()).toEqual([COMMUNITY]);
	});

	it("projects a refused message once its author's member record arrives", async () => {
		await synced(channelRecord());
		await synced(message(MEMBER, "3lkmsg001"));
		expect(await messageAuthors()).toEqual([]);

		await synced(memberRecord(MEMBER));

		expect(await messageAuthors()).toEqual([MEMBER]);
	});

	it("projects a refused message once its channel record arrives", async () => {
		await synced(memberRecord(MEMBER));
		await synced(message(MEMBER, "3lkmsg001"));
		expect(await messageAuthors()).toEqual([]);

		await synced(channelRecord());

		expect(await messageAuthors()).toEqual([MEMBER]);
	});

	it("projects a refused message once its author is unbanned", async () => {
		await synced(channelRecord());
		await synced(memberRecord(MEMBER));
		await synced(moderationRecord("3lkmod001", "ban", MEMBER));
		await synced(message(MEMBER, "3lkmsg001"));
		expect(await messageAuthors()).toEqual([]);

		await synced(moderationRecord("3lkmod002", "unban", MEMBER));

		expect(await messageAuthors()).toEqual([MEMBER]);
	});

	it("leaves an outsider's message refused when someone else joins", async () => {
		await synced(channelRecord());
		await synced(message(OUTSIDER, "3lkmsg001"));
		await synced(memberRecord(MEMBER));

		expect(await messageAuthors()).toEqual([]);
	});
});
