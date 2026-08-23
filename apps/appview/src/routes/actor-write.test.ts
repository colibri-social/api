import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { preferencesSpace } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { handleDeleteAccount, handleGrantSpaceAccess, handlePutMutes } from "./actor-write.js";

const NOW = "2026-08-23T00:00:00.000Z";

const CALLER = "did:plc:callerxxxxxxxxxxxxxxxxxxxxxx";
const OTHER = "did:plc:otherxxxxxxxxxxxxxxxxxxxxxxx";
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";

let database: TestDatabase;
let ctx: AppContext;

beforeEach(async () => {
	database = await openTestDatabase();

	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	ctx = {
		config: { PUBLIC_URL: "https://appview.test", pushProviders: [] },
		database,
		loader,
		hosts: { hostFor: async () => "https://pds.test" },
		sync: { notifyWrite: () => undefined },
		spaceCredentials: {
			acquireWith: async () => {
				throw new Error("acquireWith should not be called for an unauthorized space");
			},
		},
	} as unknown as AppContext;
});

afterEach(async () => {
	await database.destroy();
});

describe("grantSpaceAccess", () => {
	it("refuses a space whose authority is not the caller", async () => {
		const otherSpace = preferencesSpace(OTHER);

		await expect(
			handleGrantSpaceAccess(ctx, CALLER, { space: otherSpace, delegationToken: "token" }),
		).rejects.toMatchObject({ customErrorName: "NotAuthorized" });
	});
});

describe("putMutes", () => {
	it("writes only the caller's rows", async () => {
		await database.db.insert(database.tables.mutes).values({
			did: OTHER,
			rkey: "3lkother00001",
			subject: COMMUNITY,
			createdAt: NOW,
		});

		const result = await handlePutMutes(ctx, CALLER, [{ subject: COMMUNITY, createdAt: NOW }]);

		expect(result.preferences.mutes).toHaveLength(1);
		expect(result.preferences.mutes[0]?.subject).toBe(COMMUNITY);

		const allRows = await database.db.select().from(database.tables.mutes);
		expect(allRows.filter((row) => row.did === OTHER)).toHaveLength(1);
		expect(allRows.filter((row) => row.did === CALLER)).toHaveLength(1);
	});
});

describe("deleteAccount", () => {
	it("refuses a sole owner of a protected role", async () => {
		await database.db.insert(database.tables.roles).values({
			community: COMMUNITY,
			rkey: "3lkowner00001",
			name: "Owner",
			color: null,
			permissions: [],
			position: 0,
			hoisted: false,
			mentionable: false,
			protected: true,
			channelOverrides: [],
		});

		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: CALLER,
			roles: ["3lkowner00001"],
			joinedAt: NOW,
			nickname: null,
		});

		await expect(handleDeleteAccount(ctx, CALLER)).rejects.toMatchObject({
			customErrorName: "SoleOwnerOfCommunity",
		});
	});

	it("removes the caller's own rows when not a sole owner", async () => {
		await database.db.insert(database.tables.mutes).values({
			did: CALLER,
			rkey: "3lkcaller00001",
			subject: OTHER,
			createdAt: NOW,
		});
		await database.db.insert(database.tables.actorSettings).values({
			did: CALLER,
			notificationLevel: "all",
			communityOrder: [],
			gifFavorites: [],
		});

		const result = await handleDeleteAccount(ctx, CALLER);

		expect(result.deleted).toBeGreaterThanOrEqual(2);

		const remainingMutes = await database.db
			.select()
			.from(database.tables.mutes)
			.where(eq(database.tables.mutes.did, CALLER));
		expect(remainingMutes).toHaveLength(0);
	});
});
