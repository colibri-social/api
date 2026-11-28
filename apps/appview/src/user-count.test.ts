import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserCount } from "./user-count.js";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

let database: TestDatabase;

const ago = (hours: number) => {
	return new Date(NOW - hours * HOUR_MS).toISOString();
};

const presence = (did: string, derivedState: "online" | "offline", updatedAt: string) => {
	return {
		did: `did:plc:${did}`,
		derivedState,
		updatedAt,
	};
};

beforeEach(async () => {
	database = await openTestDatabase();

	const { db, tables } = database;

	await db
		.insert(tables.userPresence)
		.values([
			presence("onlinelong", "online", ago(24 * 60)),
			presence("hourago", "offline", ago(1)),
			presence("threedays", "offline", ago(72)),
			presence("twoweeks", "offline", ago(24 * 14)),
			presence("twomonths", "offline", ago(24 * 60)),
		]);
});

afterEach(async () => {
	await database.destroy();
});

describe("createUserCount", () => {
	it("counts every account, online accounts and accounts active per window", async () => {
		const users = await createUserCount(database, { now: () => NOW }).read();

		expect(users).toEqual({
			total: 5,
			online: 1,
			active: { "1d": 2, "7d": 3, "30d": 4 },
		});
	});

	it("serves the cached count until the TTL runs out", async () => {
		let clock = NOW;

		const userCount = createUserCount(database, {
			ttlMs: 1_000,
			now: () => clock,
		});

		expect((await userCount.read()).total).toBe(5);

		const { db, tables } = database;

		await db.insert(tables.userPresence).values(presence("newcomer", "offline", ago(0)));

		expect((await userCount.read()).total).toBe(5);

		clock += 1_000;

		expect((await userCount.read()).total).toBe(6);
	});
});
