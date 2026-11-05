import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDeps } from "./deps.js";
import { activeAnywhere, pushSuppressedFor, viewersOf } from "./presence.js";

const NOW = "2026-08-23T00:00:00.000Z";
const ALICE = "did:plc:alice000000000000000000000";
const BOB = "did:plc:bob00000000000000000000000";
const CAROL = "did:plc:carol000000000000000000000";
const CHANNEL = "at://did:plc:x/space/social.colibri.beta.channel.text/3lk";

let database: TestDatabase;
let deps: NotificationDeps;

const connection = async (
	id: string,
	did: string,
	options: { activeUntil?: string; viewing?: string; seenAt?: string } = {},
) => {
	await database.db.insert(database.tables.presenceConnections).values({
		id,
		did,
		viewingChannel: options.viewing ?? null,
		activeUntil: options.activeUntil ?? null,
		seenAt: options.seenAt ?? NOW,
	});
};

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
	await database.close();
});

describe("activeAnywhere", () => {
	it("counts an account while any one of its connections reported activity recently", async () => {
		await connection("alice-phone", ALICE);
		await connection("alice-desktop", ALICE, { activeUntil: "2026-08-23T00:04:00.000Z" });
		await connection("bob-phone", BOB);

		expect(await activeAnywhere(deps, [ALICE, BOB])).toEqual(new Set([ALICE]));
	});

	it("drops an account once its activity window has passed", async () => {
		await connection("alice-desktop", ALICE, { activeUntil: "2026-08-22T23:59:59.000Z" });

		expect(await activeAnywhere(deps, [ALICE])).toEqual(new Set());
	});

	it("ignores a connection that stopped reporting in", async () => {
		await connection("carol-desktop", CAROL, {
			activeUntil: "2026-08-23T00:04:00.000Z",
			seenAt: "2026-08-22T23:55:00.000Z",
		});

		expect(await activeAnywhere(deps, [CAROL])).toEqual(new Set());
	});
});

describe("viewersOf", () => {
	it("finds every account with a connection on the channel", async () => {
		await connection("alice-desktop", ALICE, { viewing: CHANNEL });
		await connection("alice-phone", ALICE);
		await connection("bob-phone", BOB, { viewing: "at://did:plc:x/space/other/3lm" });

		expect(await viewersOf(deps, [ALICE, BOB], CHANNEL)).toEqual(new Set([ALICE]));
	});
});

describe("pushSuppressedFor", () => {
	const VOICE = "at://did:plc:x/space/social.colibri.beta.channel.voice/3lv";

	it("holds back pushes for accounts active on another device or set to do not disturb", async () => {
		await connection("alice-desktop", ALICE, { activeUntil: "2026-08-23T00:04:00.000Z" });
		await database.db.insert(database.tables.userPresence).values({
			did: BOB,
			derivedState: "online",
			requestedState: "dnd",
			updatedAt: NOW,
		});

		expect(await pushSuppressedFor(deps, CHANNEL, [ALICE, BOB, CAROL])).toEqual(
			new Set([ALICE, BOB]),
		);
	});

	it("holds back every push for a voice channel, since its audience is the call", async () => {
		expect(await pushSuppressedFor(deps, VOICE, [ALICE, CAROL])).toEqual(new Set([ALICE, CAROL]));
	});
});
