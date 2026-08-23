import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { communitySpaces } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommunityLoader } from "./loader.js";
import { Membership, MembershipError } from "./membership.js";
import { Moderation, ModerationError } from "./moderation.js";
import type { CommunityWriter, RecordWrite } from "./writes.js";

const COMMUNITY = "did:plc:community";
const OWNER = "did:plc:owner";
const MOD = "did:plc:moderator";
const MEMBER = "did:plc:member";
const OUTSIDER = "did:plc:outsider";
const NOW = new Date("2026-08-23T00:00:00.000Z");

let database: TestDatabase;
let loader: CommunityLoader;
let membership: Membership;
let moderation: Moderation;
let writes: Array<{ community: string; write: RecordWrite }>;
let removals: Array<{ community: string; rkey: string; collection: string }>;

const fakeWriter = (): CommunityWriter => {
	const writer = {
		spaces: (community: string) => communitySpaces(community),
		put: async (community: string, write: RecordWrite) => {
			writes.push({ community, write });
			const rkey = write.rkey ?? `generated-${writes.length}`;
			if (write.collection === "social.colibri.beta.member") {
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
			if (write.collection === "social.colibri.beta.moderation") {
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
			if (params.collection === "social.colibri.beta.member") {
				const { and, eq } = await import("drizzle-orm");
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
		joinedAt: NOW.toISOString(),
		nickname: null,
	});

const addCommunity = (requiresApproval: boolean) => {
	const spaces = communitySpaces(COMMUNITY);
	return database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Test",
		requiresApproval,
		linkEmbeds: true,
		labelers: [],
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW.toISOString(),
	});
};

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

	await addCommunity(false);
	await addRole("owner", 1000, true);
	await addRole("mod", 100, false, ["member.kick", "member.ban"]);
	await addMember(OWNER, ["owner"]);
	await addMember(MOD, ["mod"]);
	await addMember(MEMBER, []);
});

afterEach(async () => {
	await database.destroy();
});

describe("joining", () => {
	it("admits straight away when the community is open", async () => {
		expect(await membership.join(COMMUNITY, OUTSIDER)).toEqual({ status: "joined" });
		const authz = await loader.authz(COMMUNITY, OUTSIDER);
		expect(authz.member).not.toBeNull();
	});

	it("holds an application when the community requires approval", async () => {
		const { eq } = await import("drizzle-orm");
		await database.db
			.update(database.tables.communities)
			.set({ requiresApproval: true })
			.where(eq(database.tables.communities.did, COMMUNITY));

		expect(await membership.join(COMMUNITY, OUTSIDER)).toEqual({ status: "pending" });
		expect((await loader.authz(COMMUNITY, OUTSIDER)).member).toBeNull();

		await membership.approve(COMMUNITY, OUTSIDER);
		expect((await loader.authz(COMMUNITY, OUTSIDER)).member).not.toBeNull();
	});

	it("refuses someone who is already a member", async () => {
		await expect(membership.join(COMMUNITY, MEMBER)).rejects.toMatchObject({
			failure: "alreadyMember",
		});
	});

	it("refuses a banned user", async () => {
		await moderation.ban(COMMUNITY, OWNER, MEMBER);
		await expect(membership.join(COMMUNITY, MEMBER)).rejects.toMatchObject({ failure: "banned" });
	});

	it("refuses approving someone who never applied", async () => {
		await expect(membership.approve(COMMUNITY, OUTSIDER)).rejects.toBeInstanceOf(MembershipError);
	});

	it("refuses dismissing someone who never applied", async () => {
		await expect(membership.dismiss(COMMUNITY, OUTSIDER, true)).rejects.toMatchObject({
			failure: "applicationNotFound",
		});
	});

	it("dismisses and restores a real application", async () => {
		const { and, eq } = await import("drizzle-orm");
		await database.db
			.update(database.tables.communities)
			.set({ requiresApproval: true })
			.where(eq(database.tables.communities.did, COMMUNITY));
		await membership.join(COMMUNITY, OUTSIDER);

		const dismissedAt = async () => {
			const [row] = await database.db
				.select()
				.from(database.tables.applications)
				.where(
					and(
						eq(database.tables.applications.community, COMMUNITY),
						eq(database.tables.applications.did, OUTSIDER),
					),
				);
			return row?.dismissedAt ?? null;
		};

		await membership.dismiss(COMMUNITY, OUTSIDER, true);
		expect(await dismissedAt()).not.toBeNull();

		await membership.dismiss(COMMUNITY, OUTSIDER, false);
		expect(await dismissedAt()).toBeNull();
	});
});

describe("leaving", () => {
	it("lets an ordinary member leave", async () => {
		await membership.leave(COMMUNITY, MEMBER);
		expect((await loader.authz(COMMUNITY, MEMBER)).member).toBeNull();
	});

	it("refuses to let the only administrator leave", async () => {
		await expect(membership.leave(COMMUNITY, OWNER)).rejects.toMatchObject({
			failure: "soleOwner",
		});
	});

	it("lets an administrator leave once another one exists", async () => {
		await addMember("did:plc:second", ["owner"]);
		await membership.leave(COMMUNITY, OWNER);
		expect((await loader.authz(COMMUNITY, OWNER)).member).toBeNull();
	});
});

describe("hierarchy", () => {
	it("lets a moderator kick an ordinary member", async () => {
		await moderation.kick(COMMUNITY, MOD, MEMBER, "spam");
		expect((await loader.authz(COMMUNITY, MEMBER)).member).toBeNull();
	});

	it("refuses a moderator kicking an administrator", async () => {
		await expect(moderation.kick(COMMUNITY, MOD, OWNER)).rejects.toBeInstanceOf(MembershipError);
	});

	it("refuses an ordinary member kicking anyone", async () => {
		await expect(moderation.kick(COMMUNITY, MEMBER, MOD)).rejects.toBeInstanceOf(MembershipError);
	});

	it("refuses granting a role at or above your own", async () => {
		await expect(membership.setRoles(COMMUNITY, MOD, MEMBER, ["owner"])).rejects.toMatchObject({
			failure: "hierarchy",
		});
	});

	it("lets an administrator grant a lower role", async () => {
		await membership.setRoles(COMMUNITY, OWNER, MEMBER, ["mod"]);
		expect((await loader.authz(COMMUNITY, MEMBER)).member?.roles).toEqual(["mod"]);
	});

	it("tells a role that does not exist apart from one you cannot grant", async () => {
		await expect(
			membership.setRoles(COMMUNITY, OWNER, MEMBER, ["nosuchrole"]),
		).rejects.toMatchObject({ failure: "roleNotFound" });
	});
});

describe("banning", () => {
	it("removes the member record and logs the ban", async () => {
		await moderation.ban(COMMUNITY, OWNER, MEMBER, "spam");

		const authz = await loader.authz(COMMUNITY, MEMBER);
		expect(authz.member).toBeNull();
		expect(authz.isBanned).toBe(true);
		expect(removals.some((entry) => entry.rkey === MEMBER)).toBe(true);
	});

	it("does not touch the banned member's own records", async () => {
		await moderation.ban(COMMUNITY, OWNER, MEMBER);
		expect(removals.every((entry) => entry.collection === "social.colibri.beta.member")).toBe(true);
	});

	it("refuses banning twice", async () => {
		await moderation.ban(COMMUNITY, OWNER, MEMBER);
		await expect(moderation.ban(COMMUNITY, OWNER, MEMBER)).rejects.toMatchObject({
			failure: "alreadyBanned",
		});
	});

	it("lifts a ban with a later log entry rather than a deletion", async () => {
		await moderation.ban(COMMUNITY, OWNER, MEMBER);
		await moderation.unban(COMMUNITY, OWNER, MEMBER);

		expect((await loader.authz(COMMUNITY, MEMBER)).isBanned).toBe(false);
		const entries = await database.db.select().from(database.tables.moderationLog);
		expect(entries).toHaveLength(2);
	});

	it("refuses unbanning someone who is not banned", async () => {
		await expect(moderation.unban(COMMUNITY, OWNER, MEMBER)).rejects.toMatchObject({
			failure: "notBanned",
		});
	});

	it("lists only members whose most recent entry is a ban", async () => {
		await moderation.ban(COMMUNITY, OWNER, MEMBER);
		await moderation.ban(COMMUNITY, OWNER, OUTSIDER);
		await moderation.unban(COMMUNITY, OWNER, MEMBER);

		const { bans } = await moderation.listBans(COMMUNITY);
		expect(bans.map((entry) => entry.subject)).toEqual([OUTSIDER]);
	});

	it("pages through bans and stops handing out a cursor at the end", async () => {
		await moderation.ban(COMMUNITY, OWNER, MEMBER);
		await moderation.ban(COMMUNITY, OWNER, MOD);
		await moderation.ban(COMMUNITY, OWNER, OUTSIDER);

		const first = await moderation.listBans(COMMUNITY, { limit: 2 });
		expect(first.bans).toHaveLength(2);
		expect(first.cursor).toBe(first.bans.at(-1)?.rkey);

		const second = await moderation.listBans(COMMUNITY, { limit: 2, cursor: first.cursor });
		expect(second.bans).toHaveLength(1);
		expect(second.cursor).toBeUndefined();

		const seen = [...first.bans, ...second.bans].map((entry) => entry.subject);
		expect(new Set(seen)).toEqual(new Set([MEMBER, MOD, OUTSIDER]));
	});
});

describe("labels", () => {
	const space = "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchan";
	const subject = { did: MEMBER, collection: "social.colibri.beta.message", rkey: "3lkmsg1" };

	it("writes a label into the space the content lives in", async () => {
		await moderation.applyLabel(COMMUNITY, space, subject, "hidden", { reason: "spam" });
		const written = writes.at(-1);
		expect(written?.write.space).toBe(space);
		expect(written?.write.collection).toBe("social.colibri.beta.label");
		expect(written?.write.record).toMatchObject({ val: "hidden", subject });
	});

	it("refuses retracting a label that was never applied", async () => {
		await expect(
			moderation.negateLabel(COMMUNITY, space, subject, "hidden"),
		).rejects.toBeInstanceOf(ModerationError);
	});

	it("retracts by writing a negating label", async () => {
		await database.db.insert(database.tables.labels).values({
			space,
			src: COMMUNITY,
			rkey: "3lklabel1",
			subjectDid: subject.did,
			subjectCollection: subject.collection,
			subjectRkey: subject.rkey,
			val: "hidden",
			scope: null,
			negated: false,
			reason: null,
			createdAt: NOW.toISOString(),
		});

		await moderation.negateLabel(COMMUNITY, space, subject, "hidden");
		expect(writes.at(-1)?.write.record).toMatchObject({ val: "hidden", neg: true });
	});
});
