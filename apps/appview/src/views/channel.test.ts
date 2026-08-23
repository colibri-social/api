import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { COLLECTIONS, channelSpace, SPACE_TYPES, type social } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { ActorViews } from "./actor.js";
import { ChannelViews } from "./channel.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const AUTHOR_A = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const AUTHOR_B = "did:plc:7fkdlwjqmzcuvvpjbztkbbbb";
const LABELER = "did:plc:labelerlabelerlabelerlabl";
const OTHER_LABELER = "did:plc:notallowednotallowednota";
const CHANNEL_SKEY = "3lkchanneltest0";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, CHANNEL_SKEY);
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let ctx: AppContext;
let views: ChannelViews;

type Parent = social.colibri.channel.defs.MessageView["parent"];

const asMessageView = (parent: Parent): social.colibri.channel.defs.MessageView | undefined =>
	parent?.$type === "social.colibri.channel.defs#messageView"
		? (parent as social.colibri.channel.defs.MessageView)
		: undefined;

const asDeletedView = (
	parent: Parent,
): social.colibri.channel.defs.DeletedMessageView | undefined =>
	parent?.$type === "social.colibri.channel.defs#deletedMessageView"
		? (parent as social.colibri.channel.defs.DeletedMessageView)
		: undefined;

const putLabel = async (
	subjectRkey: string,
	val: string,
	overrides: { src?: string; negated?: boolean; subjectDid?: string } = {},
) => {
	await database.db.insert(database.tables.labels).values({
		space: SPACE,
		src: overrides.src ?? LABELER,
		rkey: nextTid(),
		subjectDid: overrides.subjectDid ?? AUTHOR_A,
		subjectCollection: COLLECTIONS.message,
		subjectRkey,
		val,
		negated: overrides.negated ?? false,
		createdAt: NOW,
	});
};

const putMessage = async (
	rkey: string,
	overrides: Partial<typeof database.tables.messages.$inferInsert> = {},
) => {
	await database.db.insert(database.tables.messages).values({
		space: SPACE,
		author: AUTHOR_A,
		rkey,
		community: COMMUNITY,
		text: "hello",
		createdAt: NOW,
		fromLegacyRepo: false,
		indexedAt: NOW,
		...overrides,
	});
};

beforeEach(async () => {
	database = await openTestDatabase();

	ctx = {
		database,
		config: { PUBLIC_URL: "https://appview.test" },
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		identity: {
			resolveDid: async () => {
				throw new Error("no identity in tests");
			},
			resolveVerifiedHandle: async () => {
				throw new Error("no identity in tests");
			},
		},
	} as unknown as AppContext;

	views = new ChannelViews(ctx, new ActorViews(ctx));

	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Test Community",
		labelers: [LABELER],
		profileSpace: "at://community/profile",
		configSpace: "at://community/configuration",
		membersSpace: "at://community/members",
		moderationSpace: "at://community/moderation",
		indexedAt: NOW,
	});

	await database.db.insert(database.tables.channels).values({
		space: SPACE,
		community: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey: CHANNEL_SKEY,
		name: "general",
	});
});

afterEach(async () => {
	await database.destroy();
});

describe("ChannelViews.messages", () => {
	it("pages newest first by default, honours the cursor, and reverses to oldest first", async () => {
		const rkeys = [nextTid(), nextTid(), nextTid()];
		for (const rkey of rkeys) await putMessage(rkey);

		const firstPage = await views.messages(SPACE, null, { limit: 2 });
		expect(firstPage.messages.map((message) => message.rkey)).toEqual([rkeys[2], rkeys[1]]);
		expect(firstPage.cursor).toBe(rkeys[1]);

		const secondPage = await views.messages(SPACE, null, {
			limit: 2,
			cursor: firstPage.cursor,
		});
		expect(secondPage.messages.map((message) => message.rkey)).toEqual([rkeys[0]]);
		expect(secondPage.cursor).toBeUndefined();

		const reversed = await views.messages(SPACE, null, { limit: 10, reverse: true });
		expect(reversed.messages.map((message) => message.rkey)).toEqual(rkeys);
	});

	it("aggregates reactions by emoji and flags whether the viewer reacted", async () => {
		const rkey = nextTid();
		await putMessage(rkey);

		await database.db.insert(database.tables.reactions).values([
			{
				space: SPACE,
				author: AUTHOR_A,
				rkey: nextTid(),
				targetAuthor: AUTHOR_A,
				targetRkey: rkey,
				emoji: "thumbsup",
			},
			{
				space: SPACE,
				author: AUTHOR_B,
				rkey: nextTid(),
				targetAuthor: AUTHOR_A,
				targetRkey: rkey,
				emoji: "thumbsup",
			},
			{
				space: SPACE,
				author: AUTHOR_B,
				rkey: nextTid(),
				targetAuthor: AUTHOR_A,
				targetRkey: rkey,
				emoji: "tada",
			},
		]);

		const page = await views.messages(SPACE, AUTHOR_B, { limit: 10 });
		const reactions = page.messages[0]?.reactions ?? [];

		const thumbsup = reactions.find((reaction) => reaction.emoji === "thumbsup");
		expect(thumbsup).toMatchObject({ count: 2, viewerReacted: true });
		expect(thumbsup?.reactors).toEqual(expect.arrayContaining([AUTHOR_A, AUTHOR_B]));

		const tada = reactions.find((reaction) => reaction.emoji === "tada");
		expect(tada).toMatchObject({ count: 1, viewerReacted: true, reactors: [AUTHOR_B] });
	});

	it("only surfaces labels from labelers the community names, and drops negated ones", async () => {
		const rkey = nextTid();
		await putMessage(rkey);

		await database.db.insert(database.tables.labels).values([
			{
				space: SPACE,
				src: LABELER,
				rkey: nextTid(),
				subjectDid: AUTHOR_A,
				subjectCollection: COLLECTIONS.message,
				subjectRkey: rkey,
				val: "spoiler",
				negated: false,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				space: SPACE,
				src: LABELER,
				rkey: nextTid(),
				subjectDid: AUTHOR_A,
				subjectCollection: COLLECTIONS.message,
				subjectRkey: rkey,
				val: "hidden",
				negated: false,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				space: SPACE,
				src: LABELER,
				rkey: nextTid(),
				subjectDid: AUTHOR_A,
				subjectCollection: COLLECTIONS.message,
				subjectRkey: rkey,
				val: "hidden",
				negated: true,
				createdAt: "2026-01-02T00:00:00.000Z",
			},
			{
				space: SPACE,
				src: OTHER_LABELER,
				rkey: nextTid(),
				subjectDid: AUTHOR_A,
				subjectCollection: COLLECTIONS.message,
				subjectRkey: rkey,
				val: "spoiler",
				negated: false,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		]);

		const page = await views.messages(SPACE, null, { limit: 10 });
		const labels = page.messages[0]?.labels ?? [];

		expect(labels).toHaveLength(1);
		expect(labels[0]).toMatchObject({ src: LABELER, val: "spoiler" });
	});

	it("resolves a label against its record key, not its author-supplied timestamp", async () => {
		const rkey = nextTid();
		await putMessage(rkey);

		const applied = nextTid();
		const retracted = nextTid();
		const sameInstant = "2026-01-01T00:00:00.000Z";

		const label = (labelRkey: string, negated: boolean) => ({
			space: SPACE,
			src: LABELER,
			rkey: labelRkey,
			subjectDid: AUTHOR_A,
			subjectCollection: COLLECTIONS.message,
			subjectRkey: rkey,
			val: "hidden",
			negated,
			createdAt: sameInstant,
		});

		await database.db
			.insert(database.tables.labels)
			.values([label(retracted, true), label(applied, false)]);

		const page = await views.messages(SPACE, null, { limit: 10 });
		expect(page.messages[0]?.labels).toEqual([]);
	});

	it("resolves a reply's parent without recursing into the grandparent", async () => {
		const grandparentRkey = nextTid();
		const parentRkey = nextTid();
		const childRkey = nextTid();

		await putMessage(grandparentRkey, { text: "grandparent" });
		await putMessage(parentRkey, {
			text: "parent",
			parentAuthor: AUTHOR_A,
			parentRkey: grandparentRkey,
		});
		await putMessage(childRkey, {
			text: "child",
			parentAuthor: AUTHOR_A,
			parentRkey: parentRkey,
		});

		const page = await views.messages(SPACE, null, { limit: 10 });
		const child = page.messages.find((message) => message.rkey === childRkey);
		const parent = asMessageView(child?.parent);

		expect(parent?.rkey).toBe(parentRkey);
		expect(parent?.parent).toBeUndefined();
	});

	it("withholds a message an honoured labeler hid", async () => {
		const visible = nextTid();
		const withheld = nextTid();
		await putMessage(visible, { text: "fine" });
		await putMessage(withheld, { text: "spam" });
		await putLabel(withheld, "hidden");

		const page = await views.messages(SPACE, AUTHOR_B, { limit: 10 });
		expect(page.messages.map((message) => message.rkey)).toEqual([visible]);
	});

	it("ignores a hidden label from a labeler the community does not name", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putLabel(rkey, "hidden", { src: OTHER_LABELER });

		const page = await views.messages(SPACE, AUTHOR_B, { limit: 10 });
		expect(page.messages.map((message) => message.rkey)).toEqual([rkey]);
	});

	it("serves a hidden message back once the label is retracted", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putLabel(rkey, "hidden");

		expect((await views.messages(SPACE, AUTHOR_B, { limit: 10 })).messages).toEqual([]);

		await putLabel(rkey, "hidden", { negated: true });

		const page = await views.messages(SPACE, AUTHOR_B, { limit: 10 });
		expect(page.messages.map((message) => message.rkey)).toEqual([rkey]);
	});

	it("still shows a hidden message to its own author, with the label attached", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putLabel(rkey, "hidden", { negated: false });

		const page = await views.messages(SPACE, AUTHOR_A, { limit: 10 });
		expect(page.messages.map((message) => message.rkey)).toEqual([rkey]);
		expect(page.messages[0]?.labels).toEqual([
			expect.objectContaining({ src: LABELER, val: "hidden" }),
		]);
	});

	it("still shows a hidden message to a moderator holding label.apply", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putLabel(rkey, "hidden");

		await database.db.insert(database.tables.roles).values({
			community: COMMUNITY,
			rkey: "3lkmoderator00",
			name: "Moderator",
			position: 1,
			permissions: ["label.apply"],
			channelOverrides: [],
			protected: false,
		});
		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: AUTHOR_B,
			roles: ["3lkmoderator00"],
			joinedAt: NOW,
		});

		const page = await views.messages(SPACE, AUTHOR_B, { limit: 10 });
		expect(page.messages.map((message) => message.rkey)).toEqual([rkey]);
	});

	it("keeps spoiler labels on the messages it does serve", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putLabel(rkey, "spoiler");

		const page = await views.messages(SPACE, AUTHOR_B, { limit: 10 });
		expect(page.messages[0]?.labels).toEqual([
			expect.objectContaining({ src: LABELER, val: "spoiler" }),
		]);
	});

	it("stands a withheld parent in as a deleted message", async () => {
		const parentRkey = nextTid();
		const childRkey = nextTid();
		await putMessage(parentRkey, { text: "hidden parent" });
		await putMessage(childRkey, { text: "reply", parentAuthor: AUTHOR_A, parentRkey });
		await putLabel(parentRkey, "hidden");

		const page = await views.messages(SPACE, AUTHOR_B, { limit: 10 });
		expect(page.messages.map((message) => message.rkey)).toEqual([childRkey]);

		const child = page.messages[0];
		expect(asMessageView(child?.parent)).toBeUndefined();
		expect(asDeletedView(child?.parent)).toMatchObject({ rkey: parentRkey, channel: SPACE });
	});

	it("stands a parent that no longer exists in as a deleted message", async () => {
		const childRkey = nextTid();
		await putMessage(childRkey, {
			text: "orphan",
			parentAuthor: AUTHOR_A,
			parentRkey: nextTid(),
		});

		const page = await views.messages(SPACE, AUTHOR_B, { limit: 10 });
		expect(asDeletedView(page.messages[0]?.parent)).toBeDefined();
	});

	it("shows a moderator the real parent where others see a stand-in", async () => {
		const parentRkey = nextTid();
		const childRkey = nextTid();
		await putMessage(parentRkey, { text: "hidden parent" });
		await putMessage(childRkey, { text: "reply", parentAuthor: AUTHOR_A, parentRkey });
		await putLabel(parentRkey, "hidden");

		const page = await views.messages(SPACE, AUTHOR_A, { limit: 10 });
		const child = page.messages.find((message) => message.rkey === childRkey);
		expect(asMessageView(child?.parent)).toMatchObject({ text: "hidden parent" });
	});

	it("marks messages from a migrated legacy repo", async () => {
		const rkey = nextTid();
		await putMessage(rkey, { fromLegacyRepo: true });

		const page = await views.messages(SPACE, null, { limit: 10 });
		expect(page.messages[0]?.legacy).toBe(true);
	});
});

describe("ChannelViews.unreadStatus", () => {
	beforeEach(async () => {
		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: AUTHOR_B,
			roles: [],
			joinedAt: NOW,
		});
	});

	it("computes hasUnread and unreadMentions relative to the read cursor", async () => {
		const readRkey = nextTid();
		const unreadRkey = nextTid();
		await putMessage(readRkey);
		await putMessage(unreadRkey);

		await database.db.insert(database.tables.notifications).values({
			id: nextTid(),
			recipient: AUTHOR_B,
			kind: "mention",
			community: COMMUNITY,
			space: SPACE,
			author: AUTHOR_A,
			messageAuthor: AUTHOR_A,
			messageRkey: unreadRkey,
			indexedAt: NOW,
		});

		const beforeReading = await views.unreadStatus(AUTHOR_B, { community: COMMUNITY });
		expect(beforeReading).toHaveLength(1);
		expect(beforeReading[0]).toMatchObject({ hasUnread: true, unreadMentions: 1 });

		await database.db.insert(database.tables.readCursors).values({
			did: AUTHOR_B,
			community: COMMUNITY,
			channel: CHANNEL_SKEY,
			cursor: readRkey,
		});

		const afterReadingFirst = await views.unreadStatus(AUTHOR_B, { community: COMMUNITY });
		expect(afterReadingFirst[0]).toMatchObject({ hasUnread: true, unreadMentions: 1 });

		await database.db
			.update(database.tables.readCursors)
			.set({ cursor: unreadRkey })
			.where(
				and(
					eq(database.tables.readCursors.did, AUTHOR_B),
					eq(database.tables.readCursors.channel, CHANNEL_SKEY),
				),
			);

		const afterReadingAll = await views.unreadStatus(AUTHOR_B, { community: COMMUNITY });
		expect(afterReadingAll[0]).toMatchObject({ hasUnread: false, unreadMentions: 0 });
	});

	it("does not count a hidden message as unread, nor its mention", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await database.db.insert(database.tables.notifications).values({
			id: nextTid(),
			recipient: AUTHOR_B,
			kind: "mention",
			community: COMMUNITY,
			space: SPACE,
			author: AUTHOR_A,
			messageAuthor: AUTHOR_A,
			messageRkey: rkey,
			indexedAt: NOW,
		});

		const before = await views.unreadStatus(AUTHOR_B, { community: COMMUNITY });
		expect(before[0]).toMatchObject({ hasUnread: true, unreadMentions: 1 });

		await putLabel(rkey, "hidden");

		const after = await views.unreadStatus(AUTHOR_B, { community: COMMUNITY });
		expect(after[0]).toMatchObject({ hasUnread: false, unreadMentions: 0 });
	});
});
