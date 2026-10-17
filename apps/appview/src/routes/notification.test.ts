import { l } from "@atproto/lex-schema";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { channelSpace, SPACE_TYPES, social, threadSpace } from "@colibri-social/lexicons";
import { type ActorHydrator, issueReadToken } from "@colibri-social/notifications";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import type { ServerFrame } from "../ws/events.js";
import {
	handleClear,
	handleGetUnreadCount,
	handleGetUnseen,
	handleListNotifications,
	handleMarkReadFromNotification,
	handleUpdateSeenForMessage,
} from "./notification.js";

const readMoved = vi.fn();

vi.mock("../push-delivery.js", () => ({
	pushDelivery: () => ({ readMoved }),
}));

const NOW = "2026-09-22T00:00:00.000Z";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxxx";
const AUTHOR = "did:plc:authorxxxxxxxxxxxxxxxxxxxxxxx";

const CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel1");
const THREAD = threadSpace(COMMUNITY, "3lkthreadxx1");
const MISSING_THREAD = threadSpace(COMMUNITY, "3lkthreadxx9");

const SECRET = "p".repeat(32);
const NOW_MS = Date.parse(NOW);

let database: TestDatabase;
let ctx: AppContext;
let announced: { did: string; frame: ServerFrame }[];

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

const insertNotification = async (
	id: string,
	space: string,
	rkey: string,
	indexedAt: string = NOW,
) => {
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
		indexedAt,
		seenAt: null,
	});
};

const seenAtFor = async (id: string): Promise<string | null> => {
	const rows = await database.db.select().from(database.tables.notifications);
	return rows.find((row) => row.id === id)?.seenAt ?? null;
};

beforeEach(async () => {
	database = await openTestDatabase();
	announced = [];
	readMoved.mockClear();
	ctx = {
		announce: {
			...silentAnnouncer,
			toUser: (did: string, frame: ServerFrame) => announced.push({ did, frame }),
		},
		config: { PUSH_ACTION_SECRET: SECRET, PUBLIC_URL: "https://appview.test" },
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
		expect(body.notifications[0]?.threadName).toBe("release planning");
	});

	it("leaves threadName unset for a notification raised in the channel itself", async () => {
		await insertMessage(CHANNEL, "3lkmessagex1");
		await insertNotification("n1", CHANNEL, "3lkmessagex1");

		const body = await handleGetUnseen(ctx, noProfiles, MEMBER, CHANNEL, 50);

		expect(body.notifications[0]?.thread).toBeUndefined();
		expect(body.notifications[0]?.threadName).toBeUndefined();
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

describe("clear", () => {
	const LATER = "2026-09-23T00:00:00.000Z";

	const asClearOutput = (body: unknown): void => {
		const { output } = l.getMain(social.colibri.beta.notification.clear);
		const result = output.schema.safeValidate(body);
		if (!result.success) throw new Error(result.reason.message);
	};

	it("hides and marks seen everything raised at or before the cleared point", async () => {
		await insertMessage(CHANNEL, "3lkmessagex1");
		await insertMessage(CHANNEL, "3lkmessagex2");
		await insertNotification("n1", CHANNEL, "3lkmessagex1");
		await insertNotification("n2", CHANNEL, "3lkmessagex2", LATER);

		const result = await handleClear(ctx, MEMBER, NOW);
		asClearOutput(result);

		expect(result).toEqual({ clearedAt: NOW, unread: 1 });
		expect(await seenAtFor("n1")).toBe(NOW);
		expect(await seenAtFor("n2")).toBeNull();

		const listed = await handleListNotifications(ctx, noProfiles, MEMBER, {});
		expect(listed.notifications.map((notification) => notification.id)).toEqual(["n2"]);
		expect(await handleGetUnreadCount(ctx, MEMBER)).toEqual({ count: 1 });
		const unseen = await handleGetUnseen(ctx, noProfiles, MEMBER, CHANNEL, 50);
		expect(unseen.notifications.map((notification) => notification.id)).toEqual(["n2"]);
	});

	it("keeps a notification hidden after it is marked unseen again", async () => {
		await insertMessage(CHANNEL, "3lkmessagex1");
		await insertNotification("n1", CHANNEL, "3lkmessagex1");
		await handleClear(ctx, MEMBER, NOW);

		await database.db
			.update(database.tables.notifications)
			.set({ seenAt: null })
			.where(eq(database.tables.notifications.id, "n1"));

		expect(await handleGetUnreadCount(ctx, MEMBER)).toEqual({ count: 0 });
		const unseen = await handleGetUnseen(ctx, noProfiles, MEMBER, CHANNEL, 50);
		expect(unseen.notifications).toEqual([]);
	});

	it("never moves the cleared point backwards", async () => {
		await handleClear(ctx, MEMBER, LATER);
		const result = await handleClear(ctx, MEMBER, NOW);

		expect(result.clearedAt).toBe(LATER);
	});

	it("treats a cleared point in the future as now", async () => {
		const before = new Date().toISOString();
		const result = await handleClear(ctx, MEMBER, "2999-01-01T00:00:00.000Z");
		const after = new Date().toISOString();

		expect(result.clearedAt >= before && result.clearedAt <= after).toBe(true);
	});

	it("leaves other users' notifications alone", async () => {
		await insertMember(AUTHOR);
		await insertMessage(CHANNEL, "3lkmessagex1");
		await insertNotification("n1", CHANNEL, "3lkmessagex1");

		await handleClear(ctx, AUTHOR, LATER);

		expect(await seenAtFor("n1")).toBeNull();
		expect(await handleGetUnreadCount(ctx, MEMBER)).toEqual({ count: 1 });
	});

	it("tells the caller's other sessions where the inbox was cleared to", async () => {
		await handleClear(ctx, MEMBER, NOW);

		expect(announced).toEqual([
			{
				did: MEMBER,
				frame: {
					$type: "social.colibri.beta.sync.defs#seenEvent",
					unread: 0,
					seenAt: NOW,
					clearedAt: NOW,
				},
			},
		]);
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

	it("tells the caller's other sessions which message was seen", async () => {
		const announced: { did: string; frame: Record<string, unknown> }[] = [];
		ctx = {
			...ctx,
			announce: {
				...silentAnnouncer,
				toUser: (did: string, frame: Record<string, unknown>) => announced.push({ did, frame }),
			},
		} as AppContext;
		await insertMessage(CHANNEL, "3lkmessagex1");
		await insertNotification("n1", CHANNEL, "3lkmessagex1");

		await handleUpdateSeenForMessage(ctx, MEMBER, CHANNEL, AUTHOR, "3lkmessagex1");

		expect(announced).toEqual([
			{
				did: MEMBER,
				frame: expect.objectContaining({
					$type: "social.colibri.beta.sync.defs#seenEvent",
					unread: 0,
					channel: CHANNEL,
					message: { did: AUTHOR, rkey: "3lkmessagex1" },
				}),
			},
		]);
	});
});

describe("markReadFromNotification", () => {
	const token = (channel: string, through: string, did = MEMBER, nowMs = NOW_MS) =>
		issueReadToken(SECRET, { did, channel, through }, nowMs);

	const cursors = async () =>
		database.db
			.select({
				channel: database.tables.readCursors.channel,
				cursor: database.tables.readCursors.cursor,
			})
			.from(database.tables.readCursors)
			.where(eq(database.tables.readCursors.did, MEMBER));

	it("moves the read cursor, marks the channel's notifications seen and tells every session", async () => {
		await insertNotification("n1", CHANNEL, "3lkmessagex1");
		await insertNotification("n2", CHANNEL, "3lkmessagex2");
		await insertNotification("n3", CHANNEL, "3lkmessagex3");

		await handleMarkReadFromNotification(ctx, token(CHANNEL, "3lkmessagex2"), NOW_MS);

		expect(await cursors()).toEqual([{ channel: "3lkchannel1", cursor: "3lkmessagex2" }]);
		expect(await seenAtFor("n1")).toBe(NOW);
		expect(await seenAtFor("n2")).toBe(NOW);
		expect(await seenAtFor("n3")).toBeNull();

		expect(announced.map((entry) => entry.frame.$type)).toEqual([
			"social.colibri.beta.sync.defs#seenEvent",
			"social.colibri.beta.sync.defs#seenEvent",
			"social.colibri.beta.sync.defs#readCursorEvent",
		]);
		expect(announced[0]?.frame).toMatchObject({ unread: 1, channel: CHANNEL });
		expect(announced[2]?.frame).toEqual({
			$type: "social.colibri.beta.sync.defs#readCursorEvent",
			community: COMMUNITY,
			cursors: [{ channel: "3lkchannel1", cursor: "3lkmessagex2" }],
		});
		expect(readMoved).toHaveBeenCalledWith(MEMBER, COMMUNITY, [
			{ channel: "3lkchannel1", cursor: "3lkmessagex2" },
		]);
	});

	it("marks a thread read under the thread's own key", async () => {
		await insertThread();
		await insertNotification("n1", THREAD, "3lkmessagex1");

		await handleMarkReadFromNotification(ctx, token(THREAD, "3lkmessagex1"), NOW_MS);

		expect(await cursors()).toEqual([{ channel: "3lkthreadxx1", cursor: "3lkmessagex1" }]);
		expect(await seenAtFor("n1")).toBe(NOW);
	});

	it("never moves the cursor backwards", async () => {
		await handleMarkReadFromNotification(ctx, token(CHANNEL, "3lkmessagex5"), NOW_MS);
		await handleMarkReadFromNotification(ctx, token(CHANNEL, "3lkmessagex3"), NOW_MS);

		expect(await cursors()).toEqual([{ channel: "3lkchannel1", cursor: "3lkmessagex5" }]);
		expect(readMoved).toHaveBeenCalledTimes(1);
	});

	it("rejects an expired token", async () => {
		const expired = token(CHANNEL, "3lkmessagex1", MEMBER, NOW_MS - 8 * 24 * 60 * 60 * 1000);

		await expect(handleMarkReadFromNotification(ctx, expired, NOW_MS)).rejects.toMatchObject({
			customErrorName: "ExpiredToken",
		});
		expect(await cursors()).toEqual([]);
	});

	it("rejects a tampered token", async () => {
		const [claims, signature] = token(CHANNEL, "3lkmessagex1").split(".");
		const parsed = JSON.parse(Buffer.from(claims ?? "", "base64url").toString("utf8"));
		const forged = `${Buffer.from(JSON.stringify({ ...parsed, did: AUTHOR })).toString("base64url")}.${signature}`;

		await expect(handleMarkReadFromNotification(ctx, forged, NOW_MS)).rejects.toMatchObject({
			customErrorName: "InvalidToken",
		});
		expect(await cursors()).toEqual([]);
	});

	it("rejects a token for a channel that does not exist", async () => {
		await expect(
			handleMarkReadFromNotification(ctx, token(MISSING_THREAD, "3lkmessagex1"), NOW_MS),
		).rejects.toMatchObject({ customErrorName: "InvalidToken" });
		await expect(
			handleMarkReadFromNotification(ctx, token("not-a-space", "3lkmessagex1"), NOW_MS),
		).rejects.toMatchObject({ customErrorName: "InvalidToken" });
		expect(await cursors()).toEqual([]);
	});

	it("rejects every token while no secret is configured", async () => {
		const unsigned = { ...ctx, config: { PUBLIC_URL: "https://appview.test" } } as AppContext;

		await expect(
			handleMarkReadFromNotification(unsigned, token(CHANNEL, "3lkmessagex1"), NOW_MS),
		).rejects.toMatchObject({ customErrorName: "InvalidToken" });
	});
});
