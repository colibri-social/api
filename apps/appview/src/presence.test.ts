import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { effectiveOnlineState, PresenceTracker, presenceOf } from "./presence.js";
import type { ServerFrame } from "./ws/events.js";

const ACTOR = "did:plc:presenceaaaaaaaaaaaaaaaaaa";
const COMMUNITY = "did:plc:communityaaaaaaaaaaaaaaaaaa";

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

	it("forgets the channel in view once the actor disconnects", async () => {
		await tracker.opened(ACTOR);
		await database.db
			.update(database.tables.userPresence)
			.set({ viewingChannel: "at://did:plc:x/space/social.colibri.beta.channel.text/3lk" })
			.where(eq(database.tables.userPresence.did, ACTOR));

		await tracker.closed(ACTOR);

		expect((await stored())?.viewingChannel).toBeNull();
	});
});

describe("presenceOf", () => {
	const ctx = { voice: null } as unknown as AppContext;
	const row = {
		derivedState: "online" as const,
		requestedState: null,
		statusText: "lunch",
		statusEmoji: null,
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
