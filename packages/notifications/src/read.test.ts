import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { channelSpace } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDeps } from "./deps.js";
import { nextId } from "./id.js";
import {
	hydrateNotifications,
	listNotifications,
	markSeen,
	markSeenForMessage,
	type ProfileView,
	unreadCount,
	unseenForChannel,
} from "./read.js";

const COMMUNITY = "did:plc:community0000000000000000";
const CHANNEL = channelSpace(COMMUNITY, "social.colibri.channel.text", "3lkchannel1");
const AUTHOR = "did:plc:author00000000000000000000";
const RECIPIENT = "did:plc:recipient000000000000000";

let database: TestDatabase;
let deps: NotificationDeps;

const insertNotification = async (
	overrides: Partial<{
		id: string;
		kind: "mention" | "reply" | "message";
		indexedAt: string;
		seenAt: string | null;
		messageRkey: string;
	}> = {},
) => {
	const id = overrides.id ?? nextId();
	await database.db.insert(database.tables.notifications).values({
		id,
		recipient: RECIPIENT,
		kind: overrides.kind ?? "mention",
		community: COMMUNITY,
		space: CHANNEL,
		author: AUTHOR,
		messageAuthor: AUTHOR,
		messageRkey: overrides.messageRkey ?? "3lkmsg1",
		mentionRole: null,
		indexedAt: overrides.indexedAt ?? "2026-08-23T00:00:00.000Z",
		seenAt: overrides.seenAt ?? null,
	});
	return id;
};

beforeEach(async () => {
	database = await openTestDatabase();
	deps = { db: database.db, tables: database.tables, now: () => "2026-08-23T00:00:00.000Z" };
});

afterEach(async () => {
	await database.destroy();
});

describe("unreadCount", () => {
	it("counts unseen mentions and replies but not plain messages", async () => {
		await insertNotification({ kind: "mention" });
		await insertNotification({ kind: "reply" });
		await insertNotification({ kind: "message" });

		expect(await unreadCount(deps, RECIPIENT)).toBe(2);
	});

	it("ignores notifications already marked seen", async () => {
		await insertNotification({ kind: "mention", seenAt: "2026-08-23T00:00:01.000Z" });
		expect(await unreadCount(deps, RECIPIENT)).toBe(0);
	});
});

describe("markSeen", () => {
	it("marks everything at or before the cutoff seen and returns the remaining unread count", async () => {
		await insertNotification({ kind: "mention", indexedAt: "2026-08-23T00:00:00.000Z" });
		await insertNotification({ kind: "reply", indexedAt: "2026-08-23T00:00:05.000Z" });

		const remaining = await markSeen(deps, RECIPIENT, "2026-08-23T00:00:02.000Z");
		expect(remaining).toBe(1);

		const rows = await database.db.select().from(database.tables.notifications);
		const earlier = rows.find((row) => row.indexedAt === "2026-08-23T00:00:00.000Z");
		const later = rows.find((row) => row.indexedAt === "2026-08-23T00:00:05.000Z");
		expect(earlier?.seenAt).toBe("2026-08-23T00:00:02.000Z");
		expect(later?.seenAt).toBeNull();
	});
});

describe("markSeenForMessage", () => {
	it("marks every notification for one message seen and returns the remaining unread count", async () => {
		await insertNotification({ kind: "mention", messageRkey: "3lkmsg1" });
		await insertNotification({ kind: "message", messageRkey: "3lkmsg1" });
		await insertNotification({ kind: "reply", messageRkey: "3lkmsg2" });

		const remaining = await markSeenForMessage(
			deps,
			RECIPIENT,
			AUTHOR,
			"3lkmsg1",
			"2026-08-23T00:01:00.000Z",
		);
		expect(remaining).toBe(1);
	});
});

describe("unseenForChannel", () => {
	it("lists unseen notifications scoped to one channel", async () => {
		await insertNotification({ kind: "message" });
		const rows = await unseenForChannel(deps, RECIPIENT, CHANNEL);
		expect(rows).toHaveLength(1);
	});
});

describe("listNotifications", () => {
	it("paginates newest first with a cursor", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			ids.push(await insertNotification());
		}

		const first = await listNotifications(deps, RECIPIENT, { limit: 2 });
		expect(first.notifications).toHaveLength(2);
		expect(first.cursor).toBeDefined();

		const second = await listNotifications(deps, RECIPIENT, { limit: 2, cursor: first.cursor });
		expect(second.notifications).toHaveLength(2);
		expect(second.notifications.map((row) => row.id)).not.toEqual(
			first.notifications.map((row) => row.id),
		);
	});
});

describe("hydrateNotifications", () => {
	it("hydrates a notification into a notificationView with its message and author", async () => {
		await database.db.insert(database.tables.messages).values({
			space: CHANNEL,
			author: AUTHOR,
			rkey: "3lkmsg1",
			community: COMMUNITY,
			text: "hello world",
			facets: null,
			createdAt: "2026-08-23T00:00:00.000Z",
			indexedAt: "2026-08-23T00:00:00.000Z",
		});
		await insertNotification({ kind: "mention", messageRkey: "3lkmsg1" });

		const profile: ProfileView = {
			did: AUTHOR,
			handle: "author.test",
			displayName: "Author",
			isBot: false,
			syncBluesky: false,
		};
		const rows = await database.db.select().from(database.tables.notifications);
		const [view] = await hydrateNotifications(deps, rows, async () => new Map([[AUTHOR, profile]]));

		expect(view?.author).toEqual(profile);
		expect(view?.message?.text).toBe("hello world");
		expect(view?.channel).toBe(CHANNEL);
	});

	it("falls back to a stub profile when the actor hydrator doesn't resolve a DID", async () => {
		await insertNotification({ kind: "message" });
		const rows = await database.db.select().from(database.tables.notifications);
		const [view] = await hydrateNotifications(deps, rows, async () => new Map());
		expect(view?.author.did).toBe(AUTHOR);
		expect(view?.message).toBeUndefined();
	});
});
