import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { effectiveOnlineState, PresenceTracker } from "./presence.js";
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
