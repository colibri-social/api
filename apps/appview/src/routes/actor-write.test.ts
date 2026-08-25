import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { preferencesSpace } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import {
	handleDeleteAccount,
	handleGrantSpaceAccess,
	handlePutMutes,
	handlePutSettings,
} from "./actor-write.js";

const NOW = "2026-08-23T00:00:00.000Z";

const CALLER = "did:plc:callerxxxxxxxxxxxxxxxxxxxxxx";
const OTHER = "did:plc:otherxxxxxxxxxxxxxxxxxxxxxxx";
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const CHANNEL = `at://${COMMUNITY}/space/social.colibri.beta.channel.text/3lkchannel001` as const;
const MUTED_ACTOR = "social.colibri.beta.actor.defs#mutedActor" as const;
const MUTED_CHANNEL = "social.colibri.beta.actor.defs#mutedChannel" as const;

let database: TestDatabase;
let ctx: AppContext;

beforeEach(async () => {
	database = await openTestDatabase();

	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	ctx = {
		announce: silentAnnouncer,
		config: { PUBLIC_URL: "https://appview.test", pushProviders: [] },
		database,
		log: { warn: () => undefined, debug: () => undefined },
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

const GIF = {
	id: "https://cdn.test/from-a-chat-message.gif",
	url: "https://cdn.test/from-a-chat-message.gif",
	previewUrl: "https://cdn.test/from-a-chat-message-small.gif",
	width: 320,
	height: 240,
	title: "a cat",
} as const;

describe("putSettings", () => {
	it("stores a favourited GIF whole, so it renders without a provider lookup", async () => {
		const result = await handlePutSettings(ctx, CALLER, { gifFavorites: [{ ...GIF }] });

		expect(result.preferences.gifFavorites).toEqual([GIF]);

		const [row] = await database.db
			.select()
			.from(database.tables.actorSettings)
			.where(eq(database.tables.actorSettings.did, CALLER));
		expect(row?.gifFavorites).toEqual([GIF]);
	});

	it("keeps the record's $type out of the stored favourite", async () => {
		await handlePutSettings(ctx, CALLER, {
			gifFavorites: [{ ...GIF, $type: "social.colibri.beta.embed.defs#gifView" as const }],
		});

		const [row] = await database.db
			.select()
			.from(database.tables.actorSettings)
			.where(eq(database.tables.actorSettings.did, CALLER));
		expect(row?.gifFavorites?.[0]).not.toHaveProperty("$type");
	});

	it("leaves the favourites alone when the field is absent", async () => {
		await handlePutSettings(ctx, CALLER, { gifFavorites: [{ ...GIF }] });
		const result = await handlePutSettings(ctx, CALLER, {
			notificationLevel: "mentionsAndReplies",
		});

		expect(result.preferences.notificationLevel).toBe("mentionsAndReplies");
		expect(result.preferences.gifFavorites).toEqual([GIF]);
	});

	it("does not share what someone is listening to until they ask for it", async () => {
		const result = await handlePutSettings(ctx, CALLER, {});
		expect(result.preferences.shareActivity).toBe(false);
	});

	it("records that the caller wants their listening shared", async () => {
		const result = await handlePutSettings(ctx, CALLER, { shareActivity: true });

		expect(result.preferences.shareActivity).toBe(true);

		const [row] = await database.db
			.select()
			.from(database.tables.actorSettings)
			.where(eq(database.tables.actorSettings.did, CALLER));
		expect(row?.shareActivity).toBe(true);
	});

	it("leaves sharing alone when the field is absent", async () => {
		await handlePutSettings(ctx, CALLER, { shareActivity: true });
		const result = await handlePutSettings(ctx, CALLER, {
			notificationLevel: "mentionsAndReplies",
		});

		expect(result.preferences.shareActivity).toBe(true);
	});

	it("drops a stored activity when the caller stops sharing", async () => {
		await handlePutSettings(ctx, CALLER, { shareActivity: true });
		await database.db.insert(database.tables.actorActivity).values({
			did: CALLER,
			kind: "listening",
			title: "Sick Like You",
			source: "teal.fm",
			updatedAt: NOW,
		});

		await handlePutSettings(ctx, CALLER, { shareActivity: false });

		const rows = await database.db
			.select()
			.from(database.tables.actorActivity)
			.where(eq(database.tables.actorActivity.did, CALLER));
		expect(rows).toEqual([]);
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

		const result = await handlePutMutes(ctx, CALLER, [
			{ subject: { $type: MUTED_ACTOR, did: COMMUNITY }, createdAt: NOW },
		]);

		expect(result.preferences.mutes).toHaveLength(1);
		expect(result.preferences.mutes[0]?.subject).toEqual({ $type: MUTED_ACTOR, did: COMMUNITY });

		const allRows = await database.db.select().from(database.tables.mutes);
		expect(allRows.filter((row) => row.did === OTHER)).toHaveLength(1);
		expect(allRows.filter((row) => row.did === CALLER)).toHaveLength(1);
	});

	it("stores a channel mute as its space reference and reads it back as one", async () => {
		const result = await handlePutMutes(ctx, CALLER, [
			{ subject: { $type: MUTED_CHANNEL, channel: CHANNEL }, createdAt: NOW },
			{ subject: { $type: MUTED_ACTOR, did: COMMUNITY }, createdAt: NOW },
		]);

		expect(result.preferences.mutes.map((mute) => mute.subject)).toEqual([
			{ $type: MUTED_CHANNEL, channel: CHANNEL },
			{ $type: MUTED_ACTOR, did: COMMUNITY },
		]);

		const rows = await database.db.select().from(database.tables.mutes);
		expect(rows.map((row) => row.subject).sort()).toEqual([CHANNEL, COMMUNITY].sort());
	});

	it("keeps the rkey a repo sync already recorded for a subject", async () => {
		await database.db.insert(database.tables.mutes).values({
			did: CALLER,
			rkey: "3lkfromrepo01",
			subject: COMMUNITY,
			createdAt: NOW,
		});

		await handlePutMutes(ctx, CALLER, [
			{ subject: { $type: MUTED_ACTOR, did: COMMUNITY }, createdAt: NOW },
			{ subject: { $type: MUTED_CHANNEL, channel: CHANNEL }, createdAt: NOW },
		]);

		const rows = await database.db
			.select()
			.from(database.tables.mutes)
			.where(eq(database.tables.mutes.did, CALLER));
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.subject === COMMUNITY)?.rkey).toBe("3lkfromrepo01");
	});

	it("drops subjects the caller no longer mutes", async () => {
		await handlePutMutes(ctx, CALLER, [
			{ subject: { $type: MUTED_ACTOR, did: COMMUNITY }, createdAt: NOW },
			{ subject: { $type: MUTED_CHANNEL, channel: CHANNEL }, createdAt: NOW },
		]);

		const result = await handlePutMutes(ctx, CALLER, [
			{ subject: { $type: MUTED_CHANNEL, channel: CHANNEL }, createdAt: NOW },
		]);

		expect(result.preferences.mutes.map((mute) => mute.subject)).toEqual([
			{ $type: MUTED_CHANNEL, channel: CHANNEL },
		]);

		const rows = await database.db
			.select()
			.from(database.tables.mutes)
			.where(eq(database.tables.mutes.did, CALLER));
		expect(rows.map((row) => row.subject)).toEqual([CHANNEL]);
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
