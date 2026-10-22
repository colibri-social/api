import { l } from "@atproto/lex-schema";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import {
	COLLECTIONS,
	channelSpace,
	LABEL_VALUES,
	SPACE_TYPES,
	social,
	threadSpace,
} from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { handleListSummaries } from "../routes/channel.js";
import { ActorViews } from "./actor.js";
import { ChannelViews } from "./channel.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const AUTHOR_A = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const AUTHOR_B = "did:plc:7fkdlwjqmzcuvvpjbztkbbbb";
const LABELER = "did:plc:labelerlabelerlabelerlabl";
const OTHER_LABELER = "did:plc:notallowednotallowednota";
const CHANNEL_SKEY = "3lkchanneltest0";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, CHANNEL_SKEY);
const THREAD_SKEY = "3lkthreadtest00";
const THREAD = threadSpace(COMMUNITY, THREAD_SKEY);
const SECOND_THREAD_SKEY = "3lkthreadtest01";
const SECOND_THREAD = threadSpace(COMMUNITY, SECOND_THREAD_SKEY);
const NOW = "2026-08-23T00:00:00.000Z";
const ATTACHMENT_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiibsojllbf5xhqzy6a";

let database: TestDatabase;
let ctx: AppContext;
let views: ChannelViews;

type Parent = social.colibri.beta.channel.defs.MessageView["parent"];

const asMessageView = (parent: Parent): social.colibri.beta.channel.defs.MessageView | undefined =>
	parent?.$type === "social.colibri.beta.channel.defs#messageView"
		? (parent as social.colibri.beta.channel.defs.MessageView)
		: undefined;

const asDeletedView = (
	parent: Parent,
): social.colibri.beta.channel.defs.DeletedMessageView | undefined =>
	parent?.$type === "social.colibri.beta.channel.defs#deletedMessageView"
		? (parent as social.colibri.beta.channel.defs.DeletedMessageView)
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

const putMovedLabel = async (
	subjectRkey: string,
	destination: string,
	batch: string,
	overrides: { space?: string; negated?: boolean } = {},
) => {
	await database.db.insert(database.tables.labels).values({
		space: overrides.space ?? SPACE,
		src: COMMUNITY,
		rkey: nextTid(),
		subjectDid: AUTHOR_A,
		subjectCollection: COLLECTIONS.message,
		subjectRkey,
		val: LABEL_VALUES.moved,
		negated: overrides.negated ?? false,
		destination,
		batch,
		createdAt: NOW,
	});
};

const putThread = async (overrides: { space?: string; skey?: string } = {}) => {
	await database.db.insert(database.tables.threads).values({
		space: overrides.space ?? THREAD,
		community: COMMUNITY,
		channel: SPACE,
		skey: overrides.skey ?? THREAD_SKEY,
		name: "side conversation",
		createdBy: AUTHOR_A,
		createdAt: NOW,
		visibleToRoles: [],
		visibleToMembers: [],
		lastActivityAt: NOW,
		indexedAt: NOW,
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
		linkEmbeds: {
			peek: () => undefined,
			resolve: async () => new Map(),
			settle: async () => {},
		},
		identity: {
			resolveDid: async () => {
				throw new Error("no identity in tests");
			},
			resolveVerifiedHandle: async () => {
				throw new Error("no identity in tests");
			},
			resolveVerifiedHandles: async () => {
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

	it("keeps returning a cursor until every page is read, in both directions", async () => {
		const rkeys = [nextTid(), nextTid(), nextTid(), nextTid(), nextTid()];
		for (const rkey of rkeys) await putMessage(rkey);

		const pageAll = async (reverse: boolean) => {
			const pages: string[][] = [];
			let cursor: string | undefined;
			do {
				const page = await views.messages(SPACE, null, { limit: 2, cursor, reverse });
				pages.push(page.messages.map((message) => message.rkey));
				cursor = page.cursor;
			} while (cursor && pages.length < 10);
			return pages;
		};

		expect(await pageAll(false)).toEqual([[rkeys[4], rkeys[3]], [rkeys[2], rkeys[1]], [rkeys[0]]]);
		expect(await pageAll(true)).toEqual([[rkeys[0], rkeys[1]], [rkeys[2], rkeys[3]], [rkeys[4]]]);

		const forward = await views.messages(SPACE, null, {
			limit: 2,
			cursor: rkeys[0],
			reverse: true,
		});
		expect(forward.messages.map((message) => message.rkey)).toEqual([rkeys[1], rkeys[2]]);
		expect(forward.cursor).toBe(rkeys[2]);
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

	it("reports the earliest emoji record named for a custom reaction", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		const first = { uri: `at://${AUTHOR_A}/social.colibri.beta.emoji/3lkemoji1` };
		const later = { uri: `at://${AUTHOR_B}/social.colibri.beta.emoji/3lkemoji2` };
		const reaction = (author: string, customEmoji?: { uri: string }) => ({
			space: SPACE,
			author,
			rkey: nextTid(),
			targetAuthor: AUTHOR_A,
			targetRkey: rkey,
			emoji: ":party:",
			customEmoji,
		});
		await database.db
			.insert(database.tables.reactions)
			.values([reaction(AUTHOR_A, first), reaction(AUTHOR_B, later)]);
		await database.db.insert(database.tables.reactions).values({
			space: SPACE,
			author: AUTHOR_B,
			rkey: nextTid(),
			targetAuthor: AUTHOR_A,
			targetRkey: rkey,
			emoji: "tada",
		});

		const page = await views.messages(SPACE, AUTHOR_B, { limit: 10 });
		const reactions = page.messages[0]?.reactions ?? [];

		expect(reactions.find((entry) => entry.emoji === ":party:")?.customEmoji).toEqual(first);
		expect(reactions.find((entry) => entry.emoji === "tada")?.customEmoji).toBeUndefined();
	});

	it("shows a bridged message's remote author in place of the community", async () => {
		const rkey = nextTid();
		await putMessage(rkey, {
			author: COMMUNITY,
			bridged: {
				registration: "3lkbridgeaaaa",
				platform: "chat",
				remoteId: "alice-1",
				name: "Alice Elsewhere",
				avatar: { $type: "blob", ref: { $link: ATTACHMENT_CID }, mimeType: "image/png", size: 1 },
			},
		});

		const [message] = (await views.messages(SPACE, null, { limit: 10 })).messages;

		expect(message?.author).toMatchObject({
			did: COMMUNITY,
			displayName: "Alice Elsewhere",
			isBot: false,
			bridge: { registration: "3lkbridgeaaaa", platform: "chat", remoteId: "alice-1" },
		});
		const avatar = new URL(message?.author.avatar ?? "");
		expect(avatar.searchParams.get("did")).toBe(COMMUNITY);
		expect(avatar.searchParams.get("cid")).toBe(ATTACHMENT_CID);
		expect(avatar.searchParams.get("space")).toBe(SPACE);
	});

	it("ignores bridged attribution on a message the community did not write", async () => {
		const rkey = nextTid();
		await putMessage(rkey, {
			bridged: {
				registration: "3lkbridgeaaaa",
				platform: "chat",
				remoteId: "mallory",
				name: "Not Really",
			},
		});

		const [message] = (await views.messages(SPACE, null, { limit: 10 })).messages;

		expect(message?.author.did).toBe(AUTHOR_A);
		expect(message?.author.displayName).not.toBe("Not Really");
		expect(message?.author.bridge).toBeUndefined();
	});

	it("counts bridged reactors apart from Colibri reactors", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		const bridgedReaction = (remoteId: string) => ({
			space: SPACE,
			author: COMMUNITY,
			rkey: nextTid(),
			targetAuthor: AUTHOR_A,
			targetRkey: rkey,
			emoji: "thumbsup",
			bridgedFrom: `3lkbridgeaaaa ${remoteId}`,
			bridged: { registration: "3lkbridgeaaaa", platform: "chat", remoteId, name: remoteId },
		});

		await database.db.insert(database.tables.reactions).values([
			bridgedReaction("alice-1"),
			bridgedReaction("bob-1"),
			{
				space: SPACE,
				author: AUTHOR_B,
				rkey: nextTid(),
				targetAuthor: AUTHOR_A,
				targetRkey: rkey,
				emoji: "thumbsup",
			},
		]);

		const [message] = (await views.messages(SPACE, COMMUNITY, { limit: 10 })).messages;
		const [thumbsup] = message?.reactions ?? [];

		expect(thumbsup).toMatchObject({ count: 3, reactors: [AUTHOR_B], viewerReacted: false });
		expect(thumbsup?.bridgedReactors?.map((reactor) => reactor.remoteId).sort()).toEqual([
			"alice-1",
			"bob-1",
		]);
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

	it("drops custom emoji the community's policy disallows and keeps the text", async () => {
		const own = `at://${COMMUNITY}/blue.moji.collection.item/shipit`;
		const foreign = "at://did:plc:otherspaceotherspaceother/blue.moji.collection.item/owl";
		const emoji = (byteStart: number, uri: string) => ({
			index: { byteStart, byteEnd: byteStart + 4 },
			features: [{ $type: "social.colibri.beta.richtext.facet#customEmoji", uri }],
		});
		const rkey = nextTid();
		await putMessage(rkey, { text: "🚀 🦉", facets: [emoji(0, own), emoji(5, foreign)] });
		const uris = async () => {
			const page = await views.messages(SPACE, null, { limit: 10 });
			const message = page.messages[0];
			expect(message?.text).toBe("🚀 🦉");
			return (message?.facets ?? []).map(
				(facet) => (facet.features[0] as { uri?: string } | undefined)?.uri,
			);
		};

		expect(await uris()).toEqual([own, foreign]);

		const setPolicy = (customEmoji: string) =>
			database.db
				.update(database.tables.communities)
				.set({ customEmoji })
				.where(eq(database.tables.communities.did, COMMUNITY));

		await setPolicy("local");
		expect(await uris()).toEqual([own]);

		await setPolicy("none");
		expect(await uris()).toEqual([]);
	});

	it("attaches resolved link previews to the message and leaves its parent bare", async () => {
		const tenor = "https://tenor.com/view/touhou-fumo-plushie-plush-hello-gif-21004226";
		const link = {
			index: { byteStart: 0, byteEnd: tenor.length },
			features: [{ $type: "social.colibri.beta.richtext.facet#link", uri: tenor }],
		};
		const requested: string[][] = [];
		ctx.linkEmbeds = {
			peek: () => undefined,
			resolve: async (uris) => {
				requested.push([...uris]);
				return new Map([[tenor, { uri: `${tenor}#fragment`, siteName: "Tenor" }]]);
			},
			settle: async () => {},
		};
		const parent = nextTid();
		await putMessage(parent, { text: tenor, facets: [link] });
		const reply = nextTid();
		await putMessage(reply, {
			text: tenor,
			facets: [link],
			parentAuthor: AUTHOR_A,
			parentRkey: parent,
		});

		const page = await views.messages(SPACE, null, { limit: 10 });
		const replyView = page.messages.find((message) => message.rkey === reply);

		expect(replyView?.embeds).toEqual([expect.objectContaining({ uri: tenor, siteName: "Tenor" })]);
		expect((replyView?.parent as { embeds?: unknown } | undefined)?.embeds).toBeUndefined();
		expect(requested.flat()).toEqual([tenor, tenor]);
	});

	it("skips links the author suppressed", async () => {
		const uri = "https://example.test/";
		const requested: string[][] = [];
		ctx.linkEmbeds = {
			peek: () => undefined,
			resolve: async (uris) => {
				requested.push([...uris]);
				return new Map();
			},
			settle: async () => {},
		};
		await putMessage(nextTid(), {
			text: uri,
			facets: [
				{
					index: { byteStart: 0, byteEnd: uri.length },
					features: [{ $type: "social.colibri.beta.richtext.facet#link", uri }],
				},
			],
			suppressedEmbeds: [uri],
		});

		const page = await views.messages(SPACE, null, { limit: 10 });

		expect(page.messages[0]?.embeds).toBeUndefined();
		expect(requested.flat()).toEqual([]);
	});
});

describe("ChannelViews attachments", () => {
	it("builds a blob url from an attachment stored in json form", async () => {
		const rkey = nextTid();
		await putMessage(rkey, {
			attachments: [
				{
					name: "shot.png",
					blob: {
						$type: "blob",
						ref: { $link: ATTACHMENT_CID },
						mimeType: "image/png",
						size: 1234,
					},
				},
			],
		});

		const { messages } = await views.messages(SPACE, null, { limit: 1 });
		const [attachment] = messages[0]?.attachments ?? [];
		expect(attachment?.name).toBe("shot.png");
		expect(attachment?.mimeType).toBe("image/png");
		expect(attachment?.url).toContain(`cid=${ATTACHMENT_CID}`);
		expect(attachment?.url).toContain(`space=${encodeURIComponent(SPACE)}`);
	});

	it.each([
		["a nested link", { $link: { $link: ATTACHMENT_CID } }],
		["an ipld link", { $link: { "/": ATTACHMENT_CID } }],
		["a bare ipld link", { "/": ATTACHMENT_CID }],
	])("builds a blob url from a ref stored as %s", async (_, ref) => {
		const rkey = nextTid();
		await putMessage(rkey, {
			attachments: [
				{
					name: "shot.png",
					blob: { $type: "blob", ref, mimeType: "image/png", size: 1234 },
				},
			],
		});

		const { messages } = await views.messages(SPACE, null, { limit: 1 });
		const [attachment] = messages[0]?.attachments ?? [];
		expect(attachment?.url).toContain(`cid=${ATTACHMENT_CID}`);
		expect(attachment?.url).not.toContain("object");
	});

	it("passes the spoiler flag through and omits it when unset", async () => {
		const rkey = nextTid();
		const blob = {
			$type: "blob",
			ref: { $link: ATTACHMENT_CID },
			mimeType: "image/png",
			size: 1234,
		};
		await putMessage(rkey, {
			attachments: [
				{ name: "hidden.png", blob, spoiler: true },
				{ name: "plain.png", blob },
				{ name: "off.png", blob, spoiler: false },
			],
		});

		const { messages } = await views.messages(SPACE, null, { limit: 1 });
		const [hidden, plain, off] = messages[0]?.attachments ?? [];
		expect(hidden?.spoiler).toBe(true);
		expect(plain).not.toHaveProperty("spoiler");
		expect(off).not.toHaveProperty("spoiler");
	});

	it("passes dimensions through only when both are positive integers", async () => {
		const rkey = nextTid();
		const blob = {
			$type: "blob",
			ref: { $link: ATTACHMENT_CID },
			mimeType: "image/png",
			size: 1234,
		};
		await putMessage(rkey, {
			attachments: [
				{ name: "sized.png", blob, width: 160, height: 120 },
				{ name: "half.png", blob, width: 160 },
				{ name: "bad.png", blob, width: 0, height: 1.5 },
			],
		});

		const { messages } = await views.messages(SPACE, null, { limit: 1 });
		const [sized, half, bad] = messages[0]?.attachments ?? [];
		expect(sized).toMatchObject({ width: 160, height: 120 });
		expect(half).not.toHaveProperty("width");
		expect(bad).not.toHaveProperty("width");
		expect(bad).not.toHaveProperty("height");
	});

	it("passes alt text through and omits it when empty", async () => {
		const rkey = nextTid();
		const blob = {
			$type: "blob",
			ref: { $link: ATTACHMENT_CID },
			mimeType: "image/png",
			size: 1234,
		};
		await putMessage(rkey, {
			attachments: [
				{ name: "bird.png", blob, alt: "A colibri hovering at a flower" },
				{ name: "plain.png", blob },
				{ name: "empty.png", blob, alt: "" },
			],
		});

		const { messages } = await views.messages(SPACE, null, { limit: 1 });
		const [described, plain, empty] = messages[0]?.attachments ?? [];
		expect(described?.alt).toBe("A colibri hovering at a flower");
		expect(plain).not.toHaveProperty("alt");
		expect(empty).not.toHaveProperty("alt");
	});

	it("points a moved message's attachment at the space it is being read in", async () => {
		const rkey = nextTid();
		await putMessage(rkey, {
			attachments: [
				{
					name: "shot.png",
					blob: {
						$type: "blob",
						ref: { $link: ATTACHMENT_CID },
						mimeType: "image/png",
						size: 1234,
					},
				},
			],
		});
		await putThread();
		await putMovedLabel(rkey, THREAD, nextTid());

		const { messages } = await views.messages(THREAD, null, { limit: 1 });
		const [attachment] = messages[0]?.attachments ?? [];
		expect(messages[0]?.channel).toBe(SPACE);
		expect(attachment?.url).toContain(`space=${encodeURIComponent(THREAD)}`);
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

	it("counts replies as pings and leaves plain message notifications out", async () => {
		const notify = async (kind: "mention" | "reply" | "message") => {
			const rkey = nextTid();
			await putMessage(rkey);
			await database.db.insert(database.tables.notifications).values({
				id: nextTid(),
				recipient: AUTHOR_B,
				kind,
				community: COMMUNITY,
				space: SPACE,
				author: AUTHOR_A,
				messageAuthor: AUTHOR_A,
				messageRkey: rkey,
				indexedAt: NOW,
			});
		};
		await notify("mention");
		await notify("reply");
		await notify("message");

		const status = await views.unreadStatus(AUTHOR_B, { community: COMMUNITY });
		expect(status[0]).toMatchObject({ hasUnread: true, unreadMentions: 2 });
	});

	it("does not count the caller's own message as unread", async () => {
		await putMessage(nextTid(), { author: AUTHOR_B });

		const own = await views.unreadStatus(AUTHOR_B, { community: COMMUNITY });
		expect(own).toHaveLength(1);
		expect(own[0]).toMatchObject({ hasUnread: false, unreadMentions: 0 });

		await putMessage(nextTid());

		const fromSomeoneElse = await views.unreadStatus(AUTHOR_B, { community: COMMUNITY });
		expect(fromSomeoneElse[0]).toMatchObject({ hasUnread: true });
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

describe("ChannelViews.messages with moved messages", () => {
	it("withholds a moved message from the space it came from", async () => {
		const rkeys = [nextTid(), nextTid()];
		for (const rkey of rkeys) await putMessage(rkey);
		await putThread();
		await putMovedLabel(rkeys[0] as string, THREAD, nextTid());

		const page = await views.messages(SPACE, null, { limit: 10 });
		expect(page.messages.map((message) => message.rkey)).toEqual([rkeys[1]]);
	});

	it("serves a moved message in its destination at its own record key", async () => {
		const older = nextTid();
		const newer = nextTid();
		await putMessage(older);
		await putMessage(newer);
		await putThread();

		const native = nextTid();
		await putMessage(native, { space: THREAD });

		const batch = nextTid();
		await putMovedLabel(older, THREAD, batch);
		await putMovedLabel(newer, THREAD, batch);

		const page = await views.messages(THREAD, null, { limit: 10, reverse: true });
		expect(page.messages.map((message) => message.rkey)).toEqual([older, newer, native]);
		expect(page.messages.map((message) => message.channel)).toEqual([SPACE, SPACE, THREAD]);
	});

	it("pages a moved message that lands before the newest page", async () => {
		const older = nextTid();
		await putMessage(older);
		await putThread();

		const natives = [nextTid(), nextTid(), nextTid()];
		for (const rkey of natives) await putMessage(rkey, { space: THREAD });

		await putMovedLabel(older, THREAD, nextTid());

		const first = await views.messages(THREAD, null, { limit: 2 });
		expect(first.messages.map((message) => message.rkey)).toEqual([natives[2], natives[1]]);
		expect(first.cursor).toBe(natives[1]);

		const second = await views.messages(THREAD, null, { limit: 2, cursor: first.cursor });
		expect(second.messages.map((message) => message.rkey)).toEqual([natives[0], older]);
		expect(second.cursor).toBeUndefined();
	});

	it("follows the newest move when a message is moved on to a second thread", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putThread();
		await putThread({ space: SECOND_THREAD, skey: SECOND_THREAD_SKEY });
		await putMovedLabel(rkey, THREAD, nextTid());
		await putMovedLabel(rkey, SECOND_THREAD, nextTid());

		const first = await views.messages(THREAD, null, { limit: 10 });
		expect(first.messages).toEqual([]);

		const second = await views.messages(SECOND_THREAD, null, { limit: 10 });
		expect(second.messages.map((message) => message.rkey)).toEqual([rkey]);

		const source = await views.messages(SPACE, null, { limit: 10 });
		expect(source.messages).toEqual([]);
	});

	it("keeps a message whose move was retracted", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putThread();
		await putMovedLabel(rkey, THREAD, nextTid());
		await putMovedLabel(rkey, THREAD, nextTid(), { negated: true });

		const source = await views.messages(SPACE, null, { limit: 10 });
		expect(source.messages.map((message) => message.rkey)).toEqual([rkey]);

		const destination = await views.messages(THREAD, null, { limit: 10 });
		expect(destination.messages).toEqual([]);
	});
});

describe("ChannelViews.messages around a message", () => {
	const seed = async (count: number) => {
		const rkeys = Array.from({ length: count }, () => nextTid());
		for (const rkey of rkeys) await putMessage(rkey);
		return rkeys;
	};

	it("centres the page on the message, newest first, with a cursor each way", async () => {
		const rkeys = await seed(7);

		const page = await views.messages(SPACE, null, { limit: 4, around: rkeys[3] });
		expect(page.messages.map((message) => message.rkey)).toEqual([
			rkeys[5],
			rkeys[4],
			rkeys[3],
			rkeys[2],
		]);
		expect(page.cursor).toBe(rkeys[2]);
		expect(page.forwardCursor).toBe(rkeys[5]);

		const older = await views.messages(SPACE, null, { limit: 10, cursor: page.cursor });
		expect(older.messages.map((message) => message.rkey)).toEqual([rkeys[1], rkeys[0]]);

		const newer = await views.messages(SPACE, null, {
			limit: 10,
			cursor: page.forwardCursor,
			reverse: true,
		});
		expect(newer.messages.map((message) => message.rkey)).toEqual([rkeys[6]]);
	});

	it("omits both cursors when the page reaches each end", async () => {
		const rkeys = await seed(3);

		const page = await views.messages(SPACE, null, { limit: 10, around: rkeys[1] });
		expect(page.messages.map((message) => message.rkey)).toEqual([rkeys[2], rkeys[1], rkeys[0]]);
		expect(page.cursor).toBeUndefined();
		expect(page.forwardCursor).toBeUndefined();
	});

	it("ignores cursor and reverse when around is set", async () => {
		const rkeys = await seed(3);

		const page = await views.messages(SPACE, null, {
			limit: 2,
			around: rkeys[1],
			cursor: rkeys[0],
			reverse: true,
		});
		expect(page.messages.map((message) => message.rkey)).toEqual([rkeys[2], rkeys[1]]);
	});

	it("returns only the message at a limit of one, and still points at newer messages", async () => {
		const rkeys = await seed(3);

		const page = await views.messages(SPACE, null, { limit: 1, around: rkeys[1] });
		expect(page.messages.map((message) => message.rkey)).toEqual([rkeys[1]]);
		expect(page.cursor).toBe(rkeys[1]);
		expect(page.forwardCursor).toBe(rkeys[1]);
	});

	it("leaves out a withheld message at the centre", async () => {
		const rkeys = await seed(3);
		await putLabel(rkeys[1] as string, "hidden");

		const page = await views.messages(SPACE, null, { limit: 4, around: rkeys[1] });
		expect(page.messages.map((message) => message.rkey)).toEqual([rkeys[2], rkeys[0]]);
	});
});

describe("ChannelViews.summaries", () => {
	const VOICE = channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, "3lkvoicetest00");
	const QUIET = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkquiettest00");
	const PRIVATE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkprivatetest0");

	const putChannel = async (
		space: string,
		spaceType: string,
		skey: string,
		visibleToMembers: string[] = [],
	) => {
		await database.db.insert(database.tables.channels).values({
			space,
			community: COMMUNITY,
			spaceType,
			skey,
			name: skey,
			position: 1,
			visibleToMembers,
		});
	};

	const asListSummariesOutput = (body: unknown): void => {
		const { output } = l.getMain(social.colibri.beta.channel.listSummaries);
		const result = output.schema.safeValidate(body);
		if (!result.success) throw new Error(result.reason.message);
	};

	const summariesFor = async (did: string) =>
		views.summaries(COMMUNITY, did, await ctx.loader.authz(COMMUNITY, did));

	beforeEach(async () => {
		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: AUTHOR_B,
			roles: [],
			joinedAt: NOW,
		});
	});

	it("summarizes the latest message of each readable text and voice channel", async () => {
		await putChannel(VOICE, SPACE_TYPES.channelVoice, "3lkvoicetest00");
		await putChannel(QUIET, SPACE_TYPES.channelText, "3lkquiettest00");
		await putChannel(PRIVATE, SPACE_TYPES.channelText, "3lkprivatetest0", [AUTHOR_A]);
		await putMessage(nextTid(), { text: "older" });
		const latest = nextTid();
		const blob = (mimeType: string) => ({
			blob: { $type: "blob", ref: { $link: ATTACHMENT_CID }, mimeType, size: 10 },
		});
		await putMessage(latest, {
			author: AUTHOR_B,
			text: "",
			attachments: [blob("video/mp4"), blob("application/pdf")],
			createdAt: "2026-08-24T00:00:00.000Z",
		});
		const voiceLatest = nextTid();
		await putMessage(voiceLatest, { space: VOICE, text: "brb" });
		await putMessage(nextTid(), { space: PRIVATE });

		const summaries = await summariesFor(AUTHOR_B);
		asListSummariesOutput({ summaries });
		expect(summaries).toEqual([
			{
				channel: SPACE,
				rkey: latest,
				author: AUTHOR_B,
				text: "",
				attachmentKind: "image",
				attachmentCount: 2,
				forward: false,
				createdAt: "2026-08-24T00:00:00.000Z",
			},
			{
				channel: VOICE,
				rkey: voiceLatest,
				author: AUTHOR_A,
				text: "brb",
				attachmentCount: 0,
				forward: false,
				createdAt: NOW,
			},
		]);
	});

	it("flags a forward and leaves attachmentKind out when there are no attachments", async () => {
		const rkey = nextTid();
		await putMessage(rkey, {
			text: "",
			forward: { source: { space: SPACE, did: AUTHOR_B, rkey: nextTid() }, text: "hi" },
		});

		const [summary] = await summariesFor(AUTHOR_B);
		expect(summary).toMatchObject({ rkey, forward: true, attachmentCount: 0 });
		expect(summary).not.toHaveProperty("attachmentKind");
	});

	it("carries the latest message's facets and drops custom emoji the policy disallows", async () => {
		const own = `at://${COMMUNITY}/blue.moji.collection.item/kek`;
		const foreign = "at://did:plc:otherspaceotherspaceother/blue.moji.collection.item/owl";
		const emoji = (byteStart: number, byteEnd: number, uri: string) => ({
			index: { byteStart, byteEnd },
			features: [{ $type: "social.colibri.beta.richtext.facet#customEmoji", uri }],
		});
		await putMessage(nextTid(), {
			text: "fine :kek: :owl:",
			facets: [emoji(5, 10, own), emoji(11, 16, foreign)],
		});
		const uris = async () => {
			const [summary] = await summariesFor(AUTHOR_B);
			return (summary?.facets ?? []).map(
				(facet) => (facet.features[0] as { uri?: string } | undefined)?.uri,
			);
		};

		expect(await uris()).toEqual([own, foreign]);

		await database.db
			.update(database.tables.communities)
			.set({ customEmoji: "local" })
			.where(eq(database.tables.communities.did, COMMUNITY));
		expect(await uris()).toEqual([own]);

		await database.db
			.update(database.tables.communities)
			.set({ customEmoji: "none" })
			.where(eq(database.tables.communities.did, COMMUNITY));
		const [summary] = await summariesFor(AUTHOR_B);
		expect(summary).not.toHaveProperty("facets");
	});

	it("skips a withheld message, but shows it to its own author", async () => {
		const visible = nextTid();
		const hidden = nextTid();
		await putMessage(visible);
		await putMessage(hidden);
		await putLabel(hidden, "hidden");

		const [forMember] = await summariesFor(AUTHOR_B);
		expect(forMember?.rkey).toBe(visible);

		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: AUTHOR_A,
			roles: [],
			joinedAt: NOW,
		});
		const [forAuthor] = await summariesFor(AUTHOR_A);
		expect(forAuthor?.rkey).toBe(hidden);
	});

	it("leaves out a channel whose only message was moved away", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putThread();
		await putMovedLabel(rkey, THREAD, nextTid());

		expect(await summariesFor(AUTHOR_B)).toEqual([]);
	});

	it("rejects a caller who is not a member", async () => {
		await expect(
			handleListSummaries(ctx, views, COMMUNITY, "did:plc:outsideroutsideroutsiderx"),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
	});

	it("rejects an unknown community", async () => {
		await expect(
			handleListSummaries(ctx, views, "did:plc:nocommunitynocommunitynoc", AUTHOR_B),
		).rejects.toMatchObject({ customErrorName: "CommunityNotFound" });
	});
});
