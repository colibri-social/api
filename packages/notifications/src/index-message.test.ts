import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { channelSpace } from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDeps } from "./deps.js";
import { indexMessage } from "./index-message.js";

const COMMUNITY = "did:plc:community0000000000000000";
const CHANNEL = channelSpace(COMMUNITY, "social.colibri.beta.channel.text", "3lkchannel1");
const AUTHOR = "did:plc:author00000000000000000000";
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let deps: NotificationDeps;

const member = async (did: string, roles: string[] = []) => {
	await database.db.insert(database.tables.members).values({
		community: COMMUNITY,
		did,
		roles,
		joinedAt: NOW,
	});
};

const role = async (
	rkey: string,
	options: Partial<{ name: string; mentionable: boolean; permissions: string[] }> = {},
) => {
	await database.db.insert(database.tables.roles).values({
		community: COMMUNITY,
		rkey,
		name: options.name ?? rkey,
		mentionable: options.mentionable ?? false,
		permissions: options.permissions ?? [],
	});
};

const mute = async (did: string, subject: string) => {
	await database.db.insert(database.tables.mutes).values({
		did,
		rkey: `mute-${subject}`,
		subject,
		createdAt: NOW,
	});
};

const notificationLevel = async (did: string, level: "all" | "mentionsAndReplies") => {
	await database.db.insert(database.tables.actorSettings).values({ did, notificationLevel: level });
};

const viewing = async (did: string, channel: string) => {
	await database.db.insert(database.tables.userPresence).values({
		did,
		derivedState: "online",
		viewingChannel: channel,
		updatedAt: NOW,
	});
};

const rowsFor = async (recipient: string) =>
	database.db
		.select()
		.from(database.tables.notifications)
		.where(and(eq(database.tables.notifications.recipient, recipient)));

const mentionFacet = (did: string) => ({
	index: { byteStart: 0, byteEnd: 1 },
	features: [{ $type: "social.colibri.beta.richtext.facet#mention", did }],
});

const roleFacet = (roleKey: string) => ({
	index: { byteStart: 0, byteEnd: 1 },
	features: [{ $type: "social.colibri.beta.richtext.facet#role", role: roleKey }],
});

beforeEach(async () => {
	database = await openTestDatabase();
	deps = { db: database.db, tables: database.tables, now: () => NOW };
	await member(AUTHOR);
});

afterEach(async () => {
	await database.destroy();
});

describe("indexMessage", () => {
	it("notifies a directly mentioned member", async () => {
		const recipient = "did:plc:recipient000000000000000";
		await member(recipient);

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: [mentionFacet(recipient)],
			parentAuthor: null,
			parentRkey: null,
		});

		const rows = await rowsFor(recipient);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("mention");
	});

	it("notifies the parent author as a reply", async () => {
		const recipient = "did:plc:recipient000000000000000";
		await member(recipient);

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: null,
			parentAuthor: recipient,
			parentRkey: "3lkparent1",
		});

		const rows = await rowsFor(recipient);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("reply");
	});

	it("notifies every other member with a plain message notification", async () => {
		const recipient = "did:plc:recipient000000000000000";
		await member(recipient);

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: null,
			parentAuthor: null,
			parentRkey: null,
		});

		const rows = await rowsFor(recipient);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("message");
	});

	it("prefers a mention over a plain message and inserts only one row", async () => {
		const recipient = "did:plc:recipient000000000000000";
		await member(recipient);

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: [mentionFacet(recipient)],
			parentAuthor: null,
			parentRkey: null,
		});

		const rows = await rowsFor(recipient);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("mention");
	});

	it("never notifies the author about their own message", async () => {
		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: [mentionFacet(AUTHOR)],
			parentAuthor: AUTHOR,
			parentRkey: "3lkparent1",
		});

		const rows = await rowsFor(AUTHOR);
		expect(rows).toHaveLength(0);
	});

	it("suppresses a plain message for a recipient on mentionsAndReplies but keeps mentions and replies", async () => {
		const mentioned = "did:plc:mentioned0000000000000000";
		const replied = "did:plc:replied00000000000000000";
		const plain = "did:plc:plain0000000000000000000";
		await member(mentioned);
		await member(replied);
		await member(plain);
		await notificationLevel(mentioned, "mentionsAndReplies");
		await notificationLevel(replied, "mentionsAndReplies");
		await notificationLevel(plain, "mentionsAndReplies");

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: [mentionFacet(mentioned)],
			parentAuthor: replied,
			parentRkey: "3lkparent1",
		});

		expect((await rowsFor(mentioned))[0]?.kind).toBe("mention");
		expect((await rowsFor(replied))[0]?.kind).toBe("reply");
		expect(await rowsFor(plain)).toHaveLength(0);
	});

	it("suppresses a notification for a recipient who muted the author", async () => {
		const recipient = "did:plc:recipient000000000000000";
		await member(recipient);
		await mute(recipient, AUTHOR);

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: [mentionFacet(recipient)],
			parentAuthor: null,
			parentRkey: null,
		});

		expect(await rowsFor(recipient)).toHaveLength(0);
	});

	it("suppresses a notification for a recipient who muted the community", async () => {
		const recipient = "did:plc:recipient000000000000000";
		await member(recipient);
		await mute(recipient, COMMUNITY);

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: null,
			parentAuthor: null,
			parentRkey: null,
		});

		expect(await rowsFor(recipient)).toHaveLength(0);
	});

	it("does not notify a mentioned DID that holds no member row", async () => {
		const outsider = "did:plc:outsider00000000000000000";

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: [mentionFacet(outsider)],
			parentAuthor: null,
			parentRkey: null,
		});

		expect(await rowsFor(outsider)).toHaveLength(0);
	});

	describe("role mentions", () => {
		it("notifies role holders when the role is mentionable", async () => {
			const holder = "did:plc:holder0000000000000000000";
			await role("3lkrole1", { name: "Moderators", mentionable: true });
			await member(holder, ["3lkrole1"]);

			await indexMessage(deps, {
				space: CHANNEL,
				community: COMMUNITY,
				author: AUTHOR,
				rkey: "3lkmsg1",
				facets: [roleFacet("3lkrole1")],
				parentAuthor: null,
				parentRkey: null,
			});

			const rows = await rowsFor(holder);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.kind).toBe("mention");
			expect(rows[0]?.mentionRole).toBe("Moderators");
		});

		it("notifies role holders when a non-mentionable role is pinged by someone holding mention.roles", async () => {
			const holder = "did:plc:holder0000000000000000000";
			await role("3lkrole1", { name: "Moderators", mentionable: false });
			await role("3lkrole2", { name: "Staff", mentionable: false, permissions: ["mention.roles"] });
			await member(holder, ["3lkrole1"]);
			await database.db
				.update(database.tables.members)
				.set({ roles: ["3lkrole2"] })
				.where(
					and(
						eq(database.tables.members.community, COMMUNITY),
						eq(database.tables.members.did, AUTHOR),
					),
				);

			await indexMessage(deps, {
				space: CHANNEL,
				community: COMMUNITY,
				author: AUTHOR,
				rkey: "3lkmsg1",
				facets: [roleFacet("3lkrole1")],
				parentAuthor: null,
				parentRkey: null,
			});

			const rows = await rowsFor(holder);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.kind).toBe("mention");
		});

		it("does not notify role holders for a non-mentionable role when the author lacks mention.roles", async () => {
			const holder = "did:plc:holder0000000000000000000";
			await role("3lkrole1", { name: "Moderators", mentionable: false });
			await member(holder, ["3lkrole1"]);
			await notificationLevel(holder, "mentionsAndReplies");

			await indexMessage(deps, {
				space: CHANNEL,
				community: COMMUNITY,
				author: AUTHOR,
				rkey: "3lkmsg1",
				facets: [roleFacet("3lkrole1")],
				parentAuthor: null,
				parentRkey: null,
			});

			expect(await rowsFor(holder)).toHaveLength(0);
		});
	});
});

describe("someone already looking at the channel", () => {
	const reader = "did:plc:reader0000000000000000000";

	it("gets no notification for a mention in the channel they are reading", async () => {
		await member(reader);
		await viewing(reader, CHANNEL);

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg1",
			facets: [mentionFacet(reader)],
			parentAuthor: null,
			parentRkey: null,
		});

		expect(await rowsFor(reader)).toHaveLength(0);
	});

	it("still gets one when they are reading a different channel", async () => {
		await member(reader);
		await viewing(reader, channelSpace(COMMUNITY, "social.colibri.beta.channel.text", "3lkelse"));

		await indexMessage(deps, {
			space: CHANNEL,
			community: COMMUNITY,
			author: AUTHOR,
			rkey: "3lkmsg2",
			facets: [mentionFacet(reader)],
			parentAuthor: null,
			parentRkey: null,
		});

		expect(await rowsFor(reader)).toHaveLength(1);
	});
});
