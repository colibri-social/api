import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { channelSpace, communitySpaces, preferencesSpace, SELF } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyChange, type SpaceChange } from "./apply.js";
import type { ProjectionDeps, RecordRef } from "./context.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const MEMBER = "did:plc:7fkdlwjqmzcuvvpjbztkyyyy";
const OUTSIDER = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const SPACES = communitySpaces(COMMUNITY);
const TEXT_CHANNEL = channelSpace(COMMUNITY, "social.colibri.beta.channel.text", "3lkchannel1");
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let deps: ProjectionDeps;
let skipped: Array<{ ref: RecordRef; reason: string }>;

const put = (
	space: string,
	author: string,
	collection: string,
	rkey: string,
	value: Record<string, unknown>,
): SpaceChange => ({
	space,
	author,
	puts: [{ collection, rkey, cid: "bafytest", value }],
	deletes: [],
});

beforeEach(async () => {
	database = await openTestDatabase();
	skipped = [];
	deps = {
		db: database.db,
		tables: database.tables,
		now: () => NOW,
		onSkipped: (ref, reason) => skipped.push({ ref, reason }),
	};
});

afterEach(async () => {
	await database.destroy();
});

describe("community projections", () => {
	it("creates a community row from its profile record, deriving every space uri", async () => {
		await applyChange(
			deps,
			put(SPACES.profile, COMMUNITY, "social.colibri.beta.community", SELF, {
				$type: "social.colibri.beta.community",
				name: "Protocol Nerds",
				managingApp: "did:web:appview.test",
				description: "a place",
			}),
		);

		const [row] = await database.db.select().from(database.tables.communities);
		expect(row?.name).toBe("Protocol Nerds");
		expect(row?.managingApp).toBe("did:web:appview.test");
		expect(row?.profileSpace).toBe(SPACES.profile);
		expect(row?.membersSpace).toBe(SPACES.members);
		expect(row?.moderationSpace).toBe(SPACES.moderation);
	});

	it("merges settings into the same community row", async () => {
		await applyChange(
			deps,
			put(SPACES.profile, COMMUNITY, "social.colibri.beta.community", SELF, {
				$type: "social.colibri.beta.community",
				name: "Protocol Nerds",
				managingApp: "did:web:appview.test",
			}),
		);
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.community.settings", SELF, {
				$type: "social.colibri.beta.community.settings",
				categoryOrder: [],
				requiresApprovalToJoin: true,
				labelers: ["did:plc:labeler"],
			}),
		);

		const [row] = await database.db.select().from(database.tables.communities);
		expect(row?.name).toBe("Protocol Nerds");
		expect(row?.requiresApproval).toBe(true);
		expect(row?.labelers).toEqual(["did:plc:labeler"]);
	});

	it("orders channels from the category that lists them", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "general",
			}),
		);
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.category", "3lkcat1", {
				$type: "social.colibri.beta.category",
				name: "Text",
				channelOrder: ["3lkchannel1"],
			}),
		);

		const [row] = await database.db.select().from(database.tables.channels);
		expect(row?.name).toBe("general");
		expect(row?.category).toBe("3lkcat1");
		expect(row?.position).toBe(0);
	});
});

describe("authority-written collections", () => {
	it("refuses a role written by a member rather than by the community", async () => {
		await applyChange(
			deps,
			put(SPACES.members, MEMBER, "social.colibri.beta.role", "3lkrole1", {
				$type: "social.colibri.beta.role",
				name: "Definitely An Admin",
				permissions: ["community.manage"],
				position: 9999,
			}),
		);

		expect(await database.db.select().from(database.tables.roles)).toEqual([]);
		expect(skipped[0]?.reason).toMatch(/space authority/);
	});

	it("accepts the same role from the community itself", async () => {
		await applyChange(
			deps,
			put(SPACES.members, COMMUNITY, "social.colibri.beta.role", "3lkrole1", {
				$type: "social.colibri.beta.role",
				name: "Moderator",
				permissions: ["member.kick"],
				position: 10,
			}),
		);

		const [row] = await database.db.select().from(database.tables.roles);
		expect(row?.name).toBe("Moderator");
		expect(row?.permissions).toEqual(["member.kick"]);
	});

	it("refuses a member record written by the member it names", async () => {
		await applyChange(
			deps,
			put(SPACES.members, MEMBER, "social.colibri.beta.member", MEMBER, {
				$type: "social.colibri.beta.member",
				subject: MEMBER,
				joinedAt: NOW,
				roles: [],
			}),
		);
		expect(await database.db.select().from(database.tables.members)).toEqual([]);
	});

	it("refuses a channel record written by an outsider", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, OUTSIDER, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "hijacked",
			}),
		);
		expect(await database.db.select().from(database.tables.channels)).toEqual([]);
	});
});

describe("member-written collections", () => {
	it("accepts a message from any member of the channel space", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3lkmsg1", {
				$type: "social.colibri.beta.message",
				text: "hello",
				createdAt: NOW,
			}),
		);

		const [row] = await database.db.select().from(database.tables.messages);
		expect(row?.text).toBe("hello");
		expect(row?.author).toBe(MEMBER);
		expect(row?.community).toBe(COMMUNITY);
	});

	it("keeps a reply pointing at both the author and the key of its parent", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3lkmsg2", {
				$type: "social.colibri.beta.message",
				text: "replying",
				createdAt: NOW,
				parent: { did: OUTSIDER, rkey: "3lkmsg1" },
			}),
		);

		const [row] = await database.db.select().from(database.tables.messages);
		expect(row?.parentAuthor).toBe(OUTSIDER);
		expect(row?.parentRkey).toBe("3lkmsg1");
	});

	it("refuses a message that does not match its lexicon", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3lkmsg3", {
				$type: "social.colibri.beta.message",
				createdAt: NOW,
			}),
		);
		expect(await database.db.select().from(database.tables.messages)).toEqual([]);
		expect(skipped[0]?.reason).toMatch(/text/);
	});

	it("refuses a message written into a voice channel space", async () => {
		const voice = channelSpace(COMMUNITY, "social.colibri.beta.channel.voice", "3lkvoice1");
		await applyChange(
			deps,
			put(voice, MEMBER, "social.colibri.beta.message", "3lkmsg4", {
				$type: "social.colibri.beta.message",
				text: "nope",
				createdAt: NOW,
			}),
		);
		expect(await database.db.select().from(database.tables.messages)).toEqual([]);
		expect(skipped[0]?.reason).toMatch(/not expected/);
	});

	it("removes a message on delete", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3lkmsg1", {
				$type: "social.colibri.beta.message",
				text: "hello",
				createdAt: NOW,
			}),
		);
		await applyChange(deps, {
			space: TEXT_CHANNEL,
			author: MEMBER,
			puts: [],
			deletes: [{ collection: "social.colibri.beta.message", rkey: "3lkmsg1" }],
		});
		expect(await database.db.select().from(database.tables.messages)).toEqual([]);
	});
});

describe("labels", () => {
	it("records who applied a label so a reader can honour only trusted labelers", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.label", "3lklabel1", {
				$type: "social.colibri.beta.label",
				subject: { did: MEMBER, collection: "social.colibri.beta.message", rkey: "3lkmsg1" },
				val: "hidden",
				createdAt: NOW,
			}),
		);

		const [row] = await database.db.select().from(database.tables.labels);
		expect(row?.src).toBe(COMMUNITY);
		expect(row?.val).toBe("hidden");
		expect(row?.subjectRkey).toBe("3lkmsg1");
	});

	it("accepts a label from a third-party labeler, leaving trust to the reader", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, OUTSIDER, "social.colibri.beta.label", "3lklabel2", {
				$type: "social.colibri.beta.label",
				subject: { did: MEMBER, collection: "social.colibri.beta.message", rkey: "3lkmsg1" },
				val: "spoiler",
				createdAt: NOW,
			}),
		);

		const [row] = await database.db.select().from(database.tables.labels);
		expect(row?.src).toBe(OUTSIDER);
	});
});

describe("personal spaces", () => {
	const personal = preferencesSpace(MEMBER);

	it("projects a mute from the owner's own space", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.mute", "3lkmute1", {
				$type: "social.colibri.beta.actor.mute",
				subject: OUTSIDER,
				createdAt: NOW,
			}),
		);

		const [row] = await database.db.select().from(database.tables.mutes);
		expect(row?.subject).toBe(OUTSIDER);
	});

	it("refuses a record written into someone else's personal space", async () => {
		await applyChange(
			deps,
			put(personal, OUTSIDER, "social.colibri.beta.actor.mute", "3lkmute2", {
				$type: "social.colibri.beta.actor.mute",
				subject: MEMBER,
				createdAt: NOW,
			}),
		);
		expect(await database.db.select().from(database.tables.mutes)).toEqual([]);
	});

	it("replaces a community's read cursors wholesale", async () => {
		const write = (cursors: Array<{ channel: string; cursor: string }>) =>
			applyChange(
				deps,
				put(personal, MEMBER, "social.colibri.beta.channel.read", COMMUNITY, {
					$type: "social.colibri.beta.channel.read",
					community: COMMUNITY,
					cursors,
				}),
			);

		await write([
			{ channel: "3lkchannel1", cursor: "3lkaaaaaaaaa2" },
			{ channel: "3lkchannel2", cursor: "3lkaaaaaaaaa3" },
		]);
		await write([{ channel: "3lkchannel1", cursor: "3lkaaaaaaaaa7" }]);

		const rows = await database.db
			.select()
			.from(database.tables.readCursors)
			.where(eq(database.tables.readCursors.did, MEMBER));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.cursor).toBe("3lkaaaaaaaaa7");
	});
});
