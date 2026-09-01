import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { COLLECTIONS, communitySpaces, PERMISSIONS } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { healOwnerPermissions } from "./heal.js";
import { CommunityLoader } from "./loader.js";
import type { CommunityWriter, RecordWrite } from "./writes.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";

let database: TestDatabase;

const stubWriter = (writes: RecordWrite[]) =>
	({
		spaces: (community: string) => communitySpaces(community),
		currentRecord: async () => null,
		put: async (_community: string, write: RecordWrite) => {
			writes.push(write);
			return { uri: `at://${COMMUNITY}/${write.collection}/${write.rkey}`, rkey: write.rkey ?? "" };
		},
	}) as unknown as CommunityWriter;

const seedRole = async (rkey: string, permissions: string[], isProtected: boolean) => {
	await database.db.insert(database.tables.roles).values({
		community: COMMUNITY,
		rkey,
		name: isProtected ? "Owner" : "Role",
		permissions,
		position: isProtected ? 1000 : 1,
		protected: isProtected,
	});
};

const heal = (writes: RecordWrite[]) =>
	healOwnerPermissions(
		{
			loader: new CommunityLoader({ db: database.db, tables: database.tables }),
			writer: stubWriter(writes),
		},
		COMMUNITY,
	);

beforeEach(async () => {
	database = await openTestDatabase();
});

afterEach(async () => {
	await database.close();
});

describe("healOwnerPermissions", () => {
	it("writes the full permission set onto a protected role that is missing some", async () => {
		await seedRole("3lkowner", ["community.manage"], true);

		const writes: RecordWrite[] = [];
		const healed = await heal(writes);

		expect(healed).toEqual(["3lkowner"]);
		expect(writes).toHaveLength(1);

		const write = writes[0];
		if (!write) throw new Error("expected a role write");
		expect(write.collection).toBe(COLLECTIONS.role);
		expect(write.rkey).toBe("3lkowner");
		expect(write.record.permissions).toEqual([...PERMISSIONS]);
		expect(write.record.protected).toBe(true);
	});

	it("leaves a protected role that already holds everything alone", async () => {
		await seedRole("3lkowner", [...PERMISSIONS], true);

		const writes: RecordWrite[] = [];

		expect(await heal(writes)).toEqual([]);
		expect(writes).toEqual([]);
	});

	it("never touches an unprotected role", async () => {
		await seedRole("3lkmod", ["member.kick"], false);

		const writes: RecordWrite[] = [];

		expect(await heal(writes)).toEqual([]);
		expect(writes).toEqual([]);
	});
});
