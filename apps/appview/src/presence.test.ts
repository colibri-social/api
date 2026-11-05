import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { activeAnywhere, type NotificationDeps, viewersOf } from "@colibri-social/notifications";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import {
	ConnectionPresence,
	effectiveOnlineState,
	PresenceTracker,
	presenceOf,
} from "./presence.js";
import type { ServerFrame } from "./ws/events.js";

const ACTOR = "did:plc:presenceaaaaaaaaaaaaaaaaaa";
const COMMUNITY = "did:plc:communityaaaaaaaaaaaaaaaaaa";
const CHANNEL = "at://did:plc:x/space/social.colibri.beta.channel.text/3lk";
const OTHER_CHANNEL = "at://did:plc:x/space/social.colibri.beta.channel.text/3lm";

let database: TestDatabase;
let published: Array<{ did: string; communities: readonly string[]; frame: ServerFrame }>;
let tracker: PresenceTracker;

const stored = async () => {
	const [row] = await database.db
		.select()
		.from(database.tables.userPresence)
		.where(eq(database.tables.userPresence.did, ACTOR))
		.limit(1);
	return row;
};

const states = () =>
	published.map(
		(entry) => (entry.frame.presence as { onlineState: string } | undefined)?.onlineState,
	);

beforeEach(async () => {
	database = await openTestDatabase();
	published = [];
	tracker = new PresenceTracker({
		ctx: { database, voice: null } as unknown as AppContext,
		publish: (did, communities, frame) => published.push({ did, communities, frame }),
	});
});

afterEach(async () => {
	await database.close();
});

describe("presence tracking", () => {
	it("reads as online while a socket is open and offline once the last one closes", async () => {
		await tracker.opened(ACTOR);
		expect((await stored())?.derivedState).toBe("online");

		await tracker.closed(ACTOR);
		expect((await stored())?.derivedState).toBe("offline");
		expect(states()).toEqual(["online", "offline"]);
	});

	it("stays online until every socket is gone", async () => {
		await tracker.opened(ACTOR);
		await tracker.opened(ACTOR);
		await tracker.closed(ACTOR);

		expect(tracker.connections(ACTOR)).toBe(1);
		expect((await stored())?.derivedState).toBe("online");
		expect(states()).toEqual(["online"]);
	});

	it("keeps the state the actor asked for while they are connected", async () => {
		await tracker.opened(ACTOR);
		await tracker.requested(ACTOR, "dnd");

		expect(effectiveOnlineState((await stored()) as never)).toBe("dnd");
		expect(states()).toEqual(["online", "dnd"]);
	});

	it("reports offline for a requested state with nothing connected", async () => {
		await tracker.requested(ACTOR, "online");

		expect(effectiveOnlineState((await stored()) as never)).toBe("offline");
		expect(published).toHaveLength(0);
	});

	it("restores the requested state on the next connection", async () => {
		await tracker.opened(ACTOR);
		await tracker.requested(ACTOR, "away");
		await tracker.closed(ACTOR);
		await tracker.opened(ACTOR);

		expect(effectiveOnlineState((await stored()) as never)).toBe("away");
		expect(states()).toEqual(["online", "away", "offline", "away"]);
	});

	it("announces to the communities the actor belongs to", async () => {
		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: ACTOR,
			roles: [],
			joinedAt: "2026-08-24T00:00:00.000Z",
		});

		await tracker.opened(ACTOR);

		expect(published[0]?.communities).toEqual([COMMUNITY]);
		expect(published[0]?.frame.$type).toBe("social.colibri.beta.sync.defs#presenceEvent");
	});

	it("still reports offline when a close races the open that preceded it", async () => {
		await Promise.all([tracker.opened(ACTOR), tracker.closed(ACTOR)]);

		expect(tracker.connections(ACTOR)).toBe(0);
		expect((await stored())?.derivedState).toBe("offline");
		expect(states().at(-1)).toBe("offline");
	});

	it("still reports online when an open races the close that preceded it", async () => {
		await tracker.opened(ACTOR);
		published = [];

		await Promise.all([tracker.closed(ACTOR), tracker.opened(ACTOR)]);

		expect(tracker.connections(ACTOR)).toBe(1);
		expect((await stored())?.derivedState).toBe("online");
		expect(states().at(-1)).toBe("online");
	});
});

describe("connection presence", () => {
	let now: number;
	let connections: ConnectionPresence;

	const rows = () => database.db.select().from(database.tables.presenceConnections);
	const deps = (): NotificationDeps => ({
		db: database.db,
		tables: database.tables,
		now: () => new Date(now).toISOString(),
		mayRead: async () => true,
	});

	beforeEach(() => {
		now = Date.parse("2026-11-05T12:00:00.000Z");
		connections = new ConnectionPresence({ ctx: { database }, now: () => now });
	});

	it("keeps a channel in view per connection so devices leave each other alone", async () => {
		await connections.opened("desktop", ACTOR);
		await connections.opened("phone", ACTOR);
		await connections.viewing("desktop", CHANNEL);
		await connections.viewing("phone", OTHER_CHANNEL);

		expect(await viewersOf(deps(), [ACTOR], CHANNEL)).toEqual(new Set([ACTOR]));
		expect(await viewersOf(deps(), [ACTOR], OTHER_CHANNEL)).toEqual(new Set([ACTOR]));

		await connections.viewing("phone", null);
		expect(await viewersOf(deps(), [ACTOR], CHANNEL)).toEqual(new Set([ACTOR]));
		expect(await viewersOf(deps(), [ACTOR], OTHER_CHANNEL)).toEqual(new Set());
	});

	it("forgets a connection's channel once it closes", async () => {
		await connections.opened("phone", ACTOR);
		await connections.viewing("phone", CHANNEL);
		await connections.closed("phone");

		expect(await viewersOf(deps(), [ACTOR], CHANNEL)).toEqual(new Set());
		expect(await rows()).toHaveLength(0);
	});

	it("counts the account as active until five minutes after the last activity", async () => {
		await connections.opened("desktop", ACTOR);
		await connections.opened("phone", ACTOR);
		await connections.active("desktop");
		expect(await activeAnywhere(deps(), [ACTOR])).toEqual(new Set([ACTOR]));

		now += 4 * 60 * 1000;
		await connections.touch(["desktop", "phone"]);
		expect(await activeAnywhere(deps(), [ACTOR])).toEqual(new Set([ACTOR]));

		now += 2 * 60 * 1000;
		await connections.touch(["desktop", "phone"]);
		expect(await activeAnywhere(deps(), [ACTOR])).toEqual(new Set());
	});

	it("refreshes the activity window at most once a minute", async () => {
		await connections.opened("desktop", ACTOR);
		await connections.active("desktop");
		const [first] = await rows();

		now += 30 * 1000;
		await connections.active("desktop");
		expect((await rows())[0]?.activeUntil).toBe(first?.activeUntil);

		now += 31 * 1000;
		await connections.active("desktop");
		expect((await rows())[0]?.activeUntil).toBe(new Date(now + 5 * 60 * 1000).toISOString());
	});

	it("ends the activity as soon as the connection closes", async () => {
		await connections.opened("desktop", ACTOR);
		await connections.active("desktop");
		await connections.closed("desktop");

		expect(await activeAnywhere(deps(), [ACTOR])).toEqual(new Set());
	});

	it("sweeps away connections a previous process left behind", async () => {
		await connections.opened("stale", ACTOR);
		await connections.viewing("stale", CHANNEL);
		await connections.active("stale");

		now += 3 * 60 * 1000;
		expect(await viewersOf(deps(), [ACTOR], CHANNEL)).toEqual(new Set());
		expect(await activeAnywhere(deps(), [ACTOR])).toEqual(new Set());

		await connections.opened("fresh", ACTOR);
		await connections.sweep();
		expect((await rows()).map((row) => row.id)).toEqual(["fresh"]);
	});
});

describe("presenceOf", () => {
	const ctx = { voice: null } as unknown as AppContext;
	const row = {
		derivedState: "online" as const,
		requestedState: null,
		statusText: "lunch",
		statusEmoji: null,
		statusCustomEmoji: null,
		statusExpiresAt: null,
		statusShowWhileOffline: false,
	};

	it("returns a status without an expiry", () => {
		expect(presenceOf(ctx, ACTOR, row, []).status).toEqual({
			text: "lunch",
			emoji: undefined,
			expiresAt: undefined,
			showWhileOffline: false,
		});
	});

	it("returns a status until it expires", () => {
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		expect(presenceOf(ctx, ACTOR, { ...row, statusExpiresAt: expiresAt }, []).status).toEqual({
			text: "lunch",
			emoji: undefined,
			expiresAt,
			showWhileOffline: false,
		});
	});

	it("hides a status once it has expired", () => {
		const expiresAt = new Date(Date.now() - 1).toISOString();
		expect(
			presenceOf(ctx, ACTOR, { ...row, statusExpiresAt: expiresAt }, []).status,
		).toBeUndefined();
	});

	it("returns an emoji-only status", () => {
		expect(
			presenceOf(ctx, ACTOR, { ...row, statusText: "", statusEmoji: "🍜" }, []).status,
		).toEqual({ text: "", emoji: "🍜", showWhileOffline: false });
	});

	it("returns a status that only has a custom emoji", () => {
		const customEmoji = { uri: "at://did:plc:emoji/blue.moji.collection.item/3lk" };
		expect(
			presenceOf(ctx, ACTOR, { ...row, statusText: null, statusCustomEmoji: customEmoji }, [])
				.status,
		).toEqual({ text: "", customEmoji, showWhileOffline: false });
	});

	it("returns no status without text or an emoji", () => {
		expect(presenceOf(ctx, ACTOR, { ...row, statusText: "" }, []).status).toBeUndefined();
	});

	it("passes showWhileOffline through for an offline actor", () => {
		const presence = presenceOf(
			ctx,
			ACTOR,
			{ ...row, derivedState: "offline", statusShowWhileOffline: true },
			[],
		);
		expect(presence.onlineState).toBe("offline");
		expect(presence.status?.showWhileOffline).toBe(true);
	});
});

describe("presence tracking keeps the status", () => {
	it("carries the expiry and offline flag through a reconnect", async () => {
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		await database.db.insert(database.tables.userPresence).values({
			did: ACTOR,
			derivedState: "offline",
			statusText: "lunch",
			statusExpiresAt: expiresAt,
			statusShowWhileOffline: true,
			updatedAt: new Date().toISOString(),
		});

		await tracker.opened(ACTOR);

		const status = (published.at(-1)?.frame.presence as { status?: unknown } | undefined)?.status;
		expect(status).toEqual({
			text: "lunch",
			emoji: undefined,
			expiresAt,
			showWhileOffline: true,
		});
		expect((await stored())?.statusExpiresAt).toBe(expiresAt);
	});
});
