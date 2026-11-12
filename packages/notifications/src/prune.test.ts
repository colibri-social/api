import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idAt, nextId } from "./id.js";
import { pruneNotifications } from "./prune.js";

const NOW = "2026-11-12T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

let database: TestDatabase;
let sequence = 0;

const daysAgo = (days: number) => {
	sequence++;

	return new Date(new Date(NOW).getTime() - days * DAY_MS + sequence);
};

const insertNotification = async (days: number, seen: boolean) => {
	const at = daysAgo(days);
	const id = idAt(at);

	await database.db.insert(database.tables.notifications).values({
		id,
		recipient: "did:plc:recipient000000000000000",
		kind: "message",
		community: "did:plc:community0000000000000000",
		space: "at://did:plc:community0000000000000000/space/1",
		author: "did:plc:author00000000000000000000",
		messageAuthor: "did:plc:author00000000000000000000",
		messageRkey: `3lkmsg${sequence}`,
		mentionRole: null,
		indexedAt: at.toISOString(),
		seenAt: seen ? at.toISOString() : null,
	});

	return id;
};

const remainingIds = async () => {
	const rows = await database.db
		.select({ id: database.tables.notifications.id })
		.from(database.tables.notifications);

	return rows.map((row) => row.id).sort();
};

const deps = () => {
	return { db: database.db, tables: database.tables, now: () => NOW };
};

beforeEach(async () => {
	database = await openTestDatabase();
	sequence = 0;
});

afterEach(async () => {
	await database.destroy();
});

describe("idAt", () => {
	it("sorts below every id generated in the same millisecond or later", () => {
		const before = idAt(new Date());
		const generated = nextId();

		expect(before < generated).toBe(true);
	});

	it("sorts in time order", () => {
		const earlier = idAt(new Date("2026-01-01T00:00:00.000Z"));
		const later = idAt(new Date("2026-01-01T00:00:00.001Z"));

		expect(earlier < later).toBe(true);
	});
});

describe("pruneNotifications", () => {
	it("deletes seen rows past 30 days and every row past 90 days", async () => {
		const recentSeen = await insertNotification(5, true);
		const recentUnseen = await insertNotification(5, false);
		const oldUnseen = await insertNotification(45, false);

		await insertNotification(45, true);
		await insertNotification(120, false);
		await insertNotification(120, true);

		expect(await pruneNotifications(deps())).toBe(3);
		expect(await remainingIds()).toEqual([oldUnseen, recentSeen, recentUnseen].sort());
	});

	it("deletes in batches and stops at the batch cap", async () => {
		for (let i = 0; i < 5; i++) {
			await insertNotification(100, true);
		}

		expect(await pruneNotifications(deps(), { batchSize: 2, maxBatches: 2 })).toBe(4);
		expect(await remainingIds()).toHaveLength(1);
		expect(await pruneNotifications(deps(), { batchSize: 2, maxBatches: 2 })).toBe(1);
		expect(await remainingIds()).toHaveLength(0);
	});
});
