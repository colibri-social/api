import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { channelSpace, SPACE_TYPES, threadSpace } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDeps } from "./deps.js";
import { nextId } from "./id.js";
import {
	attachmentFallbackBody,
	buildDeletePayload,
	buildPayload,
	buildReadPayload,
	type DeliveryOutcome,
	deliverMessageDeleted,
	deliverMessageEdited,
	deliverNotification,
	deliverRead,
	fcmMessage,
	nullPushSender,
	type PushPayload,
	type PushSender,
	webPushBody,
} from "./push.js";
import { verifyReadToken } from "./read-token.js";
import {
	listSubscriptionsForActor,
	registerApns,
	registerFcm,
	registerWebPush,
} from "./subscriptions.js";

const ACTOR = "did:plc:actor000000000000000000000";
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let deps: NotificationDeps;

const fakeSender = (outcome: DeliveryOutcome): PushSender => ({
	send: async () => outcome,
});

beforeEach(async () => {
	database = await openTestDatabase();
	deps = {
		db: database.db,
		tables: database.tables,
		now: () => NOW,
		mayRead: async () => true,
	};
});

afterEach(async () => {
	await database.destroy();
});

const notification = {
	recipient: ACTOR,
	kind: "message",
	mentionRole: null,
	space: "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel1",
	author: "did:plc:author00000000000000000000",
	messageRkey: "3lkmsg1",
};

describe("deliverNotification", () => {
	it("prunes a subscription the provider reports as permanently gone", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});

		await deliverNotification(deps, { webpush: fakeSender("gone") }, notification, { text: "hi" });

		expect(await listSubscriptionsForActor(deps, ACTOR)).toHaveLength(0);
	});

	it("keeps a subscription after a transient failure", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});

		await deliverNotification(deps, { webpush: fakeSender("failed") }, notification, {
			text: "hi",
		});

		expect(await listSubscriptionsForActor(deps, ACTOR)).toHaveLength(1);
	});

	it("prunes only the fcm subscription reported gone, keeping the web push one", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});
		await registerFcm(deps, { actor: ACTOR, platform: "android", token: "token-1" });

		await deliverNotification(
			deps,
			{ webpush: fakeSender("delivered"), fcm: fakeSender("gone") },
			notification,
			{ text: "hi" },
		);

		const rows = await listSubscriptionsForActor(deps, ACTOR);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.provider).toBe("webpush");
	});

	it("dispatches apns subscriptions to the apns sender", async () => {
		await registerFcm(deps, { actor: ACTOR, platform: "android", token: "token-1" });
		await registerApns(deps, {
			actor: ACTOR,
			platform: "ios",
			token: "a".repeat(64),
			environment: "production",
		});

		await deliverNotification(
			deps,
			{ fcm: fakeSender("delivered"), apns: fakeSender("gone") },
			notification,
			{ text: "hi" },
		);

		const rows = await listSubscriptionsForActor(deps, ACTOR);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.provider).toBe("fcm");
	});

	it("never throws when no sender is configured for a subscription's provider", async () => {
		await registerFcm(deps, { actor: ACTOR, platform: "android", token: "token-1" });
		await expect(
			deliverNotification(deps, {}, notification, { text: "hi" }),
		).resolves.toBeUndefined();
		expect(await listSubscriptionsForActor(deps, ACTOR)).toHaveLength(1);
	});

	it("is a no-op when the recipient has no subscriptions", async () => {
		await expect(
			deliverNotification(deps, { webpush: nullPushSender }, notification, { text: "hi" }),
		).resolves.toBeUndefined();
	});
});

describe("buildPayload", () => {
	const channel = "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel1";
	const thread = "at://did:plc:community/space/social.colibri.beta.channel.thread/3lkthread1";

	it("carries every field the native shells and the old clients read", () => {
		const payload = buildPayload(
			{ ...notification, kind: "mention" },
			{ text: "hi" },
			{
				channel,
				sender: { name: "Alice", avatar: "https://appview.example/a.jpg" },
				spaceName: "Protocol Nerds",
				channelName: "general",
			},
			{
				badge: 4,
				readAction: { url: "https://appview.example/xrpc/mark", token: "claims.signature" },
			},
		);

		expect(payload).toMatchObject({
			type: "message",
			kind: "mention",
			title: "New mention",
			body: "hi",
			tag: `${notification.author}/${notification.messageRkey}`,
		});
		expect(payload.data).toEqual({
			type: "message",
			kind: "mention",
			channelUri: channel,
			messageUri: `${channel}/${notification.author}/social.colibri.beta.message/${notification.messageRkey}`,
			authorName: "Alice",
			authorAvatarUrl: "https://appview.example/a.jpg",
			spaceName: "Protocol Nerds",
			placeName: "general",
			subtitle: "Mentioned you · Protocol Nerds › #general",
			body: "hi",
			badge: "4",
			readUrl: "https://appview.example/xrpc/mark",
			readToken: "claims.signature",
			channel: notification.space,
			messageAuthor: notification.author,
			messageRkey: notification.messageRkey,
			deepLink:
				"social.colibri:/channel/did:plc:community/social.colibri.beta.channel.text/3lkchannel1",
			tag: `${notification.author}/${notification.messageRkey}`,
			title: "New mention",
		});
	});

	it("routes a thread message to its parent channel and names the thread", () => {
		const payload = buildPayload(
			{ ...notification, kind: "reply", space: thread },
			{ text: "hi" },
			{ channel, thread, spaceName: "Protocol Nerds", channelName: "general", threadName: "Plans" },
		);

		expect(payload.data).toMatchObject({
			channel: thread,
			channelUri: channel,
			threadUri: thread,
			placeName: "Plans",
			subtitle: "Replied to you · Protocol Nerds › Plans",
			messageUri: `${thread}/${notification.author}/social.colibri.beta.message/${notification.messageRkey}`,
			deepLink:
				"social.colibri:/channel/did:plc:community/social.colibri.beta.channel.text/3lkchannel1",
		});
	});

	it("falls back to the author DID, the channel key and a zero badge", () => {
		const payload = buildPayload(notification, { text: "hi" });

		expect(payload.data).toMatchObject({
			authorName: notification.author,
			spaceName: "",
			placeName: "3lkchannel1",
			subtitle: "#3lkchannel1",
			badge: "0",
		});
		expect(payload.data.readUrl).toBeUndefined();
		expect(payload.data.readToken).toBeUndefined();
	});

	it("leaves the routing hints off when the space ref is malformed", () => {
		const payload = buildPayload({ ...notification, space: "not-a-space-ref" }, { text: "hi" });

		expect(payload.data.messageUri).toBeUndefined();
		expect(payload.data.deepLink).toBeUndefined();
		expect(payload.data.channel).toBe("not-a-space-ref");
	});

	it("marks an edit with its own type and keeps the message tag", () => {
		const payload = buildPayload(notification, { text: "fixed" }, { channel }, { type: "edit" });

		expect(payload.type).toBe("edit");
		expect(payload.data.type).toBe("edit");
		expect(payload.data.body).toBe("fixed");
		expect(payload.tag).toBe(`${notification.author}/${notification.messageRkey}`);
	});
});

describe("attachment pushes", () => {
	const image = (url: string) => ({ mimeType: "image/png", url });
	const file = { mimeType: "application/pdf", url: "https://appview.example/file" };

	it("names what was sent when a message has attachments but no text", () => {
		expect(attachmentFallbackBody([])).toBeUndefined();
		expect(attachmentFallbackBody([image("a")])).toBe("Sent a photo");
		expect(attachmentFallbackBody([image("a"), image("b")])).toBe("Sent 2 photos");
		expect(attachmentFallbackBody([file])).toBe("Sent an attachment");
		expect(attachmentFallbackBody([image("a"), file])).toBe("Sent 2 attachments");
	});

	it("uses the fallback body and the first image URL for an attachment-only message", () => {
		const payload = buildPayload(notification, {
			text: "",
			attachments: [
				file,
				image("https://appview.example/one"),
				image("https://appview.example/two"),
			],
		});

		expect(payload.body).toBe("Sent 3 attachments");
		expect(payload.data.body).toBe("Sent 3 attachments");
		expect(payload.data.imageUrl).toBe("https://appview.example/one");
		expect(fcmMessage("token-1", payload).data.imageUrl).toBe("https://appview.example/one");
	});

	it("keeps the message text and skips spoilered images", () => {
		const payload = buildPayload(notification, {
			text: "look",
			attachments: [
				{ ...image("https://appview.example/hidden"), spoiler: true },
				image("https://appview.example/shown"),
			],
		});

		expect(payload.data.body).toBe("look");
		expect(payload.data.imageUrl).toBe("https://appview.example/shown");
	});

	it("leaves the image URL off when no image can be shown", () => {
		const payload = buildPayload(notification, {
			text: "",
			attachments: [{ ...image("https://appview.example/hidden"), spoiler: true }, file],
		});

		expect(payload.data.imageUrl).toBeUndefined();
		expect(payload.data.body).toBe("Sent 2 attachments");
	});
});

describe("provider bodies", () => {
	const payload = buildPayload(notification, { text: "hi" }, undefined, { badge: 2 });

	it("sends only strings to FCM, high priority for messages and normal for updates", () => {
		const message = fcmMessage("token-1", payload);
		expect(message.android.priority).toBe("high");
		for (const value of Object.values(message.data)) expect(typeof value).toBe("string");
		expect(message.data.badge).toBe("2");

		const read = fcmMessage(
			"token-1",
			buildReadPayload({ channel: notification.space, through: "3lkmsg1" }, 1),
		);
		expect(read.android.priority).toBe("normal");
		expect(read.data).toEqual({
			type: "read",
			channelUri: notification.space,
			through: "3lkmsg1",
			badge: "1",
		});
	});

	it("sends web push as type, title, body, tag and data", () => {
		expect(JSON.parse(webPushBody(payload))).toEqual({
			type: "message",
			kind: "message",
			title: "New message",
			body: "hi",
			tag: payload.tag,
			data: payload.data,
		});
		expect(
			JSON.parse(webPushBody(buildReadPayload({ channel: notification.space, through: "3" }, 0))),
		).toEqual({
			type: "read",
			data: { type: "read", channelUri: notification.space, through: "3", badge: "0" },
		});
	});

	it("tags a delete with the message so it can replace the tray entry", () => {
		const payload = buildDeletePayload(
			{ space: notification.space, author: notification.author, rkey: notification.messageRkey },
			{ channel: notification.space },
			5,
		);
		expect(payload).toEqual({
			type: "delete",
			tag: `${notification.author}/${notification.messageRkey}`,
			data: {
				type: "delete",
				channelUri: notification.space,
				messageUri: `${notification.space}/${notification.author}/social.colibri.beta.message/${notification.messageRkey}`,
				badge: "5",
				channel: notification.space,
				messageAuthor: notification.author,
				messageRkey: notification.messageRkey,
				tag: `${notification.author}/${notification.messageRkey}`,
			},
		});
	});
});

describe("delivery with place, badge and read action", () => {
	const COMMUNITY = "did:plc:community0000000000000000";
	const OTHER_COMMUNITY = "did:plc:othercommunity000000000000";
	const CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel1");
	const THREAD = threadSpace(COMMUNITY, "3lkthread1");
	const SECRET = "s".repeat(32);
	const NOW_MS = Date.parse(NOW);

	let sent: { provider: string; payload: PushPayload }[];

	const recording = (provider: string): PushSender => ({
		send: async (_subscription, payload) => {
			sent.push({ provider, payload });
			return "delivered";
		},
	});

	const senders = () => ({ fcm: recording("fcm"), apns: recording("apns") });

	const insertNotification = async (
		overrides: Partial<{
			recipient: string;
			kind: "mention" | "reply" | "message";
			community: string;
			space: string;
			messageRkey: string;
			indexedAt: string;
			seenAt: string | null;
		}> = {},
	) => {
		const row = {
			id: nextId(),
			recipient: overrides.recipient ?? ACTOR,
			kind: overrides.kind ?? ("mention" as const),
			community: overrides.community ?? COMMUNITY,
			space: overrides.space ?? CHANNEL,
			author: notification.author,
			messageAuthor: notification.author,
			messageRkey: overrides.messageRkey ?? "3lkmsg1",
			mentionRole: null,
			indexedAt: overrides.indexedAt ?? NOW,
			seenAt: overrides.seenAt ?? null,
		};
		await database.db.insert(database.tables.notifications).values(row);
		return row;
	};

	beforeEach(async () => {
		sent = [];
		await database.db.insert(database.tables.communities).values({
			did: COMMUNITY,
			name: "Protocol Nerds",
			labelers: [],
			profileSpace: `${COMMUNITY}/profile`,
			configSpace: `${COMMUNITY}/config`,
			membersSpace: `${COMMUNITY}/members`,
			moderationSpace: `${COMMUNITY}/moderation`,
			indexedAt: NOW,
		});
		await database.db.insert(database.tables.channels).values({
			space: CHANNEL,
			community: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey: "3lkchannel1",
			name: "general",
		});
		await database.db.insert(database.tables.threads).values({
			space: THREAD,
			community: COMMUNITY,
			channel: CHANNEL,
			skey: "3lkthread1",
			name: "Launch plans",
			createdBy: notification.author,
			createdAt: NOW,
			visibleToRoles: [],
			visibleToMembers: [],
			lastActivityAt: NOW,
			indexedAt: NOW,
		});
		await registerFcm(deps, { actor: ACTOR, platform: "android", token: "token-1" });
		await registerApns(deps, {
			actor: ACTOR,
			platform: "ios",
			token: "a".repeat(64),
			environment: "production",
		});
	});

	it("names the Space and channel, counts the badge and signs a read token", async () => {
		const row = await insertNotification();
		await insertNotification({ messageRkey: "3lkmsg0", kind: "reply" });
		await insertNotification({ messageRkey: "3lkmsgx", kind: "message" });

		await deliverNotification(
			deps,
			senders(),
			row,
			{ text: "hi" },
			{ channel: CHANNEL, sender: { name: "Alice" } },
			{
				readAction: { url: "https://appview.example/xrpc/mark", secret: SECRET, now: () => NOW_MS },
			},
		);

		expect(sent.map((entry) => entry.provider).sort()).toEqual(["apns", "fcm"]);
		const data = sent[0]?.payload.data;
		expect(data).toMatchObject({
			type: "message",
			spaceName: "Protocol Nerds",
			placeName: "general",
			subtitle: "Mentioned you · Protocol Nerds › #general",
			badge: "2",
			readUrl: "https://appview.example/xrpc/mark",
		});
		const verified = verifyReadToken(SECRET, data?.readToken ?? "", NOW_MS);
		expect(verified).toEqual({
			ok: true,
			claims: {
				did: ACTOR,
				channel: CHANNEL,
				through: "3lkmsg1",
				exp: Math.floor((NOW_MS + 7 * 24 * 60 * 60 * 1000) / 1000),
			},
		});
	});

	it("resolves a thread to its parent channel and signs the token for the thread", async () => {
		const row = await insertNotification({ space: THREAD, kind: "reply" });

		await deliverNotification(deps, senders(), row, { text: "hi" }, undefined, {
			readAction: { url: "https://appview.example/xrpc/mark", secret: SECRET, now: () => NOW_MS },
		});

		const data = sent[0]?.payload.data;
		expect(data).toMatchObject({
			channelUri: CHANNEL,
			threadUri: THREAD,
			placeName: "Launch plans",
			subtitle: "Replied to you · Protocol Nerds › Launch plans",
		});
		const verified = verifyReadToken(SECRET, data?.readToken ?? "", NOW_MS);
		expect(verified.ok && verified.claims.channel).toBe(THREAD);
	});

	it("leaves muted Spaces, seen rows and plain messages out of the badge", async () => {
		const row = await insertNotification();
		await insertNotification({ messageRkey: "3lkmsg2", seenAt: NOW });
		await insertNotification({ messageRkey: "3lkmsg3", community: OTHER_COMMUNITY });
		await database.db.insert(database.tables.mutes).values({
			did: ACTOR,
			rkey: "3lkmute1",
			subject: OTHER_COMMUNITY,
			createdAt: NOW,
		});

		await deliverNotification(deps, senders(), row, { text: "hi" });

		expect(sent[0]?.payload.data.badge).toBe("1");
	});

	it("sends a delete to every recipient notified about the message", async () => {
		const other = "did:plc:other00000000000000000000";
		await registerFcm(deps, { actor: other, platform: "android", token: "token-2" });
		await insertNotification();
		await insertNotification({ recipient: other, kind: "message" });
		await insertNotification({ messageRkey: "3lkunrelated" });

		const count = await deliverMessageDeleted(deps, senders(), {
			space: CHANNEL,
			author: notification.author,
			rkey: "3lkmsg1",
		});

		expect(count).toBe(2);
		expect(sent).toHaveLength(3);
		for (const { payload } of sent) {
			expect(payload.type).toBe("delete");
			expect(payload.tag).toBe(`${notification.author}/3lkmsg1`);
			expect(payload.data.channelUri).toBe(CHANNEL);
		}
	});

	it("keeps read, delete and edit pushes away from web push", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});
		const row = await insertNotification();
		const withWeb = { ...senders(), webpush: recording("webpush") };

		await deliverNotification(deps, withWeb, row, { text: "hi" });
		await deliverMessageEdited(
			deps,
			withWeb,
			{ space: CHANNEL, author: notification.author, rkey: "3lkmsg1", text: "edited" },
			undefined,
		);
		await deliverMessageDeleted(deps, withWeb, {
			space: CHANNEL,
			author: notification.author,
			rkey: "3lkmsg1",
		});
		await deliverRead(deps, withWeb, ACTOR, { channel: CHANNEL, through: "3lkmsg1" });

		const web = sent.filter((entry) => entry.provider === "webpush");
		expect(web.map((entry) => entry.payload.type)).toEqual(["message"]);
		expect(sent.filter((entry) => entry.provider !== "webpush")).toHaveLength(8);
	});

	it("sends nothing for a deleted message nobody was notified about", async () => {
		expect(
			await deliverMessageDeleted(deps, senders(), {
				space: CHANNEL,
				author: notification.author,
				rkey: "3lknobody",
			}),
		).toBe(0);
		expect(sent).toEqual([]);
	});

	it("sends an edit with the new body and the full banner fields", async () => {
		await insertNotification({ space: THREAD });

		const count = await deliverMessageEdited(
			deps,
			senders(),
			{ space: THREAD, author: notification.author, rkey: "3lkmsg1", text: "fixed typo" },
			{ name: "Alice" },
		);

		expect(count).toBe(1);
		expect(sent).toHaveLength(2);
		expect(sent[0]?.payload).toMatchObject({
			type: "edit",
			tag: `${notification.author}/3lkmsg1`,
			data: {
				type: "edit",
				body: "fixed typo",
				authorName: "Alice",
				channelUri: CHANNEL,
				threadUri: THREAD,
				subtitle: "Mentioned you · Protocol Nerds › Launch plans",
			},
		});
	});

	it("carries the recipient's attachments on an edit", async () => {
		await insertNotification({ space: THREAD });

		await deliverMessageEdited(
			deps,
			senders(),
			{ space: THREAD, author: notification.author, rkey: "3lkmsg1", text: "" },
			{ name: "Alice" },
			{
				attachmentsFor: (recipient) => [
					{ mimeType: "image/jpeg", url: `https://appview.example/blob?viewer=${recipient}` },
				],
			},
		);

		expect(sent[0]?.payload).toMatchObject({
			data: {
				body: "Sent a photo",
				imageUrl: `https://appview.example/blob?viewer=${ACTOR}`,
			},
		});
	});

	it("asks for the edit sender once per recipient", async () => {
		await insertNotification({ space: THREAD });
		const asked: string[] = [];

		await deliverMessageEdited(
			deps,
			senders(),
			{ space: THREAD, author: notification.author, rkey: "3lkmsg1", text: "fixed typo" },
			(recipient) => {
				asked.push(recipient);
				return { name: "Remote Ruth" };
			},
		);

		expect(asked).toEqual([ACTOR]);
		expect(sent[0]?.payload).toMatchObject({ data: { authorName: "Remote Ruth" } });
	});

	it("sends a read only for a channel with notifications through the cursor", async () => {
		await insertNotification({ messageRkey: "3lkmsg5" });

		expect(
			await deliverRead(deps, senders(), ACTOR, { channel: CHANNEL, through: "3lkmsg4" }),
		).toBe(false);
		expect(sent).toEqual([]);

		expect(
			await deliverRead(deps, senders(), ACTOR, { channel: CHANNEL, through: "3lkmsg5" }),
		).toBe(true);
		expect(sent[0]?.payload).toEqual({
			type: "read",
			data: { type: "read", channelUri: CHANNEL, through: "3lkmsg5", badge: "1" },
		});
	});

	it("skips a read for notifications older than a week", async () => {
		await insertNotification({ indexedAt: "2026-08-01T00:00:00.000Z" });

		expect(
			await deliverRead(deps, senders(), ACTOR, { channel: CHANNEL, through: "3lkmsg9" }),
		).toBe(false);
	});
});
