import { l } from "@atproto/lex-schema";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { channelSpace, SPACE_TYPES, social, threadSpace } from "@colibri-social/lexicons";
import type { ActorHydrator } from "@colibri-social/notifications";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { handleGetUnseen, handleUpdateSeenForMessage } from "./notification.js";

const NOW = "2026-09-22T00:00:00.000Z";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxxx";
const AUTHOR = "did:plc:authorxxxxxxxxxxxxxxxxxxxxxxx";

const CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel1");
const THREAD = threadSpace(COMMUNITY, "3lkthreadxx1");
const MISSING_THREAD = threadSpace(COMMUNITY, "3lkthreadxx9");

let database: TestDatabase;
let ctx: AppContext;

const noProfiles: ActorHydrator = async () => new Map();

const asGetUnseenOutput = (body: unknown): void => {
	const { output } = l.getMain(social.colibri.beta.notification.getUnseen);
	const result = output.schema.safeValidate(body);
	if (!result.success) throw new Error(result.reason.message);
};

const insertCommunity = async () => {
	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		handle: null,
		name: "Protocol Nerds",
		description: null,
		managingApp: null,
		pictureCid: null,
		bannerCid: null,
		requiresApproval: false,
		linkEmbeds: true,
		labelers: [],
		migratedFrom: null,
		profileSpace: `${COMMUNITY}/profile`,
		configSpace: `${COMMUNITY}/config`,
		membersSpace: `${COMMUNITY}/members`,
		moderationSpace: `${COMMUNITY}/moderation`,
		indexedAt: NOW,
	});
};

const insertMember = async (did: string) => {
	await database.db.insert(database.tables.members).values({
		community: COMMUNITY,
		did,
		roles: [],
		joinedAt: NOW,
		nickname: null,
	});
};

const insertChannel = async () => {
	await database.db.insert(database.tables.channels).values({
		space: CHANNEL,
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
};

const insertThread = async (visibleToMembers: string[] = []) => {
	await database.db.insert(database.tables.threads).values({
		space: THREAD,
		community: COMMUNITY,
		channel: CHANNEL,
		skey: "3lkthreadxx1",
		name: "release planning",
		anchorSpace: null,
		anchorAuthor: null,
		anchorRkey: null,
		anchorCid: null,
		createdBy: AUTHOR,
		createdAt: NOW,
		visibleToRoles: [],
		visibleToMembers,
		lastActivityAt: NOW,
		indexedAt: NOW,
	});
};

const insertMessage = async (space: string, rkey: string) => {
	await database.db.insert(database.tables.messages).values({
		space,
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text: "ship it",
		facets: null,
		createdAt: NOW,
		updatedAt: null,
		parentAuthor: null,
		parentRkey: null,
		attachments: null,
		forward: null,
		suppressedEmbeds: null,
		indexedAt: NOW,
	});
};

const insertNotification = async (id: string, space: string, rkey: string) => {
	await database.db.insert(database.tables.notifications).values({
		id,
		recipient: MEMBER,
		kind: "mention",
		community: COMMUNITY,
		space,
		author: AUTHOR,
		messageAuthor: AUTHOR,
		messageRkey: rkey,
		mentionRole: null,
		indexedAt: NOW,
		seenAt: null,
	});
};

const seenAtFor = async (id: string): Promise<string | null> => {
	const rows = await database.db.select().from(database.tables.notifications);
	return rows.find((row) => row.id === id)?.seenAt ?? null;
};

beforeEach(async () => {
	database = await openTestDatabase();
	ctx = {
		announce: silentAnnouncer,
		database,
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
	} as unknown as AppContext;

	await insertCommunity();
	await insertMember(MEMBER);
	await insertChannel();
});

afterEach(async () => {
	await database.destroy();
});

describe("getUnseen", () => {
	it("serves a thread space, which has no row in channels", async () => {
		await insertThread();
		await insertMessage(THREAD, "3lkmessagex1");
		await insertNotification("n1", THREAD, "3lkmessagex1");

		const body = await handleGetUnseen(ctx, noProfiles, MEMBER, THREAD, 50);
		asGetUnseenOutput(body);

		expect(body.notifications).toHaveLength(1);
		expect(body.notifications[0]?.channel).toBe(CHANNEL);
		expect(body.notifications[0]?.thread).toBe(THREAD);
	});

	it("keeps a channel's unseen list free of its threads", async () => {
		await insertThread();
		await insertMessage(CHANNEL, "3lkmessagex1");
		await insertMessage(THREAD, "3lkmessagex2");
		await insertNotification("n1", CHANNEL, "3lkmessagex1");
		await insertNotification("n2", THREAD, "3lkmessagex2");

		const body = await handleGetUnseen(ctx, noProfiles, MEMBER, CHANNEL, 50);

		expect(body.notifications.map((notification) => notification.id)).toEqual(["n1"]);
	});

	it("reports an unindexed thread as ChannelNotFound", async () => {
		await expect(
			handleGetUnseen(ctx, noProfiles, MEMBER, MISSING_THREAD, 50),
		).rejects.toMatchObject({ customErrorName: "ChannelNotFound" });
	});

	it("hides a private thread behind ChannelNotFound rather than Forbidden", async () => {
		await insertThread([AUTHOR]);
		await insertMessage(THREAD, "3lkmessagex1");
		await insertNotification("n1", THREAD, "3lkmessagex1");

		await expect(handleGetUnseen(ctx, noProfiles, MEMBER, THREAD, 50)).rejects.toMatchObject({
			customErrorName: "ChannelNotFound",
		});
	});
});

describe("updateSeenForMessage", () => {
	it("marks a message in a thread seen", async () => {
		await insertThread();
		await insertMessage(THREAD, "3lkmessagex1");
		await insertNotification("n1", THREAD, "3lkmessagex1");

		const result = await handleUpdateSeenForMessage(ctx, MEMBER, THREAD, AUTHOR, "3lkmessagex1");

		expect(result.unread).toBe(0);
		expect(await seenAtFor("n1")).not.toBeNull();
	});
});
