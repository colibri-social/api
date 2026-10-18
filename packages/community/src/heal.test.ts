import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { COLLECTIONS, communitySpaces, PERMISSIONS } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDefaultRole, healOwnerPermissions, lowestRolePosition } from "./heal.js";
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

const seedMember = (did: string, roles: string[], nickname: string | null = null) =>
	database.db.insert(database.tables.members).values({
		community: COMMUNITY,
		did,
		roles,
		joinedAt: "2026-10-01T00:00:00.000Z",
		nickname,
	});

const ensure = (
	writes: RecordWrite[],
	fail: (write: RecordWrite) => boolean = () => false,
	records: Record<string, Record<string, unknown>> = {},
) =>
	ensureDefaultRole(
		{
			db: database.db,
			tables: database.tables,
			loader: new CommunityLoader({ db: database.db, tables: database.tables }),
			writer: {
				spaces: (community: string) => communitySpaces(community),
				currentRecord: async (
					_community: string,
					_space: string,
					_collection: string,
					rkey: string,
				) => records[rkey] ?? null,
				put: async (_community: string, write: RecordWrite) => {
					if (fail(write)) throw new Error("write refused");
					writes.push(write);
					return { uri: "at://written", rkey: write.rkey ?? "" };
				},
			} as unknown as CommunityWriter,
		},
		COMMUNITY,
	);

describe("ensureDefaultRole", () => {
	it("creates a members role below every other role and hands it to every member", async () => {
		await seedRole("3lkowner", [...PERMISSIONS], true);
		await seedRole("3lkmod", ["member.kick"], false);
		await seedMember("did:plc:owner", ["3lkowner"]);
		await seedMember("did:plc:member", [], "Nick");

		const writes: RecordWrite[] = [];
		const backfill = await ensure(writes);
		if (!backfill) throw new Error("expected a backfill");

		expect(backfill.members).toBe(2);
		expect(backfill.failedMembers).toBe(0);

		const [role, ...members] = writes;
		expect(role?.collection).toBe(COLLECTIONS.role);
		expect(role?.rkey).toBe(backfill.role);
		expect(role?.record).toMatchObject({
			name: "Members",
			permissions: ["thread.create"],
			position: 0,
			default: true,
			protected: false,
		});

		const records = members
			.map((write) => write.record)
			.sort((a, b) => String(a.subject).localeCompare(String(b.subject)));
		expect(records).toEqual([
			{
				$type: COLLECTIONS.member,
				subject: "did:plc:member",
				roles: [backfill.role],
				joinedAt: "2026-10-01T00:00:00.000Z",
				nickname: "Nick",
			},
			{
				$type: COLLECTIONS.member,
				subject: "did:plc:owner",
				roles: ["3lkowner", backfill.role],
				joinedAt: "2026-10-01T00:00:00.000Z",
			},
		]);
	});

	const seedDefaultRole = () =>
		database.db.insert(database.tables.roles).values({
			community: COMMUNITY,
			rkey: "3lkmembers",
			name: "Members",
			permissions: ["thread.create"],
			position: 0,
			isDefault: true,
		});

	it("does nothing when the default role exists and every member holds it", async () => {
		await seedDefaultRole();
		await seedMember("did:plc:member", ["3lkmembers"]);

		const writes: RecordWrite[] = [];

		expect(await ensure(writes)).toBeNull();
		expect(writes).toEqual([]);
	});

	it("repairs a member who holds no default role, whichever way they joined", async () => {
		await seedDefaultRole();
		await seedMember("did:plc:holder", ["3lkmembers"]);
		await seedMember("did:plc:migrated", ["3lkmod"]);

		const writes: RecordWrite[] = [];
		const backfill = await ensure(writes);

		expect(backfill).toMatchObject({
			role: "3lkmembers",
			created: false,
			normalized: false,
			members: 1,
			failedMembers: 0,
		});
		expect(writes).toHaveLength(1);
		expect(writes[0]?.record.roles).toEqual(["3lkmod", "3lkmembers"]);
	});

	it("retries a member whose earlier write failed on the next run", async () => {
		await seedDefaultRole();
		await seedMember("did:plc:a", []);

		const partial = await ensure([], (write) => write.rkey === "did:plc:a");
		expect(partial).toMatchObject({ members: 0, failedMembers: 1 });

		const retry: RecordWrite[] = [];
		const healed = await ensure(retry);
		expect(healed).toMatchObject({ created: false, members: 1, failedMembers: 0 });
		expect(retry.map((write) => write.rkey)).toEqual(["did:plc:a"]);
	});

	it("recreates the default role when its record is gone", async () => {
		await seedMember("did:plc:member", ["3lkdeleted"]);

		const writes: RecordWrite[] = [];
		const backfill = await ensure(writes);

		expect(backfill?.created).toBe(true);
		expect(writes[0]?.record.default).toBe(true);
		expect(writes[1]?.record.roles).toEqual(["3lkdeleted", backfill?.role]);
	});

	it("rewrites a default role record that claims to be hoisted or mentionable", async () => {
		await seedDefaultRole();
		await seedMember("did:plc:member", ["3lkmembers"]);

		const writes: RecordWrite[] = [];
		const backfill = await ensure(writes, () => false, {
			"3lkmembers": {
				$type: COLLECTIONS.role,
				name: "Everyone",
				permissions: ["thread.create"],
				position: 0,
				hoisted: true,
				mentionable: true,
				default: true,
			},
		});

		expect(backfill).toMatchObject({ created: false, normalized: true, members: 0 });
		expect(writes[0]?.record).toMatchObject({
			name: "Everyone",
			hoisted: false,
			mentionable: false,
			default: true,
		});
	});

	it("keeps going past a member write that fails and counts it", async () => {
		await seedMember("did:plc:a", []);
		await seedMember("did:plc:b", []);

		const writes: RecordWrite[] = [];
		const backfill = await ensure(writes, (write) => write.rkey === "did:plc:a");

		expect(backfill?.members).toBe(1);
		expect(backfill?.failedMembers).toBe(1);
	});

	it("places the role below the lowest existing position", () => {
		expect(lowestRolePosition([])).toBe(0);
		expect(lowestRolePosition([{ position: 1000 }])).toBe(0);
		expect(lowestRolePosition([{ position: 1000 }, { position: 0 }])).toBe(-1);
	});
});
