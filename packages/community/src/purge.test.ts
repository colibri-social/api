import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { channelSpace, communitySpaces, SPACE_TYPES } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { communitySpaceUris, purgeCommunity } from "./purge.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const OTHER = "did:plc:otherxxxxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxx";
const HOST = "https://pds.test";
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;

const textChannel = (community: string) =>
	channelSpace(community, SPACE_TYPES.channelText, "3lkchannel001");

const seed = async (community: string) => {
	const { db, tables } = database;
	const spaces = communitySpaces(community);
	const channel = textChannel(community);

	await db.insert(tables.communities).values({
		did: community,
		handle: null,
		name: "Seeded",
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

	await db
		.insert(tables.members)
		.values({ community, did: MEMBER, roles: [], joinedAt: NOW, nickname: null });

	await db.insert(tables.roles).values({ community, rkey: "role1", name: "Role" });

	await db.insert(tables.categories).values({ community, rkey: "cat1", name: "Category" });

	await db.insert(tables.channels).values({
		space: channel,
		community,
		spaceType: SPACE_TYPES.channelText,
		skey: "3lkchannel001",
		name: "general",
	});

	await db.insert(tables.invitations).values({
		code: `invite-${community}`,
		community,
		createdBy: MEMBER,
		createdAt: NOW,
	});

	await db.insert(tables.applications).values({ community, did: MEMBER, createdAt: NOW });

	await db.insert(tables.moderationLog).values({
		community,
		rkey: "mod1",
		action: "ban",
		subject: MEMBER,
		createdBy: MEMBER,
		createdAt: NOW,
	});

	await db.insert(tables.readCursors).values({
		did: MEMBER,
		community,
		channel,
		cursor: "3lkmessage001",
	});

	await db.insert(tables.notifications).values({
		id: `notif-${community}`,
		recipient: MEMBER,
		kind: "mention",
		community,
		space: channel,
		author: MEMBER,
		messageAuthor: MEMBER,
		messageRkey: "3lkmessage001",
		indexedAt: NOW,
	});

	await db.insert(tables.messages).values({
		space: channel,
		author: MEMBER,
		rkey: "3lkmessage001",
		community,
		text: "hello",
		createdAt: NOW,
		indexedAt: NOW,
	});

	await db.insert(tables.reactions).values({
		space: channel,
		author: MEMBER,
		rkey: "3lkreaction001",
		targetAuthor: MEMBER,
		targetRkey: "3lkmessage001",
		emoji: "👍",
	});

	await db.insert(tables.labels).values({
		space: channel,
		src: MEMBER,
		rkey: "3lklabel001",
		subjectDid: MEMBER,
		subjectCollection: "social.colibri.beta.message",
		subjectRkey: "3lkmessage001",
		val: "spam",
		createdAt: NOW,
	});

	for (const uri of [...Object.values(spaces), channel]) {
		await db.insert(tables.spaces).values({
			uri,
			authority: community,
			spaceType: SPACE_TYPES.communityProfile,
			skey: "self",
			community,
			host: HOST,
			createdAt: NOW,
		});

		await db.insert(tables.records).values({
			space: uri,
			author: community,
			collection: "social.colibri.beta.community.profile",
			rkey: "self",
			cid: "bafycid",
			value: {},
			indexedAt: NOW,
		});

		await db.insert(tables.spaceRepos).values({ space: uri, author: community });

		await db.insert(tables.spaceCredentials).values({
			space: uri,
			credential: "token",
			boundKeyThumbprint: "thumb",
			boundPrivateJwk: "{}",
			expiresAt: NOW,
		});

		await db
			.insert(tables.notifyRegistrations)
			.values({ space: uri, service: HOST, expiresAt: NOW });
	}
};

const countsFor = async (community: string) => {
	const { db, tables } = database;
	const spaces = [...Object.values(communitySpaces(community)), textChannel(community)];
	const all = {
		communities: await db.select().from(tables.communities),
		members: await db.select().from(tables.members),
		roles: await db.select().from(tables.roles),
		categories: await db.select().from(tables.categories),
		channels: await db.select().from(tables.channels),
		invitations: await db.select().from(tables.invitations),
		applications: await db.select().from(tables.applications),
		moderationLog: await db.select().from(tables.moderationLog),
		readCursors: await db.select().from(tables.readCursors),
		notifications: await db.select().from(tables.notifications),
		messages: await db.select().from(tables.messages),
		reactions: await db.select().from(tables.reactions),
		labels: await db.select().from(tables.labels),
		spaces: await db.select().from(tables.spaces),
		records: await db.select().from(tables.records),
		spaceRepos: await db.select().from(tables.spaceRepos),
		spaceCredentials: await db.select().from(tables.spaceCredentials),
		notifyRegistrations: await db.select().from(tables.notifyRegistrations),
	};

	return {
		communities: all.communities.filter((r) => r.did === community).length,
		members: all.members.filter((r) => r.community === community).length,
		roles: all.roles.filter((r) => r.community === community).length,
		categories: all.categories.filter((r) => r.community === community).length,
		channels: all.channels.filter((r) => r.community === community).length,
		invitations: all.invitations.filter((r) => r.community === community).length,
		applications: all.applications.filter((r) => r.community === community).length,
		moderationLog: all.moderationLog.filter((r) => r.community === community).length,
		readCursors: all.readCursors.filter((r) => r.community === community).length,
		notifications: all.notifications.filter((r) => r.community === community).length,
		messages: all.messages.filter((r) => r.community === community).length,
		reactions: all.reactions.filter((r) => spaces.includes(r.space)).length,
		labels: all.labels.filter((r) => spaces.includes(r.space)).length,
		spaces: all.spaces.filter((r) => spaces.includes(r.uri)).length,
		records: all.records.filter((r) => spaces.includes(r.space)).length,
		spaceRepos: all.spaceRepos.filter((r) => spaces.includes(r.space)).length,
		spaceCredentials: all.spaceCredentials.filter((r) => spaces.includes(r.space)).length,
		notifyRegistrations: all.notifyRegistrations.filter((r) => spaces.includes(r.space)).length,
	};
};

const empty = {
	communities: 0,
	members: 0,
	roles: 0,
	categories: 0,
	channels: 0,
	invitations: 0,
	applications: 0,
	moderationLog: 0,
	readCursors: 0,
	notifications: 0,
	messages: 0,
	reactions: 0,
	labels: 0,
	spaces: 0,
	records: 0,
	spaceRepos: 0,
	spaceCredentials: 0,
	notifyRegistrations: 0,
};

beforeEach(async () => {
	database = await openTestDatabase();
});

afterEach(async () => {
	await database.destroy();
});

describe("communitySpaceUris", () => {
	it("collects the core spaces, the registered spaces and the projected channels", async () => {
		await seed(COMMUNITY);

		const uris = await communitySpaceUris(database, COMMUNITY);

		expect(uris).toEqual(
			[...Object.values(communitySpaces(COMMUNITY)), textChannel(COMMUNITY)].sort(),
		);
	});

	it("still returns the core spaces once the registry rows are gone", async () => {
		await seed(COMMUNITY);
		await database.db.delete(database.tables.spaces);
		await database.db.delete(database.tables.channels);

		const uris = await communitySpaceUris(database, COMMUNITY);

		expect(uris).toEqual([...Object.values(communitySpaces(COMMUNITY))].sort());
	});

	it("leaves another community's spaces out", async () => {
		await seed(COMMUNITY);
		await seed(OTHER);

		const uris = await communitySpaceUris(database, COMMUNITY);

		expect(uris).not.toContain(textChannel(OTHER));
	});
});

describe("purgeCommunity", () => {
	it("removes every row a deleted community owned", async () => {
		await seed(COMMUNITY);

		const spaces = await communitySpaceUris(database, COMMUNITY);
		await purgeCommunity(database, COMMUNITY, spaces);

		expect(await countsFor(COMMUNITY)).toEqual(empty);
	});

	it("leaves another community's rows alone", async () => {
		await seed(COMMUNITY);
		await seed(OTHER);

		const spaces = await communitySpaceUris(database, COMMUNITY);
		await purgeCommunity(database, COMMUNITY, spaces);

		expect(await countsFor(COMMUNITY)).toEqual(empty);
		expect(await countsFor(OTHER)).toMatchObject({
			communities: 1,
			members: 1,
			channels: 1,
			reactions: 1,
			labels: 1,
			spaces: 5,
		});
	});

	it("purges a community whose spaces were already forgotten", async () => {
		await seed(COMMUNITY);
		await database.db.delete(database.tables.spaces);

		await purgeCommunity(database, COMMUNITY, Object.values(communitySpaces(COMMUNITY)));

		expect(await countsFor(COMMUNITY)).toMatchObject({
			communities: 0,
			members: 0,
			roles: 0,
			channels: 0,
			messages: 0,
		});
	});

	it("purges the community-keyed rows when it has no spaces at all", async () => {
		await seed(COMMUNITY);

		await purgeCommunity(database, COMMUNITY, []);

		expect(await countsFor(COMMUNITY)).toMatchObject({ communities: 0, members: 0, channels: 0 });
	});
});
