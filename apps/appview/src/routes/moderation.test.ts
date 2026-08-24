import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	CommunityLoader,
	type CommunityWriter,
	Membership,
	Moderation,
	type RecordWrite,
} from "@colibri-social/community";
import {
	COLLECTIONS,
	channelSpace,
	communitySpaces,
	PERMISSIONS,
	SPACE_TYPES,
} from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import {
	handleApplyLabel,
	handleApproveApplication,
	handleBan,
	handleDismissApplication,
	handleKick,
	handleListApplications,
	handleListBans,
	handleListModerationLog,
	handleNegateLabel,
	handleUnban,
	handleUndismissApplication,
} from "./moderation.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const OTHER_COMMUNITY = "did:plc:othercommunityxxxxxxxxxxxx";
const OWNER = "did:plc:ownerxxxxxxxxxxxxxxxxxxxxxxxx";
const MOD = "did:plc:moderatorxxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxxx";
const APPLICANT = "did:plc:applicantxxxxxxxxxxxxxxxxxxx";
const NOW = new Date("2026-08-23T00:00:00.000Z");

let database: TestDatabase;
let ctx: AppContext;
let loader: CommunityLoader;
let actors: ActorViews;
let membership: Membership;
let moderation: Moderation;
let writes: Array<{ community: string; write: RecordWrite }>;
let removals: Array<{ community: string; collection: string; rkey: string }>;

const fakeWriter = (): CommunityWriter => {
	const writer = {
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
			if (write.collection === COLLECTIONS.moderation) {
				const record = write.record as {
					action: "ban" | "unban" | "kick";
					subject: string;
					createdBy: string;
					createdAt: string;
					reason?: string;
				};
				await database.db.insert(database.tables.moderationLog).values({
					community,
					rkey,
					action: record.action,
					subject: record.subject,
					reason: record.reason ?? null,
					createdBy: record.createdBy,
					createdAt: record.createdAt,
				});
			}
			return { uri: `at://${community}/${write.collection}/${rkey}`, rkey };
		},
		remove: async (
			community: string,
			params: { space: string; collection: string; rkey: string },
		) => {
			removals.push({ community, collection: params.collection, rkey: params.rkey });
			if (params.collection === COLLECTIONS.member) {
				await database.db
					.delete(database.tables.members)
					.where(
						and(
							eq(database.tables.members.community, community),
							eq(database.tables.members.did, params.rkey),
						),
					);
			}
		},
		createSpaceFor: async () => ({ uri: "at://space" }),
		deleteSpaceFor: async () => undefined,
	};
	return writer as unknown as CommunityWriter;
};

const addRole = (
	community: string,
	rkey: string,
	position: number,
	isProtected = false,
	permissions: string[] = [],
) =>
	database.db.insert(database.tables.roles).values({
		community,
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

const addMember = (community: string, did: string, roles: string[]) =>
	database.db.insert(database.tables.members).values({
		community,
		did,
		roles,
		joinedAt: NOW.toISOString(),
		nickname: null,
	});

const addCommunity = (did: string) => {
	const spaces = communitySpaces(did);
	return database.db.insert(database.tables.communities).values({
		did,
		handle: null,
		name: "Test",
		description: null,
		pictureCid: null,
		bannerCid: null,
		requiresApproval: false,
		linkEmbeds: true,
		labelers: [],
		migratedFrom: null,
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW.toISOString(),
	});
};

const addChannel = (community: string, skey: string) =>
	database.db.insert(database.tables.channels).values({
		space: channelSpace(community, SPACE_TYPES.channelText, skey),
		community,
		spaceType: SPACE_TYPES.channelText,
		skey,
		name: "general",
		description: null,
		category: null,
		position: 0,
		ownerOnly: false,
		allowedRoles: [],
		allowedMembers: [],
		visibleToRoles: [],
		visibleToMembers: [],
		linkEmbeds: null,
		migratedFrom: null,
	});

beforeEach(async () => {
	database = await openTestDatabase();
	writes = [];
	removals = [];

	loader = new CommunityLoader({ db: database.db, tables: database.tables });
	const writer = fakeWriter();
	membership = new Membership({
		db: database.db,
		tables: database.tables,
		loader,
		writer,
		now: () => NOW,
	});
	moderation = new Moderation({
		db: database.db,
		tables: database.tables,
		loader,
		writer,
		membership,
		now: () => NOW,
	});

	ctx = {
		announce: silentAnnouncer,
		config: { PUBLIC_URL: "https://appview.test" },
		database,
		loader,
		identity: {
			resolveDid: async () => null,
			resolveVerifiedHandle: async () => null,
		},
	} as unknown as AppContext;
	actors = new ActorViews(ctx);

	await addCommunity(COMMUNITY);
	await addRole(COMMUNITY, "owner", 1000, true, [...PERMISSIONS]);
	await addRole(COMMUNITY, "mod", 100, false, [
		"member.kick",
		"member.ban",
		"member.unban",
		"approval.manage",
		"moderation.viewLog",
		"label.apply",
	]);
	await addMember(COMMUNITY, OWNER, ["owner"]);
	await addMember(COMMUNITY, MOD, ["mod"]);
	await addMember(COMMUNITY, MEMBER, []);
	await addChannel(COMMUNITY, "3lkchannel1");

	await addCommunity(OTHER_COMMUNITY);
	await addRole(OTHER_COMMUNITY, "owner", 1000, true, []);
	await addMember(OTHER_COMMUNITY, OWNER, []);
	await addChannel(OTHER_COMMUNITY, "3lkchannel2");
});

afterEach(async () => {
	await database.destroy();
});

describe("permission checks", () => {
	it("refuses a permission-less member for every moderation action", async () => {
		await expect(handleKick(ctx, moderation, MEMBER, COMMUNITY, MOD)).rejects.toMatchObject({
			customErrorName: "Forbidden",
		});
		await expect(handleBan(ctx, moderation, MEMBER, COMMUNITY, MOD)).rejects.toMatchObject({
			customErrorName: "Forbidden",
		});
		await expect(handleUnban(ctx, moderation, MEMBER, COMMUNITY, MOD)).rejects.toMatchObject({
			customErrorName: "Forbidden",
		});
		await expect(
			handleListBans(ctx, moderation, actors, MEMBER, COMMUNITY, { limit: 50 }),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
		await expect(
			handleListApplications(ctx, actors, MEMBER, COMMUNITY, {
				includeDismissed: false,
				limit: 50,
			}),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
		await expect(
			handleApproveApplication(ctx, actors, membership, MEMBER, COMMUNITY, APPLICANT),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
		await expect(
			handleDismissApplication(ctx, membership, MEMBER, COMMUNITY, APPLICANT),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
		await expect(
			handleUndismissApplication(ctx, membership, MEMBER, COMMUNITY, APPLICANT),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
		await expect(
			handleListModerationLog(ctx, actors, MEMBER, COMMUNITY, { limit: 50 }),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });

		const space = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel1");
		const subject = { did: MEMBER, collection: "social.colibri.beta.message", rkey: "3lkmsg1" };
		await expect(
			handleApplyLabel(ctx, moderation, MEMBER, { space, subject, val: "hidden" }),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
		await expect(
			handleNegateLabel(ctx, moderation, MEMBER, { space, subject, val: "hidden" }),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
	});
});

describe("applyLabel", () => {
	it("refuses a space belonging to a different community", async () => {
		const foreignSpace = channelSpace(OTHER_COMMUNITY, SPACE_TYPES.channelText, "3lkchannel2");
		const subject = { did: MEMBER, collection: "social.colibri.beta.message", rkey: "3lkmsg1" };

		await expect(
			handleApplyLabel(ctx, moderation, OWNER, { space: foreignSpace, subject, val: "hidden" }),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });

		const ownSpace = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel1");
		const result = await handleApplyLabel(ctx, moderation, OWNER, {
			space: ownSpace,
			subject,
			val: "hidden",
		});
		expect(result.label.val).toBe("hidden");
	});
});

describe("ban and unban", () => {
	it("leaves the user unbanned after a ban followed by an unban", async () => {
		await handleBan(ctx, moderation, OWNER, COMMUNITY, MEMBER, "spam");
		expect((await loader.authz(COMMUNITY, MEMBER)).isBanned).toBe(true);

		await handleUnban(ctx, moderation, OWNER, COMMUNITY, MEMBER);
		expect((await loader.authz(COMMUNITY, MEMBER)).isBanned).toBe(false);
	});
});
