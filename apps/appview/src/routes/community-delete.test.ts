import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityCredentialError, CommunityLoader } from "@colibri-social/community";
import { channelSpace, communitySpaces, SPACE_TYPES } from "@colibri-social/lexicons";
import type { AuthzChange } from "@colibri-social/projections";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Announcer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import { handleListCommunities } from "./actor.js";
import { handleGetCommunity } from "./community.js";
import { handleDeleteCommunity } from "./community-write.js";

const NOW = "2026-08-23T00:00:00.000Z";
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const OWNER = "did:plc:ownerxxxxxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxx";
const HOST = "https://pds.test";
const OWNER_ROLE = "3lkowner000000";

const CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel001");

let database: TestDatabase;
let ctx: AppContext;
let announced: Array<{ kind: string; community: string }>;
let authzChanges: AuthzChange[];
let destroyed: Array<{ community: string; spaces: readonly string[] }>;
let destroy: (community: string, spaces: readonly string[]) => Promise<void>;
let connect: (community: string) => Promise<unknown>;

const views = () => new CommunityViews(ctx, new ActorViews(ctx));

const call = (caller: string) => handleDeleteCommunity(ctx, caller, COMMUNITY);

const seed = async () => {
	const { db, tables } = database;
	const spaces = communitySpaces(COMMUNITY);

	await db.insert(tables.communities).values({
		did: COMMUNITY,
		handle: null,
		name: "Doomed",
		description: null,
		managingApp: null,
		pictureCid: null,
		bannerCid: null,
		labelers: [],
		migratedFrom: null,
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW,
	});

	await db.insert(tables.roles).values({
		community: COMMUNITY,
		rkey: OWNER_ROLE,
		name: "Owner",
		protected: true,
		permissions: ["community.delete"],
	});

	await db.insert(tables.members).values([
		{ community: COMMUNITY, did: OWNER, roles: [OWNER_ROLE], joinedAt: NOW, nickname: null },
		{ community: COMMUNITY, did: MEMBER, roles: [], joinedAt: NOW, nickname: null },
	]);

	await db.insert(tables.channels).values({
		space: CHANNEL,
		community: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey: "3lkchannel001",
		name: "general",
	});

	for (const uri of [...Object.values(spaces), CHANNEL]) {
		await db.insert(tables.spaces).values({
			uri,
			authority: COMMUNITY,
			spaceType: SPACE_TYPES.communityProfile,
			skey: "self",
			community: COMMUNITY,
			host: HOST,
			createdAt: NOW,
		});
	}
};

const rowsLeft = async () => {
	const { db, tables } = database;
	return {
		communities: (await db.select().from(tables.communities)).length,
		members: (await db.select().from(tables.members)).length,
		channels: (await db.select().from(tables.channels)).length,
		spaces: (await db.select().from(tables.spaces)).length,
	};
};

beforeEach(async () => {
	database = await openTestDatabase();
	announced = [];
	authzChanges = [];
	destroyed = [];
	destroy = async (community, spaces) => {
		destroyed.push({ community, spaces });
	};
	connect = async () => ({ pds: { service: HOST }, session: {} });

	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	const announcer: Announcer = {
		toCommunity: () => {},
		toCommunityPermission: async () => {},
		toCommunityViewers: async () => {},
		toChannel: () => {},
		toUser: () => {},
		channelChanged: () => {},
		threadDeleted: () => {},
		communityDeleted: (community) => announced.push({ kind: "communityDeleted", community }),
	};

	ctx = {
		announce: announcer,
		authzChanges: { publish: (change: AuthzChange) => authzChanges.push(change) },
		config: { PUBLIC_URL: "https://appview.test", APPVIEW_DID: "did:web:appview.test" },
		database,
		loader,
		credentials: { connect: (community: string) => connect(community) },
		provisioner: {
			destroy: (community: string, _host: unknown, spaces: readonly string[]) =>
				destroy(community, spaces),
		},
		identity: {
			resolveAtIdentifier: async () => {
				throw new Error("no identity in tests");
			},
		},
	} as unknown as AppContext;

	await seed();
});

afterEach(async () => {
	await database.destroy();
});

describe("community.delete", () => {
	it("purges the community and tells everyone it is gone", async () => {
		await call(OWNER);

		expect(destroyed).toHaveLength(1);
		expect(destroyed[0]?.spaces).toEqual(
			[...Object.values(communitySpaces(COMMUNITY)), CHANNEL].sort(),
		);
		expect(announced).toEqual([{ kind: "communityDeleted", community: COMMUNITY }]);
		expect(authzChanges).toHaveLength(1);
		expect(authzChanges[0]?.community).toBe(COMMUNITY);
		expect(await rowsLeft()).toEqual({
			communities: 0,
			members: 0,
			channels: 0,
			spaces: 0,
		});
	});

	it("stops serving the community the moment it is deleted", async () => {
		await call(OWNER);

		await expect(handleGetCommunity(ctx, views(), COMMUNITY, OWNER)).rejects.toMatchObject({
			customErrorName: "CommunityNotFound",
		});
		await expect(handleListCommunities(ctx, views(), OWNER)).resolves.toEqual({ communities: [] });
	});

	it("publishes nothing and keeps every row when the PDS delete fails", async () => {
		destroy = async () => {
			throw new Error("pds is on fire");
		};

		await expect(call(OWNER)).rejects.toThrow("pds is on fire");

		expect(announced).toEqual([]);
		expect(authzChanges).toEqual([]);
		expect(await rowsLeft()).toEqual({
			communities: 1,
			members: 2,
			channels: 1,
			spaces: 5,
		});
	});

	it("reports unusable credentials without touching a row", async () => {
		connect = async () => {
			throw new CommunityCredentialError(COMMUNITY, "notProvisioned", "no credentials on file");
		};

		await expect(call(OWNER)).rejects.toMatchObject({
			customErrorName: "CredentialsUnavailable",
		});

		expect(destroyed).toEqual([]);
		expect(announced).toEqual([]);
		expect(await rowsLeft()).toMatchObject({ communities: 1, members: 2 });
	});

	it("refuses a member who cannot delete the community", async () => {
		await expect(call(MEMBER)).rejects.toMatchObject({ customErrorName: "Forbidden" });

		expect(destroyed).toEqual([]);
		expect(announced).toEqual([]);
		expect(await rowsLeft()).toMatchObject({ communities: 1, members: 2 });
	});

	it("reports a community that is already gone", async () => {
		await call(OWNER);

		await expect(call(OWNER)).rejects.toMatchObject({
			customErrorName: "CommunityNotFound",
		});
	});
});
