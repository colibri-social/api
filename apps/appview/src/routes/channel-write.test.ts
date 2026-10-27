import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader, type CommunityWriter, type RecordWrite } from "@colibri-social/community";
import { COLLECTIONS, channelSpace, communitySpaces, SPACE_TYPES } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import { healCategoryOrders } from "../category-order.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import {
	handleDeleteChannel,
	handleReorderChannels,
	handleUpdateChannel,
} from "./channel-write.js";

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
		log: { info: () => undefined, warn: () => undefined },
		writer: fakeWriter(),
		credentials: { connect: async () => ({}) },
		provisioner: { deleteChannel: async () => undefined },
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
		permissions: ["channel.update", "channel.delete"],
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

const CATEGORY = "3lkcategory0000";
const OTHER_CATEGORY = "3lkcategory0001";

const addChannel = async (
	skey: string,
	options: {
		category?: string | null;
		visibleToRoles?: string[];
		projected?: boolean;
		registered?: boolean;
	} = {},
) => {
	const space = channelSpace(COMMUNITY, SPACE_TYPES.channelText, skey);
	if (options.projected !== false) {
		await database.db.insert(database.tables.channels).values({
			space,
			community: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey,
			name: skey,
			category: options.category === undefined ? CATEGORY : options.category,
			visibleToRoles: options.visibleToRoles ?? [],
		});
	}
	if (options.registered !== false) {
		await database.db.insert(database.tables.spaces).values({
			uri: space,
			authority: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey,
			community: COMMUNITY,
			host: "https://pds.test",
			createdAt: NOW,
		});
	}
};

const addCategory = (rkey: string, channelOrder: string[]) =>
	database.db.insert(database.tables.categories).values({
		community: COMMUNITY,
		rkey,
		name: rkey,
		channelOrder,
	});

const categoryOrders = (rkey: string) =>
	writes
		.filter((write) => write.collection === COLLECTIONS.category && write.rkey === rkey)
		.map((write) => (write.record as { channelOrder: string[] }).channelOrder);

const reorder = (channels: string[]) =>
	handleReorderChannels(ctx, fakeWriter(), communities, COMMUNITY, ADMIN, CATEGORY, channels);

describe("reordering a category's channels", () => {
	beforeEach(async () => {
		await database.db
			.update(database.tables.channels)
			.set({ category: CATEGORY })
			.where(eq(database.tables.channels.space, SPACE));
		await database.db.insert(database.tables.spaces).values({
			uri: SPACE,
			authority: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey: CHANNEL_SKEY,
			community: COMMUNITY,
			host: "https://pds.test",
			createdAt: NOW,
		});
		await addChannel("3lkchannelaaaa0");
		await addChannel("3lkchannelbbbb0");
	});

	it("repairs an order that still lists a deleted channel", async () => {
		await addCategory(CATEGORY, [
			CHANNEL_SKEY,
			"3lkdeletedxxxx0",
			"3lkchannelaaaa0",
			"3lkchannelbbbb0",
		]);

		await reorder(["3lkchannelbbbb0", CHANNEL_SKEY, "3lkchannelaaaa0"]);

		expect(categoryOrders(CATEGORY)).toEqual([
			[CHANNEL_SKEY, "3lkchannelaaaa0", "3lkchannelbbbb0"],
			["3lkchannelbbbb0", CHANNEL_SKEY, "3lkchannelaaaa0"],
		]);
	});

	it("appends a channel of the category the order is missing and drops duplicates", async () => {
		await addCategory(CATEGORY, [CHANNEL_SKEY, "3lkchannelaaaa0", CHANNEL_SKEY]);

		await reorder(["3lkchannelaaaa0", "3lkchannelbbbb0", CHANNEL_SKEY]);

		expect(categoryOrders(CATEGORY)).toEqual([
			[CHANNEL_SKEY, "3lkchannelaaaa0", "3lkchannelbbbb0"],
			["3lkchannelaaaa0", "3lkchannelbbbb0", CHANNEL_SKEY],
		]);
	});

	it("drops a channel another category owns", async () => {
		await addChannel("3lkchannelcccc0", { category: OTHER_CATEGORY });
		await addCategory(CATEGORY, [
			CHANNEL_SKEY,
			"3lkchannelcccc0",
			"3lkchannelaaaa0",
			"3lkchannelbbbb0",
		]);

		await reorder(["3lkchannelaaaa0", CHANNEL_SKEY, "3lkchannelbbbb0"]);

		expect(categoryOrders(CATEGORY).at(-1)).toEqual([
			"3lkchannelaaaa0",
			CHANNEL_SKEY,
			"3lkchannelbbbb0",
		]);
	});

	it("keeps hidden and not yet projected channels in their slots", async () => {
		await addChannel("3lkhiddenxxxxx0", { visibleToRoles: ["mods"] });
		await addChannel("3lkpendingxxxx0", { projected: false });
		await addCategory(CATEGORY, [
			"3lkhiddenxxxxx0",
			CHANNEL_SKEY,
			"3lkpendingxxxx0",
			"3lkchannelaaaa0",
			"3lkchannelbbbb0",
		]);

		await reorder(["3lkchannelbbbb0", "3lkchannelaaaa0", CHANNEL_SKEY]);

		expect(categoryOrders(CATEGORY)).toEqual([
			["3lkhiddenxxxxx0", "3lkchannelbbbb0", "3lkpendingxxxx0", "3lkchannelaaaa0", CHANNEL_SKEY],
		]);
	});

	it("accepts the full set of channels", async () => {
		await addChannel("3lkhiddenxxxxx0", { visibleToRoles: ["mods"] });
		await addCategory(CATEGORY, [
			CHANNEL_SKEY,
			"3lkhiddenxxxxx0",
			"3lkchannelaaaa0",
			"3lkchannelbbbb0",
		]);

		await reorder(["3lkhiddenxxxxx0", "3lkchannelbbbb0", "3lkchannelaaaa0", CHANNEL_SKEY]);

		expect(categoryOrders(CATEGORY).at(-1)).toEqual([
			"3lkhiddenxxxxx0",
			"3lkchannelbbbb0",
			"3lkchannelaaaa0",
			CHANNEL_SKEY,
		]);
	});

	it("rejects a request that is not a permutation of the visible channels", async () => {
		await addCategory(CATEGORY, [CHANNEL_SKEY, "3lkchannelaaaa0", "3lkchannelbbbb0"]);

		await expect(reorder([CHANNEL_SKEY, "3lkchannelaaaa0"])).rejects.toThrow(
			"the given channels do not match",
		);
		await expect(reorder([CHANNEL_SKEY, "3lkchannelaaaa0", "3lkchannelaaaa0"])).rejects.toThrow(
			"the given channels do not match",
		);
		await expect(
			reorder([CHANNEL_SKEY, "3lkchannelaaaa0", "3lkchannelbbbb0", "3lkunknownxxxx0"]),
		).rejects.toThrow("the given channels do not match");
	});

	it("removes a deleted channel from its category", async () => {
		await addCategory(CATEGORY, [CHANNEL_SKEY, "3lkchannelaaaa0", "3lkchannelbbbb0"]);
		await database.db.delete(database.tables.spaces).where(eq(database.tables.spaces.uri, SPACE));

		await handleDeleteChannel(ctx, fakeWriter(), ADMIN, SPACE);

		expect(categoryOrders(CATEGORY)).toEqual([["3lkchannelaaaa0", "3lkchannelbbbb0"]]);
	});

	it("repairs every broken category at startup and leaves sound ones alone", async () => {
		await addChannel("3lkchannelcccc0", { category: OTHER_CATEGORY });
		await addCategory(CATEGORY, [
			CHANNEL_SKEY,
			"3lkgonexxxxxxx0",
			"3lkchannelaaaa0",
			"3lkchannelbbbb0",
		]);
		await addCategory(OTHER_CATEGORY, ["3lkchannelcccc0"]);

		const repaired = await healCategoryOrders(ctx);

		expect(repaired).toBe(1);
		expect(categoryOrders(CATEGORY)).toEqual([
			[CHANNEL_SKEY, "3lkchannelaaaa0", "3lkchannelbbbb0"],
		]);
		expect(categoryOrders(OTHER_CATEGORY)).toEqual([]);
	});
});
