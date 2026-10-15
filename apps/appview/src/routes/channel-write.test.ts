import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader, type CommunityWriter, type RecordWrite } from "@colibri-social/community";
import { COLLECTIONS, channelSpace, communitySpaces, SPACE_TYPES } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import { handleUpdateChannel } from "./channel-write.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const ADMIN = "did:plc:admin";
const NOW = "2026-08-23T00:00:00.000Z";
const CHANNEL_SKEY = "3lkchanneltest0";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, CHANNEL_SKEY);

let database: TestDatabase;
let ctx: AppContext;
let communities: CommunityViews;
let writes: RecordWrite[];

const fakeWriter = (): CommunityWriter =>
	({
		spaces: (community: string) => communitySpaces(community),
		put: async (community: string, write: RecordWrite) => {
			writes.push(write);
			return { uri: `at://${community}/${write.collection}/${write.rkey}`, rkey: write.rkey };
		},
	}) as unknown as CommunityWriter;

const channelRecords = () =>
	writes
		.filter((write) => write.collection === COLLECTIONS.channel)
		.map((write) => write.record as { linkEmbeds?: boolean });

const setStoredLinkEmbeds = (linkEmbeds: boolean | null) =>
	database.db
		.update(database.tables.channels)
		.set({ linkEmbeds })
		.where(eq(database.tables.channels.space, SPACE));

const update = (input: Parameters<typeof handleUpdateChannel>[5]) =>
	handleUpdateChannel(ctx, fakeWriter(), communities, ADMIN, SPACE, input);

beforeEach(async () => {
	database = await openTestDatabase();
	writes = [];
	ctx = {
		announce: silentAnnouncer,
		config: { PUBLIC_URL: "https://appview.test", SIGNING_KEY: "abcdef0123456789" },
		database,
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
	} as unknown as AppContext;
	communities = new CommunityViews(ctx, new ActorViews(ctx));

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
	await database.db.insert(database.tables.roles).values({
		community: COMMUNITY,
		rkey: "admin",
		name: "admin",
		color: null,
		permissions: ["channel.update"],
		position: 100,
		hoisted: false,
		mentionable: false,
		protected: false,
		channelOverrides: [],
	});
	await database.db.insert(database.tables.members).values({
		community: COMMUNITY,
		did: ADMIN,
		roles: ["admin"],
		joinedAt: NOW,
		nickname: null,
	});
	await database.db.insert(database.tables.channels).values({
		space: SPACE,
		community: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey: CHANNEL_SKEY,
		name: "general",
	});
});

afterEach(async () => {
	await database.destroy();
});

describe("updating a channel's link previews", () => {
	it("keeps the stored setting when an update leaves it out", async () => {
		await setStoredLinkEmbeds(false);

		const { channel } = await update({ name: "general" });

		expect(channelRecords().at(-1)?.linkEmbeds).toBe(false);
		expect(channel.linkEmbeds).toBe(false);
	});

	it("clears the stored setting with removeLinkEmbeds", async () => {
		await setStoredLinkEmbeds(false);

		const { channel } = await update({ removeLinkEmbeds: true });

		expect(channelRecords().at(-1)).not.toHaveProperty("linkEmbeds");
		expect(channel.linkEmbeds).toBeUndefined();
	});

	it("uses a given linkEmbeds over removeLinkEmbeds", async () => {
		await setStoredLinkEmbeds(false);

		const { channel } = await update({ linkEmbeds: true, removeLinkEmbeds: true });

		expect(channelRecords().at(-1)?.linkEmbeds).toBe(true);
		expect(channel.linkEmbeds).toBe(true);
	});
});
