import { l } from "@atproto/lex-schema";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { channelSpace, communitySpaces, SPACE_TYPES, social } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import { handleListCommunities } from "./actor.js";
import { handleGetCommunity, handleGetInvitation, handleListChannels } from "./community.js";

const NOW = "2026-08-23T00:00:00.000Z";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxxx";
const OUTSIDER = "did:plc:outsiderxxxxxxxxxxxxxxxxxxxxx";

let database: TestDatabase;
let ctx: AppContext;
let communities: CommunityViews;
let didDocumentHandles: Map<string, string>;

const asListCommunitiesOutput = (body: unknown): void => {
	const { output } = l.getMain(social.colibri.beta.actor.listCommunities);
	const result = output.schema.safeValidate(body);
	if (!result.success) throw new Error(result.reason.message);
};

const insertCommunity = async (did: string, name: string, managingApp: string | null = null) => {
	const spaces = communitySpaces(did);
	await database.db.insert(database.tables.communities).values({
		did,
		handle: null,
		name,
		description: null,
		managingApp,
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
		indexedAt: NOW,
	});
};

const insertMember = async (
	community: string,
	did: string,
	joinedAt: string,
	roles: string[] = [],
) => {
	await database.db.insert(database.tables.members).values({
		community,
		did,
		roles,
		joinedAt,
		nickname: null,
	});
};

const memberDid = (index: number) => `did:plc:member${String(index).padStart(20, "0")}`;

beforeEach(async () => {
	database = await openTestDatabase();

	didDocumentHandles = new Map();

	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	ctx = {
		announce: silentAnnouncer,
		config: { PUBLIC_URL: "https://appview.test", APPVIEW_DID: "did:web:appview.test" },
		database,
		loader,
		identity: {
			resolveDid: async (did: string) => {
				const handle = didDocumentHandles.get(did);
				if (!handle) throw new Error(`no DID document for ${did}`);
				return { did, handle, pds: "https://pds.test", signingKey: "did:key:zQ3sh" };
			},
			resolveVerifiedHandles: async (dids: readonly string[]) =>
				new Map(dids.map((did) => [did, didDocumentHandles.get(did) ?? null])),
		},
	} as unknown as AppContext;

	communities = new CommunityViews(ctx, new ActorViews(ctx));
});

afterEach(async () => {
	await database.destroy();
});

describe("listChannels", () => {
	it("refuses a non-member and allows a member", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
		await insertMember(COMMUNITY, MEMBER, NOW);

		const space = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel1");
		await database.db.insert(database.tables.channels).values({
			space,
			community: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey: "3lkchannel1",
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

		await expect(handleListChannels(ctx, communities, COMMUNITY, OUTSIDER)).rejects.toMatchObject({
			customErrorName: "Forbidden",
		});

		const result = await handleListChannels(ctx, communities, COMMUNITY, MEMBER);
		expect(result.channels).toHaveLength(1);
		expect(result.channels[0]?.space).toBe(space);
	});
});

const insertBan = async (community: string, did: string) => {
	await database.db.insert(database.tables.moderationLog).values({
		community,
		rkey: "3kbanxxxxxxxx",
		action: "ban",
		subject: did,
		reason: null,
		createdBy: MEMBER,
		createdAt: NOW,
	});
};

const insertInvitation = async (community: string, code: string) => {
	await database.db.insert(database.tables.invitations).values({
		code,
		community,
		createdBy: MEMBER,
		active: true,
		uses: 0,
		maxUses: null,
		createdAt: NOW,
		expiresAt: null,
	});
};

describe("member-only reads", () => {
	it("says a banned caller is banned rather than merely absent", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
		await insertBan(COMMUNITY, OUTSIDER);

		await expect(handleListChannels(ctx, communities, COMMUNITY, OUTSIDER)).rejects.toMatchObject({
			customErrorName: "Forbidden",
			message: "you are banned from this community",
		});
	});

	it("still says a stranger is not a member", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");

		await expect(handleListChannels(ctx, communities, COMMUNITY, OUTSIDER)).rejects.toMatchObject({
			customErrorName: "Forbidden",
			message: "you are not a member of this community",
		});
	});
});

describe("getInvitation", () => {
	it("works without authentication", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
		await database.db.insert(database.tables.invitations).values({
			code: "welcome-code",
			community: COMMUNITY,
			createdBy: MEMBER,
			active: true,
			uses: 0,
			maxUses: null,
			createdAt: NOW,
			expiresAt: null,
		});

		const result = await handleGetInvitation(ctx, communities, "welcome-code", null);
		expect(result.invitation.code).toBe("welcome-code");
		expect(result.community.did).toBe(COMMUNITY);
	});

	it("reports an unknown code as InvitationNotFound", async () => {
		await expect(handleGetInvitation(ctx, communities, "nope", null)).rejects.toMatchObject({
			customErrorName: "InvitationNotFound",
		});
	});

	it("tells a banned caller that they are banned", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
		await insertInvitation(COMMUNITY, "welcome-code");
		await insertBan(COMMUNITY, OUTSIDER);

		const result = await handleGetInvitation(ctx, communities, "welcome-code", OUTSIDER);
		expect(result.community.viewer.isBanned).toBe(true);
		expect(result.community.viewer.isMember).toBe(false);
	});

	it("tells a member that they already joined", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
		await insertInvitation(COMMUNITY, "welcome-code");
		await insertMember(COMMUNITY, MEMBER, NOW);

		const result = await handleGetInvitation(ctx, communities, "welcome-code", MEMBER);
		expect(result.community.viewer.isMember).toBe(true);
		expect(result.community.viewer.isBanned).toBe(false);
	});

	it("keeps an anonymous caller anonymous", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
		await insertInvitation(COMMUNITY, "welcome-code");
		await insertBan(COMMUNITY, OUTSIDER);

		const result = await handleGetInvitation(ctx, communities, "welcome-code", null);
		expect(result.community.viewer.isBanned).toBe(false);
		expect(result.community.viewer.isMember).toBe(false);
	});
});

describe("managingApp", () => {
	it("names this AppView when the synced record has not said otherwise", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");

		const result = await handleGetCommunity(ctx, communities, COMMUNITY, OUTSIDER);
		expect(result.community.managingApp).toBe("did:web:appview.test");
	});

	it("names the hub the record points at, so a client can dial it", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds", "did:web:hub.example");

		const result = await handleGetCommunity(ctx, communities, COMMUNITY, OUTSIDER);
		expect(result.community.managingApp).toBe("did:web:hub.example");
	});
});

describe("listCommunities", () => {
	it("honours the actor's stored order, appending anything missing by join date", async () => {
		const A = "did:plc:communityaaaaaaaaaaaaaaaaaaaa";
		const B = "did:plc:communitybbbbbbbbbbbbbbbbbbbb";
		const C = "did:plc:communityccccccccccccccccccc";

		await insertCommunity(A, "A");
		await insertCommunity(B, "B");
		await insertCommunity(C, "C");

		await insertMember(A, MEMBER, "2026-01-01T00:00:00.000Z");
		await insertMember(B, MEMBER, "2026-02-01T00:00:00.000Z");
		await insertMember(C, MEMBER, "2026-03-01T00:00:00.000Z");

		await database.db.insert(database.tables.actorSettings).values({
			did: MEMBER,
			notificationLevel: "all",
			communityOrder: [C, A],
			gifFavorites: [],
		});

		const result = await handleListCommunities(ctx, communities, MEMBER);
		expect(result.communities.map((view) => view.did)).toEqual([C, A, B]);
	});
});

describe("the handle on a community view", () => {
	it("comes from the DID document, since no record carries it", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
		didDocumentHandles.set(COMMUNITY, "nerds.spaces.example");

		const result = await handleGetCommunity(ctx, communities, COMMUNITY, OUTSIDER);
		expect(result.community.handle).toBe("nerds.spaces.example");
	});

	it("falls back to handle.invalid when the DID does not resolve", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");

		const result = await handleGetCommunity(ctx, communities, COMMUNITY, OUTSIDER);
		expect(result.community.handle).toBe("handle.invalid");
	});

	it("keeps listCommunities valid against its own lexicon output", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
		await insertMember(COMMUNITY, MEMBER, "2026-01-01T00:00:00.000Z");
		didDocumentHandles.set(COMMUNITY, "nerds.spaces.example");

		asListCommunitiesOutput(await handleListCommunities(ctx, communities, MEMBER));
	});

	it("keeps listCommunities valid when no handle resolves", async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
		await insertMember(COMMUNITY, MEMBER, "2026-01-01T00:00:00.000Z");

		asListCommunitiesOutput(await handleListCommunities(ctx, communities, MEMBER));
	});
});

describe("listMembers", () => {
	const walk = async (limit: number, role?: string) => {
		const seen: string[] = [];
		let cursor: string | undefined;

		for (let page = 0; page < 20; page++) {
			const result = await communities.members(COMMUNITY, {
				limit,
				cursor,
				...(role ? { role } : {}),
			});
			seen.push(...result.members.map((member) => member.actor.did));
			if (!result.cursor) return { seen, ranOut: false };
			cursor = result.cursor;
		}

		return { seen, ranOut: true };
	};

	beforeEach(async () => {
		await insertCommunity(COMMUNITY, "Protocol Nerds");
	});

	it("walks every member exactly once across pages", async () => {
		const dids = Array.from({ length: 7 }, (_, i) => memberDid(i));
		for (const did of dids) await insertMember(COMMUNITY, did, NOW);

		const { seen, ranOut } = await walk(2);

		expect(ranOut).toBe(false);
		expect(seen).toEqual(dids);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("advances the cursor instead of repeating the first page", async () => {
		for (let i = 0; i < 5; i++) await insertMember(COMMUNITY, memberDid(i), NOW);

		const first = await communities.members(COMMUNITY, { limit: 2 });
		const second = await communities.members(COMMUNITY, {
			limit: 2,
			cursor: first.cursor as string,
		});

		expect(first.cursor).toBe(memberDid(1));
		expect(second.members.map((member) => member.actor.did)).toEqual([memberDid(2), memberDid(3)]);
	});

	it("stops with a null cursor once the last member fits in the page", async () => {
		await insertMember(COMMUNITY, memberDid(0), NOW);
		await insertMember(COMMUNITY, memberDid(1), NOW);

		const result = await communities.members(COMMUNITY, { limit: 50 });

		expect(result.members).toHaveLength(2);
		expect(result.cursor).toBeNull();
	});

	it("returns only members holding the requested role", async () => {
		await insertMember(COMMUNITY, memberDid(0), NOW, ["mods"]);
		await insertMember(COMMUNITY, memberDid(1), NOW, []);
		await insertMember(COMMUNITY, memberDid(2), NOW, ["mods", "vips"]);

		const result = await communities.members(COMMUNITY, { limit: 50, role: "mods" });

		expect(result.members.map((member) => member.actor.did)).toEqual([memberDid(0), memberDid(2)]);
		expect(result.cursor).toBeNull();
	});

	it("paginates a role-filtered listing without dropping matches", async () => {
		for (let i = 0; i < 9; i++) {
			await insertMember(COMMUNITY, memberDid(i), NOW, i % 3 === 0 ? ["mods"] : []);
		}

		const { seen, ranOut } = await walk(1, "mods");

		expect(ranOut).toBe(false);
		expect(seen).toEqual([memberDid(0), memberDid(3), memberDid(6)]);
	});

	it("reports an empty page with no cursor when nobody holds the role", async () => {
		await insertMember(COMMUNITY, memberDid(0), NOW, ["mods"]);

		const result = await communities.members(COMMUNITY, { limit: 50, role: "ghosts" });

		expect(result.members).toEqual([]);
		expect(result.cursor).toBeNull();
	});
});
