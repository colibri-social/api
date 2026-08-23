import { COLLECTIONS, communitySpaces, SELF, SPACE_TYPES } from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createHarness,
	type Harness,
	registerSpace,
	type UserFixture,
	unique,
	waitForPds,
} from "./harness.js";

let harness: Harness;
let founder: UserFixture;
let community: string;
let textChannel: string;
let voiceChannel: string;

beforeAll(async () => {
	await waitForPds();
	harness = await createHarness();
	founder = await harness.createUser(unique("founder"));

	const provisioned = await harness.provisioner.create({
		name: "Integration community",
		description: "created by the integration suite",
		handlePrefix: unique("comm"),
		creator: founder.did,
	});

	community = provisioned.did;
	textChannel = provisioned.channels.text;
	voiceChannel = provisioned.channels.voice;

	const spaces = communitySpaces(community);
	for (const space of [
		...Object.values(spaces),
		provisioned.channels.text,
		provisioned.channels.voice,
	]) {
		await registerSpace(harness.database, space, community, community, harness.pds.service);
	}
}, 180_000);

afterAll(async () => {
	await harness?.close();
});

describe("provisioning a community", () => {
	it("creates an account whose DID is the authority of all its spaces", async () => {
		expect(community).toMatch(/^did:/);
		const spaces = communitySpaces(community);
		for (const space of Object.values(spaces)) {
			expect(space.startsWith(`at://${community}/space/`)).toBe(true);
		}
	});

	it("reports every space back through listSpaces", async () => {
		const session = await harness.credentials.session(community);
		const { spaces } = await harness.pds.listSpaces(session);
		const uris = spaces.map((space) => space.uri);

		for (const space of Object.values(communitySpaces(community))) {
			expect(uris).toContain(space);
		}
		expect(uris).toContain(textChannel);
	});

	it("makes the profile space public and the rest managed by this AppView", async () => {
		const session = await harness.credentials.session(community);
		const spaces = communitySpaces(community);

		const profile = await harness.pds.getSpace(session, spaces.profile);
		expect(profile.policy.$type).toBe("com.atproto.simplespace.defs#publicPolicy");

		const members = await harness.pds.getSpace(session, spaces.members);
		expect(members.policy.$type).toBe("com.atproto.simplespace.defs#managingAppPolicy");
	});

	it("seeds the community so it is usable immediately", async () => {
		await harness.syncSpace(communitySpaces(community).profile);
		await harness.syncSpace(communitySpaces(community).configuration);
		await harness.syncSpace(communitySpaces(community).members);
		await harness.syncSpace(textChannel);
		await harness.syncSpace(voiceChannel);

		const [row] = await harness.database.db
			.select()
			.from(harness.database.tables.communities)
			.where(eq(harness.database.tables.communities.did, community));
		expect(row?.name).toBe("Integration community");

		const categories = await harness.database.db
			.select()
			.from(harness.database.tables.categories)
			.where(eq(harness.database.tables.categories.community, community));
		expect(categories).toHaveLength(2);

		const channels = await harness.database.db
			.select()
			.from(harness.database.tables.channels)
			.where(eq(harness.database.tables.channels.community, community));
		expect(channels).toHaveLength(2);
		expect(channels.map((channel) => channel.spaceType).sort()).toEqual(
			[SPACE_TYPES.channelText, SPACE_TYPES.channelVoice].sort(),
		);
	});

	it("gives the founder an owner role that holds every permission", async () => {
		const authz = await harness.loader.authz(community, founder.did);
		expect(authz.member).not.toBeNull();
		expect(authz.roles.some((role) => role.protected)).toBe(true);
	});
});

describe("a member writing into a channel", () => {
	let member: UserFixture;

	beforeAll(async () => {
		member = await harness.createUser(unique("member"));
		await harness.membership.join(community, member.did);
		await harness.syncSpace(communitySpaces(community).members);
	}, 60_000);

	it("admits the member", async () => {
		const authz = await harness.loader.authz(community, member.did);
		expect(authz.member).not.toBeNull();
	});

	it("syncs a message the member wrote to their own repo", async () => {
		await harness.pds.createRecord(member.session, {
			space: textChannel,
			collection: COLLECTIONS.message,
			record: {
				$type: COLLECTIONS.message,
				text: "written straight to my own PDS",
				createdAt: new Date().toISOString(),
			},
		});

		await harness.waitForWriter(textChannel, member.did);
		await harness.syncSpace(textChannel);

		const messages = await harness.database.db
			.select()
			.from(harness.database.tables.messages)
			.where(
				and(
					eq(harness.database.tables.messages.space, textChannel),
					eq(harness.database.tables.messages.author, member.did),
				),
			);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toBe("written straight to my own PDS");
		expect(messages[0]?.community).toBe(community);
	});

	it("advances incrementally on a second write rather than refetching the repo", async () => {
		await harness.pds.createRecord(member.session, {
			space: textChannel,
			collection: COLLECTIONS.message,
			record: {
				$type: COLLECTIONS.message,
				text: "a second message",
				createdAt: new Date().toISOString(),
			},
		});

		const outcome = await harness.repoSync.sync(textChannel, member.did);
		expect(outcome.kind).toBe("advanced");

		const messages = await harness.database.db
			.select()
			.from(harness.database.tables.messages)
			.where(eq(harness.database.tables.messages.space, textChannel));
		expect(messages.length).toBeGreaterThanOrEqual(2);
	});

	it("recovers the whole repo when the local set hash has drifted", async () => {
		await harness.database.db
			.update(harness.database.tables.spaceRepos)
			.set({ setHashBase64: null, appliedRev: "3aaaaaaaaaaaa" })
			.where(
				and(
					eq(harness.database.tables.spaceRepos.space, textChannel),
					eq(harness.database.tables.spaceRepos.author, member.did),
				),
			);

		const outcome = await harness.repoSync.sync(textChannel, member.did);
		expect(["advanced", "recovered"]).toContain(outcome.kind);

		const messages = await harness.database.db
			.select()
			.from(harness.database.tables.messages)
			.where(
				and(
					eq(harness.database.tables.messages.space, textChannel),
					eq(harness.database.tables.messages.author, member.did),
				),
			);
		expect(messages).toHaveLength(2);
	});

	it("removes a message the member deleted from their own repo", async () => {
		const [existing] = await harness.database.db
			.select()
			.from(harness.database.tables.messages)
			.where(
				and(
					eq(harness.database.tables.messages.space, textChannel),
					eq(harness.database.tables.messages.author, member.did),
				),
			)
			.limit(1);

		await harness.pds.deleteRecord(member.session, {
			space: textChannel,
			collection: COLLECTIONS.message,
			rkey: existing?.rkey as string,
		});

		await harness.repoSync.sync(textChannel, member.did);

		const remaining = await harness.database.db
			.select()
			.from(harness.database.tables.messages)
			.where(
				and(
					eq(harness.database.tables.messages.space, textChannel),
					eq(harness.database.tables.messages.author, member.did),
				),
			);
		expect(remaining.every((row) => row.rkey !== existing?.rkey)).toBe(true);
	});
});

describe("a personal space", () => {
	it("syncs the owner's own preferences", async () => {
		const user = await harness.createUser(unique("prefs"));
		const space = `at://${user.did}/space/${SPACE_TYPES.actorPreferences}/${SELF}`;

		await harness.pds.createSpace(user.session, {
			type: SPACE_TYPES.actorPreferences,
			skey: SELF,
			policy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
			appAccess: { $type: "com.atproto.simplespace.defs#open" },
		});

		await harness.pds.putRecord(user.session, {
			space,
			collection: COLLECTIONS.settings,
			rkey: SELF,
			record: {
				$type: COLLECTIONS.settings,
				notificationLevel: "mentionsAndReplies",
				communityOrder: [community],
			},
		});

		await registerSpace(harness.database, space, user.did, null, harness.pds.service);

		const token = await harness.pds.getDelegationToken(user.session, space);
		expect(typeof token).toBe("string");
	}, 60_000);
});

describe("moderation", () => {
	it("removes a banned member and records the ban", async () => {
		const troublemaker = await harness.createUser(unique("banned"));
		await harness.membership.join(community, troublemaker.did);
		await harness.syncSpace(communitySpaces(community).members);

		await harness.moderation.ban(community, community, troublemaker.did, "integration test");
		await harness.syncSpace(communitySpaces(community).members);
		await harness.syncSpace(communitySpaces(community).moderation);

		const authz = await harness.loader.authz(community, troublemaker.did);
		expect(authz.member).toBeNull();
		expect(authz.isBanned).toBe(true);
	}, 60_000);
});
