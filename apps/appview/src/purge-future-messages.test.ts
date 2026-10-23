import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { channelSpace, SPACE_TYPES, threadSpace } from "@colibri-social/lexicons";
import { tidAt } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeFutureMessages } from "./purge-future-messages.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxx";
const CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel001");
const THREAD = threadSpace(COMMUNITY, "3lkthread001");
const NOW = new Date("2026-10-23T12:00:00.000Z");
const EARLIER = "2026-10-23T11:00:00.000Z";
const FUTURE = "2028-01-01T00:00:00.000Z";
const silent = { info: () => {} };

let database: TestDatabase;

const insertMessage = (space: string, rkey: string, createdAt: string) =>
	database.db.insert(database.tables.messages).values({
		space,
		author: MEMBER,
		rkey,
		community: COMMUNITY,
		text: "hi",
		createdAt,
		indexedAt: NOW.toISOString(),
	});

const insertThread = (lastActivityAt: string) =>
	database.db.insert(database.tables.threads).values({
		space: THREAD,
		community: COMMUNITY,
		channel: CHANNEL,
		skey: "3lkthread001",
		name: "side",
		createdBy: MEMBER,
		createdAt: "2026-10-23T10:00:00.000Z",
		lastActivityAt,
		indexedAt: NOW.toISOString(),
	});

const rkeys = async () =>
	(await database.db.select().from(database.tables.messages)).map((row) => row.rkey).sort();

const threadActivity = async () =>
	(await database.db.select().from(database.tables.threads))[0]?.lastActivityAt;

beforeEach(async () => {
	database = await openTestDatabase();
	await insertMessage(CHANNEL, tidAt(EARLIER, "kept"), EARLIER);
	await insertMessage(CHANNEL, tidAt(FUTURE, "channel"), FUTURE);
	await insertMessage(THREAD, tidAt(EARLIER, "thread kept"), EARLIER);
	await insertMessage(THREAD, tidAt(FUTURE, "thread"), FUTURE);
	await insertThread(FUTURE);
});

afterEach(async () => {
	await database.destroy();
});

describe("purgeFutureMessages", () => {
	it("reports what it would change without writing on a dry run", async () => {
		const report = await purgeFutureMessages(database, { apply: false, now: NOW, log: silent });

		expect(report.messages.map((row) => row.rkey).sort()).toEqual(
			[tidAt(FUTURE, "channel"), tidAt(FUTURE, "thread")].sort(),
		);
		expect(report.threads).toEqual([{ space: THREAD, from: FUTURE, to: EARLIER }]);
		expect(await rkeys()).toHaveLength(4);
		expect(await threadActivity()).toBe(FUTURE);
	});

	it("deletes future messages and rewinds thread activity when applied", async () => {
		await purgeFutureMessages(database, { apply: true, now: NOW, log: silent });

		expect(await rkeys()).toEqual([tidAt(EARLIER, "kept"), tidAt(EARLIER, "thread kept")].sort());
		expect(await threadActivity()).toBe(EARLIER);
	});

	it("keeps a message a few minutes ahead of the clock", async () => {
		const ahead = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
		await insertMessage(CHANNEL, tidAt(ahead, "ahead"), ahead);

		const report = await purgeFutureMessages(database, { apply: true, now: NOW, log: silent });

		expect(report.messages.map((row) => row.rkey)).not.toContain(tidAt(ahead, "ahead"));
		expect(await rkeys()).toContain(tidAt(ahead, "ahead"));
	});
});
