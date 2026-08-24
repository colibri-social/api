import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader, type CommunityWriter, type RecordWrite } from "@colibri-social/community";
import { COLLECTIONS, communitySpaces } from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import { handleCreateRole, handleDeleteRole, handleUpdateRole } from "./role.js";

const COMMUNITY = "did:plc:community";
const OWNER = "did:plc:owner";
const MOD = "did:plc:moderator";
const MEMBER = "did:plc:member";
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let ctx: AppContext;
let communities: CommunityViews;
let announced: Array<{ community: string; frame: Record<string, unknown> }>;
let writes: Array<{ community: string; write: RecordWrite }>;
let removals: Array<{ community: string; collection: string; rkey: string }>;

const fakeWriter = (): CommunityWriter => {
	const writer = {
		spaces: (community: string) => communitySpaces(community),
		put: async (community: string, write: RecordWrite) => {
			writes.push({ community, write });
			const rkey = write.rkey ?? `generated-${writes.length}`;

			if (write.collection === COLLECTIONS.role) {
				const record = write.record as {
					name: string;
					color?: string;
					permissions: string[];
					position: number;
					hoisted?: boolean;
					mentionable?: boolean;
					protected?: boolean;
					channelOverrides?: Array<{ channel: string; allow: string[]; deny: string[] }>;
				};
				const row = {
					community,
					rkey,
					name: record.name,
					color: record.color ?? null,
					permissions: record.permissions,
					position: record.position,
					hoisted: record.hoisted ?? false,
					mentionable: record.mentionable ?? false,
					protected: record.protected ?? false,
					channelOverrides: record.channelOverrides ?? [],
				};
				await database.db
					.insert(database.tables.roles)
					.values(row)
					.onConflictDoUpdate({
						target: [database.tables.roles.community, database.tables.roles.rkey],
						set: row,
					});
			}

			if (write.collection === COLLECTIONS.member) {
				const record = write.record as {
					subject: string;
					roles?: string[];
					joinedAt: string;
					nickname?: string;
				};
				await database.db
					.insert(database.tables.members)
					.values({
						community,
						did: record.subject,
						roles: record.roles ?? [],
						joinedAt: record.joinedAt,
						nickname: record.nickname ?? null,
					})
					.onConflictDoUpdate({
						target: [database.tables.members.community, database.tables.members.did],
						set: { roles: record.roles ?? [], nickname: record.nickname ?? null },
					});
			}

			return { uri: `at://${community}/${write.collection}/${rkey}`, rkey };
		},
		remove: async (
			community: string,
			params: { space: string; collection: string; rkey: string },
		) => {
			removals.push({ community, collection: params.collection, rkey: params.rkey });
			if (params.collection === COLLECTIONS.role) {
				await database.db
					.delete(database.tables.roles)
					.where(
						and(
							eq(database.tables.roles.community, community),
							eq(database.tables.roles.rkey, params.rkey),
						),
					);
			}
		},
		createSpaceFor: async () => ({ uri: "at://space" }),
		deleteSpaceFor: async () => undefined,
	};
	return writer as unknown as CommunityWriter;
};

const addCommunity = () => {
	const spaces = communitySpaces(COMMUNITY);
	return database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Test",
		requiresApproval: false,
		linkEmbeds: true,
		labelers: [],
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW,
	});
};

const addRole = (rkey: string, position: number, isProtected = false, permissions: string[] = []) =>
	database.db.insert(database.tables.roles).values({
		community: COMMUNITY,
		rkey,
		name: rkey,
		color: null,
		permissions,
		position,
		hoisted: false,
		mentionable: false,
		protected: isProtected,
		channelOverrides: [],
	});

const addMember = (did: string, roles: string[]) =>
	database.db.insert(database.tables.members).values({
		community: COMMUNITY,
		did,
		roles,
		joinedAt: NOW,
		nickname: null,
	});

beforeEach(async () => {
	database = await openTestDatabase();
	writes = [];
	removals = [];

	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	announced = [];
	ctx = {
		announce: {
			...silentAnnouncer,
			toCommunity: (community: string, frame: Record<string, unknown>) =>
				announced.push({ community, frame }),
		},
		config: { PUBLIC_URL: "https://appview.test" },
		database,
		loader,
	} as unknown as AppContext;

	communities = new CommunityViews(ctx, new ActorViews(ctx));

	await addCommunity();
	await addRole("owner", 1000, true, ["role.manage", "member.ban"]);
	await addRole("mod", 100, false, ["role.manage"]);
	await addMember(OWNER, ["owner"]);
	await addMember(MOD, ["mod"]);
	await addMember(MEMBER, []);
});

afterEach(async () => {
	await database.destroy();
});

describe("creating a role", () => {
	it("refuses a position at or above the caller's own highest role", async () => {
		await expect(
			handleCreateRole(ctx, fakeWriter(), communities, COMMUNITY, MOD, {
				name: "New",
				permissions: [],
				position: 100,
			}),
		).rejects.toMatchObject({ customErrorName: "RoleHierarchy" });
	});

	it("refuses granting a permission the caller does not hold", async () => {
		await expect(
			handleCreateRole(ctx, fakeWriter(), communities, COMMUNITY, MOD, {
				name: "New",
				permissions: ["member.ban"],
				position: 10,
			}),
		).rejects.toMatchObject({ customErrorName: "RoleHierarchy" });
	});

	it("lets a moderator create a role below their own position with permissions they hold", async () => {
		const result = await handleCreateRole(ctx, fakeWriter(), communities, COMMUNITY, MOD, {
			name: "New",
			permissions: ["role.manage"],
			position: 10,
		});

		expect(result.role.name).toBe("New");
		expect(result.role.position).toBe(10);
		expect(result.role.permissions).toEqual(["role.manage"]);
	});
});

describe("updating a role", () => {
	it("refuses moving a role to or above the caller's own position", async () => {
		await addRole("helper", 10, false, []);
		await expect(
			handleUpdateRole(ctx, fakeWriter(), communities, COMMUNITY, MOD, "helper", { position: 100 }),
		).rejects.toMatchObject({ customErrorName: "RoleHierarchy" });
	});

	it("refuses granting a permission the caller does not hold", async () => {
		await addRole("helper", 10, false, []);
		await expect(
			handleUpdateRole(ctx, fakeWriter(), communities, COMMUNITY, MOD, "helper", {
				permissions: ["member.ban"],
			}),
		).rejects.toMatchObject({ customErrorName: "RoleHierarchy" });
	});

	it("refuses updating a protected role", async () => {
		await expect(
			handleUpdateRole(ctx, fakeWriter(), communities, COMMUNITY, OWNER, "owner", {
				name: "Renamed",
			}),
		).rejects.toMatchObject({ customErrorName: "RoleProtected" });
	});

	it("lets a moderator rename a role below their own position", async () => {
		await addRole("helper", 10, false, ["role.manage"]);
		const result = await handleUpdateRole(
			ctx,
			fakeWriter(),
			communities,
			COMMUNITY,
			MOD,
			"helper",
			{
				name: "Helper renamed",
			},
		);
		expect(result.role.name).toBe("Helper renamed");
	});
});

describe("deleting a role", () => {
	it("refuses deleting a protected role", async () => {
		await expect(
			handleDeleteRole(ctx, fakeWriter(), COMMUNITY, OWNER, "owner"),
		).rejects.toMatchObject({ customErrorName: "RoleProtected" });
	});

	it("refuses deleting a role at or above the caller's own position", async () => {
		await addRole("senior", 500, false, []);
		await expect(
			handleDeleteRole(ctx, fakeWriter(), COMMUNITY, MOD, "senior"),
		).rejects.toMatchObject({ customErrorName: "RoleHierarchy" });
	});

	it("removes the role from every member that held it", async () => {
		await addRole("helper", 10, false, []);
		await addMember("did:plc:helper-holder-a", ["helper", "mod"]);
		await addMember("did:plc:helper-holder-b", ["helper"]);

		await handleDeleteRole(ctx, fakeWriter(), COMMUNITY, OWNER, "helper");

		const rows = await database.db
			.select()
			.from(database.tables.members)
			.where(eq(database.tables.members.community, COMMUNITY));

		const a = rows.find((row) => row.did === "did:plc:helper-holder-a");
		const b = rows.find((row) => row.did === "did:plc:helper-holder-b");
		expect(a?.roles).toEqual(["mod"]);
		expect(b?.roles).toEqual([]);

		const mod = rows.find((row) => row.did === MOD);
		expect(mod?.roles).toEqual(["mod"]);
	});
});

describe("announcing role changes", () => {
	it("tells the community when a role is created, changed and deleted", async () => {
		const { role } = await handleCreateRole(ctx, fakeWriter(), communities, COMMUNITY, OWNER, {
			name: "helper",
			permissions: [],
			position: 10,
		});

		await handleUpdateRole(ctx, fakeWriter(), communities, COMMUNITY, OWNER, role.rkey, {
			name: "helpers",
		});
		await handleDeleteRole(ctx, fakeWriter(), COMMUNITY, OWNER, role.rkey);

		expect(
			announced.map((entry) => ({
				community: entry.community,
				type: entry.frame.$type,
				event: entry.frame.event,
			})),
		).toEqual([
			{
				community: COMMUNITY,
				type: "social.colibri.beta.sync.defs#roleEvent",
				event: "create",
			},
			{
				community: COMMUNITY,
				type: "social.colibri.beta.sync.defs#roleEvent",
				event: "update",
			},
			{
				community: COMMUNITY,
				type: "social.colibri.beta.sync.defs#roleEvent",
				event: "delete",
			},
		]);
	});
});
