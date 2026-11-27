import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPeerStore } from "./federation-peers.js";
import { openTestDatabase, type TestDatabase } from "./testing.js";

const PEER = "did:web:rogue.example";
const OTHER = "did:web:another.example";

let database: TestDatabase;

beforeEach(async () => {
	database = await openTestDatabase();
});

afterEach(async () => {
	await database.destroy();
});

describe("createPeerStore", () => {
	it("blocks, lists and unblocks a peer", async () => {
		const peers = createPeerStore(database, () => new Date("2026-11-26T12:00:00.000Z"));

		await expect(peers.isBlocked(PEER)).resolves.toBe(false);

		await peers.block(PEER, "spam");
		await peers.block(OTHER);
		await peers.block(PEER, "spam, again");

		await expect(peers.isBlocked(PEER)).resolves.toBe(true);
		await expect(peers.list()).resolves.toEqual([
			{ did: OTHER, blocked: true, note: null, updatedAt: "2026-11-26T12:00:00.000Z" },
			{ did: PEER, blocked: true, note: "spam, again", updatedAt: "2026-11-26T12:00:00.000Z" },
		]);

		await expect(peers.unblock(PEER)).resolves.toBe(true);
		await expect(peers.unblock(PEER)).resolves.toBe(false);
		await expect(peers.isBlocked(PEER)).resolves.toBe(false);
	});
});
