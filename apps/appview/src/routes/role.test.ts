import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader, type CommunityWriter, type RecordWrite } from "@colibri-social/community";
import { COLLECTIONS, communitySpaces } from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import {
	handleCreateRole,
	handleDeleteRole,
	handlePutRoleBadgeImage,
	handleUpdateRole,
} from "./role.js";

const COMMUNITY = "did:plc:community";
const OWNER = "did:plc:owner";
const MOD = "did:plc:moderator";
const MEMBER = "did:plc:member";
const NOW = "2026-08-23T00:00:00.000Z";
const BADGE_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiibsojllbf5xhqzy6a";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

type BadgeRecord =
	| { $type: "social.colibri.beta.role#iconBadge"; icon: string; color?: string }
	| {
			$type: "social.colibri.beta.role#imageBadge";
			image: { ref: { $link: string }; mimeType: string; size: number };
	  };

const badgeRow = (badge: BadgeRecord | undefined) => {
	if (!badge) return null;
	if (badge.$type === "social.colibri.beta.role#iconBadge") {
		return {
			kind: "icon" as const,
			icon: badge.icon,
			...(badge.color ? { color: badge.color } : {}),
		};
	}
	return {
		kind: "image" as const,
		cid: badge.image.ref.$link,
		mimeType: badge.image.mimeType,
		size: badge.image.size,
	};
};

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
					badge?: BadgeRecord;
				};
				const row = {
					community,
					rkey,
					name: record.name,
					color: record.color ?? null,
					badge: badgeRow(record.badge),
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
		uploadBlob: async (_community: string, bytes: Uint8Array, mimeType: string) => ({
			$type: "blob" as const,
			ref: { $link: BADGE_CID },
			mimeType,
			size: bytes.byteLength,
		}),
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
		config: { PUBLIC_URL: "https://appview.test", SIGNING_KEY: "abcdef0123456789" },
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

const roleRecordWrites = () =>
	writes
		.filter((entry) => entry.write.collection === COLLECTIONS.role)
		.map((entry) => entry.write.record as Record<string, unknown>);

describe("role badges", () => {
	it("creates a role with an icon badge on the record and the view", async () => {
		const { role } = await handleCreateRole(ctx, fakeWriter(), communities, COMMUNITY, MOD, {
			name: "Helper",
			permissions: [],
			position: 10,
			badge: { icon: "shield-check", color: "#76C4E5" },
		});

		expect(roleRecordWrites().at(-1)?.badge).toEqual({
			$type: "social.colibri.beta.role#iconBadge",
			icon: "shield-check",
			color: "#76c4e5",
		});
		expect(role.badge).toEqual({
			$type: "social.colibri.beta.community.defs#roleIconBadge",
			icon: "shield-check",
			color: "#76c4e5",
		});
	});

	it("refuses a badge colour that is not #rrggbb", async () => {
		await expect(
			handleCreateRole(ctx, fakeWriter(), communities, COMMUNITY, MOD, {
				name: "Helper",
				permissions: [],
				position: 10,
				badge: { icon: "star", color: "red" },
			}),
		).rejects.toMatchObject({ customErrorName: "InvalidRequest" });
	});

	it("keeps the badge when an update leaves it out", async () => {
		const { role } = await handleCreateRole(ctx, fakeWriter(), communities, COMMUNITY, MOD, {
			name: "Helper",
			permissions: [],
			position: 10,
			badge: { icon: "star" },
		});

		const updated = await handleUpdateRole(
			ctx,
			fakeWriter(),
			communities,
			COMMUNITY,
			MOD,
			role.rkey,
			{ name: "Helpers" },
		);

		expect(updated.role.badge).toEqual({
			$type: "social.colibri.beta.community.defs#roleIconBadge",
			icon: "star",
		});
		expect(roleRecordWrites().at(-1)?.badge).toEqual({
			$type: "social.colibri.beta.role#iconBadge",
			icon: "star",
		});
	});

	it("removes the badge with removeBadge, and a given badge wins over removeBadge", async () => {
		const { role } = await handleCreateRole(ctx, fakeWriter(), communities, COMMUNITY, MOD, {
			name: "Helper",
			permissions: [],
			position: 10,
			badge: { icon: "star" },
		});

		const replaced = await handleUpdateRole(
			ctx,
			fakeWriter(),
			communities,
			COMMUNITY,
			MOD,
			role.rkey,
			{ badge: { icon: "crown" }, removeBadge: true },
		);
		expect(replaced.role.badge).toMatchObject({ icon: "crown" });

		const removed = await handleUpdateRole(
			ctx,
			fakeWriter(),
			communities,
			COMMUNITY,
			MOD,
			role.rkey,
			{ removeBadge: true },
		);
		expect(removed.role.badge).toBeUndefined();
		expect(roleRecordWrites().at(-1)).not.toHaveProperty("badge");
	});

	it("uploads a badge image as the community and serves it through a signed members-space link", async () => {
		await addRole("helper", 10, false, []);

		const { role } = await handlePutRoleBadgeImage(
			ctx,
			fakeWriter(),
			communities,
			COMMUNITY,
			MOD,
			"helper",
			PNG,
		);

		expect(roleRecordWrites().at(-1)?.badge).toEqual({
			$type: "social.colibri.beta.role#imageBadge",
			image: {
				$type: "blob",
				ref: { $link: BADGE_CID },
				mimeType: "image/png",
				size: PNG.byteLength,
			},
		});
		expect(role.badge?.$type).toBe("social.colibri.beta.community.defs#roleImageBadgeView");
		const url = new URL((role.badge as { image: string }).image);
		expect(url.searchParams.get("cid")).toBe(BADGE_CID);
		expect(url.searchParams.get("space")).toBe(communitySpaces(COMMUNITY).members);
		expect(url.searchParams.get("viewer")).toBe(MOD);
	});

	it("keeps an image badge when the role is renamed", async () => {
		await addRole("helper", 10, false, []);
		await handlePutRoleBadgeImage(ctx, fakeWriter(), communities, COMMUNITY, MOD, "helper", PNG);

		const { role } = await handleUpdateRole(
			ctx,
			fakeWriter(),
			communities,
			COMMUNITY,
			MOD,
			"helper",
			{ name: "Helpers" },
		);

		expect(role.badge?.$type).toBe("social.colibri.beta.community.defs#roleImageBadgeView");
		expect(roleRecordWrites().at(-1)?.badge).toMatchObject({
			$type: "social.colibri.beta.role#imageBadge",
			image: { ref: { $link: BADGE_CID } },
		});
	});

	it("refuses a badge image that is not an accepted type", async () => {
		await addRole("helper", 10, false, []);
		await expect(
			handlePutRoleBadgeImage(
				ctx,
				fakeWriter(),
				communities,
				COMMUNITY,
				MOD,
				"helper",
				new TextEncoder().encode("not an image"),
			),
		).rejects.toMatchObject({ customErrorName: "UnsupportedImage" });
	});

	it("refuses a badge image over 256 KB, also while streaming", async () => {
		await addRole("helper", 10, false, []);
		const oversized = new Uint8Array(256 * 1024 + 1);
		oversized.set(PNG);
		await expect(
			handlePutRoleBadgeImage(ctx, fakeWriter(), communities, COMMUNITY, MOD, "helper", oversized),
		).rejects.toMatchObject({ customErrorName: "ImageTooLarge" });

		async function* stream() {
			yield PNG;
			yield new Uint8Array(256 * 1024);
		}
		await expect(
			handlePutRoleBadgeImage(ctx, fakeWriter(), communities, COMMUNITY, MOD, "helper", stream()),
		).rejects.toMatchObject({ customErrorName: "ImageTooLarge" });
	});

	it("refuses a badge image on a protected role or one at the caller's position", async () => {
		await expect(
			handlePutRoleBadgeImage(ctx, fakeWriter(), communities, COMMUNITY, OWNER, "owner", PNG),
		).rejects.toMatchObject({ customErrorName: "RoleProtected" });
		await addRole("senior", 500, false, []);
		await expect(
			handlePutRoleBadgeImage(ctx, fakeWriter(), communities, COMMUNITY, MOD, "senior", PNG),
		).rejects.toMatchObject({ customErrorName: "RoleHierarchy" });
	});

	it("refuses a member without role.manage", async () => {
		await addRole("helper", 10, false, []);
		await expect(
			handlePutRoleBadgeImage(ctx, fakeWriter(), communities, COMMUNITY, MEMBER, "helper", PNG),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
	});
});
