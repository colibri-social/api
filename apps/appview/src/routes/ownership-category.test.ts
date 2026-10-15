import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	CommunityLoader,
	type CommunityWriter,
	Membership,
	type RecordWrite,
} from "@colibri-social/community";
import { COLLECTIONS, channelSpace, communitySpaces, SPACE_TYPES } from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import { handleCreateCategory, handleUpdateCategory } from "./category.js";
import { handleTransferOwnership } from "./community-write.js";

const COMMUNITY = "did:plc:community";
const OWNER = "did:plc:owner";
const MOD = "did:plc:moderator";
const MEMBER = "did:plc:member";
const STAFFER = "did:plc:staffer";
const NOW = "2026-10-12T00:00:00.000Z";

type CategoryRecord = {
	name: string;
	channelOrder: string[];
	ownerOnly?: boolean;
	allowedRoles?: string[];
	allowedMembers?: string[];
	visibleToRoles?: string[];
	visibleToMembers?: string[];
};

let database: TestDatabase;
let ctx: AppContext;
let communities: CommunityViews;
let membership: Membership;
let writer: CommunityWriter;
let announced: Array<{ community: string; frame: Record<string, unknown> }>;
let writes: Array<{ community: string; write: RecordWrite }>;

const fakeWriter = (): CommunityWriter => {
	const fake = {
		spaces: (community: string) => communitySpaces(community),
		put: async (community: string, write: RecordWrite) => {
			writes.push({ community, write });
			const rkey = write.rkey ?? `generated-${writes.length}`;
			if (write.collection === COLLECTIONS.member) {
				const record = write.record as { subject: string; roles?: string[]; joinedAt: string };
				await database.db
					.insert(database.tables.members)
					.values({
						community,
						did: record.subject,
						roles: record.roles ?? [],
						joinedAt: record.joinedAt,
						nickname: null,
					})
					.onConflictDoUpdate({
						target: [database.tables.members.community, database.tables.members.did],
						set: { roles: record.roles ?? [] },
					});
			}
			if (write.collection === COLLECTIONS.category) {
				const record = write.record as CategoryRecord;
				const fields = {
					name: record.name,
					channelOrder: record.channelOrder,
					ownerOnly: record.ownerOnly ?? false,
					allowedRoles: record.allowedRoles ?? [],
					allowedMembers: record.allowedMembers ?? [],
					visibleToRoles: record.visibleToRoles ?? [],
					visibleToMembers: record.visibleToMembers ?? [],
				};
				await database.db
					.insert(database.tables.categories)
					.values({ community, rkey, ...fields })
					.onConflictDoUpdate({
						target: [database.tables.categories.community, database.tables.categories.rkey],
						set: fields,
					});
			}
			return { uri: `at://${community}/${write.collection}/${rkey}`, rkey };
		},
		remove: async () => undefined,
		createSpaceFor: async () => ({ uri: "at://space" }),
		deleteSpaceFor: async () => undefined,
	};
	return fake as unknown as CommunityWriter;
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

const addChannel = (skey: string, category: string | null, visibleToMembers: string[] = []) =>
	database.db.insert(database.tables.channels).values({
		space: channelSpace(COMMUNITY, SPACE_TYPES.channelText, skey),
		community: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey,
		name: skey,
		description: null,
		category,
		position: 0,
		ownerOnly: false,
		allowedRoles: [],
		allowedMembers: [],
		visibleToRoles: [],
		visibleToMembers,
		linkEmbeds: null,
		migratedFrom: null,
	});

const readable = async (did: string) => {
	const authz = await ctx.loader.authz(COMMUNITY, did);
	return (await communities.channels(COMMUNITY, authz)).map((channel) => channel.name).sort();
};

beforeEach(async () => {
	database = await openTestDatabase();
	writes = [];
	announced = [];
	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	ctx = {
		announce: {
			...silentAnnouncer,
			toCommunity: (community: string, frame: Record<string, unknown>) =>
				announced.push({ community, frame }),
		},
		config: { PUBLIC_URL: "https://appview.test", SIGNING_KEY: "abcdef0123456789" },
		database,
		loader,
		identity: {
			resolveDid: async (did: string) => ({
				did,
				handle: "handle.invalid",
				pds: "",
				signingKey: "",
			}),
			resolveVerifiedHandles: async (dids: readonly string[]) =>
				new Map(dids.map((did) => [did, null])),
		},
	} as unknown as AppContext;
	communities = new CommunityViews(ctx, new ActorViews(ctx));
	writer = fakeWriter();
	membership = new Membership({ db: database.db, tables: database.tables, loader, writer });

	const spaces = communitySpaces(COMMUNITY);
	await database.db.insert(database.tables.communities).values({
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
	await addRole("owner", 1000, true);
	await addRole("mod", 100, false, ["category.create", "category.update"]);
	await addRole("staff", 50);
	await addRole("lead", 500);
	await addMember(OWNER, ["owner"]);
	await addMember(MOD, ["mod"]);
	await addMember(MEMBER, []);
	await addMember(STAFFER, ["staff"]);
});

afterEach(async () => {
	await database.destroy();
});

describe("transferOwnership", () => {
	it("returns both members with their new roles and announces both", async () => {
		const result = await handleTransferOwnership(ctx, new ActorViews(ctx), membership, OWNER, {
			community: COMMUNITY,
			subject: MEMBER,
		});
		expect(result.owner.roles).toEqual(["owner"]);
		expect(result.previousOwner.roles).toEqual([]);
		expect(
			announced.map((entry) => (entry.frame.member as { actor: { did: string } }).actor.did),
		).toEqual([MEMBER, OWNER]);
		const authz = await ctx.loader.authz(COMMUNITY, MEMBER);
		expect(authz.roles.some((role) => role.protected)).toBe(true);
	});

	it("refuses a caller without the owner role as Forbidden", async () => {
		await expect(
			handleTransferOwnership(ctx, new ActorViews(ctx), membership, MOD, {
				community: COMMUNITY,
				subject: MEMBER,
			}),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
	});

	it("refuses a subject who is not a member", async () => {
		await expect(
			handleTransferOwnership(ctx, new ActorViews(ctx), membership, OWNER, {
				community: COMMUNITY,
				subject: "did:plc:stranger",
			}),
		).rejects.toMatchObject({ customErrorName: "MemberNotFound" });
	});

	it("refuses a subject who already holds the owner role", async () => {
		await addMember("did:plc:coowner", ["owner"]);
		await expect(
			handleTransferOwnership(ctx, new ActorViews(ctx), membership, OWNER, {
				community: COMMUNITY,
				subject: "did:plc:coowner",
			}),
		).rejects.toMatchObject({ customErrorName: "AlreadyOwner" });
	});
});

describe("category permissions", () => {
	it("stores the permissions on the record and serves them on the view", async () => {
		const { category } = await handleCreateCategory(ctx, writer, communities, COMMUNITY, MOD, {
			name: "Staff",
			visibleToRoles: ["staff"],
			allowedMembers: [STAFFER],
		});
		expect(category).toMatchObject({
			name: "Staff",
			visibleToRoles: ["staff"],
			allowedMembers: [STAFFER],
			private: true,
		});
		const record = writes.find((entry) => entry.write.collection === COLLECTIONS.category)?.write
			.record as CategoryRecord;
		expect(record).toEqual({
			$type: COLLECTIONS.category,
			name: "Staff",
			channelOrder: [],
			allowedMembers: [STAFFER],
			visibleToRoles: ["staff"],
		});
	});

	it("hides channels in a private category from members outside it", async () => {
		const { category } = await handleCreateCategory(ctx, writer, communities, COMMUNITY, MOD, {
			name: "Staff",
		});
		await addChannel("lounge", category.rkey);
		await addChannel("general", null);
		await addChannel("guests", category.rkey, [MEMBER]);

		await handleUpdateCategory(ctx, writer, communities, COMMUNITY, MOD, category.rkey, {
			visibleToRoles: ["staff"],
		});

		expect(await readable(MEMBER)).toEqual(["general", "guests"]);
		expect(await readable(STAFFER)).toEqual(["general", "lounge"]);
		expect(await readable(OWNER)).toEqual(["general", "guests", "lounge"]);
	});

	it("keeps the permissions when only the name changes", async () => {
		const { category } = await handleCreateCategory(ctx, writer, communities, COMMUNITY, MOD, {
			name: "Staff",
			visibleToRoles: ["staff"],
		});
		const updated = await handleUpdateCategory(
			ctx,
			writer,
			communities,
			COMMUNITY,
			MOD,
			category.rkey,
			{ name: "Crew" },
		);
		expect(updated.category).toMatchObject({ name: "Crew", visibleToRoles: ["staff"] });
		const [row] = await database.db
			.select()
			.from(database.tables.categories)
			.where(
				and(
					eq(database.tables.categories.community, COMMUNITY),
					eq(database.tables.categories.rkey, category.rkey),
				),
			);
		expect(row?.visibleToRoles).toEqual(["staff"]);
	});

	it("refuses granting visibility to a role at or above the caller's own", async () => {
		await expect(
			handleCreateCategory(ctx, writer, communities, COMMUNITY, MOD, {
				name: "Leads",
				visibleToRoles: ["lead"],
			}),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
	});
});
