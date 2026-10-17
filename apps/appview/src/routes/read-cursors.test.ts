import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import type { ServerFrame } from "../ws/events.js";
import { handlePutReadCursors } from "./read-cursors.js";

const readMoved = vi.fn();

vi.mock("../push-delivery.js", () => ({
	pushDelivery: () => ({ readMoved }),
}));

const NOW = "2026-10-15T00:00:00.000Z";
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const MISSING = "did:plc:missingxxxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxxx";
const GENERAL = "3lkchannel1";
const RANDOM = "3lkchannel2";
const THREAD = "3lkthreadxx1";

let database: TestDatabase;
let ctx: AppContext;
let announced: { did: string; frame: ServerFrame }[];

const noStatuses = { unreadStatus: async () => [] };

const put = (cursors: { channel: string; cursor: string }[], community = COMMUNITY) =>
	handlePutReadCursors(ctx, noStatuses, MEMBER, { community, cursors });

const stored = async () =>
	(
		await database.db
			.select({
				channel: database.tables.readCursors.channel,
				cursor: database.tables.readCursors.cursor,
			})
			.from(database.tables.readCursors)
			.where(eq(database.tables.readCursors.did, MEMBER))
	).sort((a, b) => a.channel.localeCompare(b.channel));

beforeEach(async () => {
	database = await openTestDatabase();
	announced = [];
	readMoved.mockClear();
	ctx = {
		announce: {
			...silentAnnouncer,
			toUser: (did: string, frame: ServerFrame) => announced.push({ did, frame }),
		},
		database,
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
	} as unknown as AppContext;

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
});

afterEach(async () => {
	await database.destroy();
});

describe("putReadCursors", () => {
	it("stores cursors and tells the caller's sessions about them", async () => {
		await put([
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa2" },
			{ channel: THREAD, cursor: "3lkaaaaaaaaa3" },
		]);

		expect(await stored()).toEqual([
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa2" },
			{ channel: THREAD, cursor: "3lkaaaaaaaaa3" },
		]);
		expect(announced).toEqual([
			{
				did: MEMBER,
				frame: {
					$type: "social.colibri.beta.sync.defs#readCursorEvent",
					community: COMMUNITY,
					cursors: [
						{ channel: GENERAL, cursor: "3lkaaaaaaaaa2" },
						{ channel: THREAD, cursor: "3lkaaaaaaaaa3" },
					],
				},
			},
		]);
	});

	it("hands the cursors that moved to the push fan-out", async () => {
		await put([{ channel: GENERAL, cursor: "3lkaaaaaaaaa7" }]);
		await put([
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa4" },
			{ channel: RANDOM, cursor: "3lkaaaaaaaaa6" },
		]);
		await put([{ channel: RANDOM, cursor: "3lkaaaaaaaaa6" }]);

		expect(readMoved.mock.calls).toEqual([
			[MEMBER, COMMUNITY, [{ channel: GENERAL, cursor: "3lkaaaaaaaaa7" }]],
			[MEMBER, COMMUNITY, [{ channel: RANDOM, cursor: "3lkaaaaaaaaa6" }]],
		]);
	});

	it("never moves a cursor backwards when another device pushes an older one", async () => {
		await put([{ channel: GENERAL, cursor: "3lkaaaaaaaaa7" }]);
		await put([{ channel: GENERAL, cursor: "3lkaaaaaaaaa4" }]);

		expect(await stored()).toEqual([{ channel: GENERAL, cursor: "3lkaaaaaaaaa7" }]);
	});

	it("keeps the stored cursor of a channel the push leaves out", async () => {
		await put([
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa2" },
			{ channel: RANDOM, cursor: "3lkaaaaaaaaa3" },
		]);
		await put([{ channel: GENERAL, cursor: "3lkaaaaaaaaa5" }]);

		expect(await stored()).toEqual([
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa5" },
			{ channel: RANDOM, cursor: "3lkaaaaaaaaa3" },
		]);
	});

	it("announces only the cursors that moved", async () => {
		await put([
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa7" },
			{ channel: RANDOM, cursor: "3lkaaaaaaaaa3" },
		]);
		announced = [];

		await put([
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa4" },
			{ channel: RANDOM, cursor: "3lkaaaaaaaaa6" },
		]);

		expect(announced.map((entry) => entry.frame.cursors)).toEqual([
			[{ channel: RANDOM, cursor: "3lkaaaaaaaaa6" }],
		]);
	});

	it("stays quiet when nothing moved", async () => {
		await put([{ channel: GENERAL, cursor: "3lkaaaaaaaaa7" }]);
		announced = [];

		await put([{ channel: GENERAL, cursor: "3lkaaaaaaaaa7" }]);
		await put([]);

		expect(announced).toEqual([]);
	});

	it("takes the newest of duplicate entries for one channel", async () => {
		await put([
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa5" },
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa8" },
			{ channel: GENERAL, cursor: "3lkaaaaaaaaa6" },
		]);

		expect(await stored()).toEqual([{ channel: GENERAL, cursor: "3lkaaaaaaaaa8" }]);
	});

	it("rejects an unknown community without storing anything", async () => {
		await expect(
			put([{ channel: GENERAL, cursor: "3lkaaaaaaaaa2" }], MISSING),
		).rejects.toMatchObject({ customErrorName: "CommunityNotFound" });

		expect(await stored()).toEqual([]);
		expect(announced).toEqual([]);
	});
});
