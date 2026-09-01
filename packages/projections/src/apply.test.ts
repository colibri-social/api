import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	channelSpace,
	communitySpaces,
	preferencesSpace,
	SELF,
	threadSpace,
	toLexForm,
} from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyChange, type SpaceChange } from "./apply.js";
import type { AuthzChange, ProjectionDeps, RecordRef } from "./context.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const MEMBER = "did:plc:7fkdlwjqmzcuvvpjbztkyyyy";
const OUTSIDER = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const SPACES = communitySpaces(COMMUNITY);
const TEXT_CHANNEL = channelSpace(COMMUNITY, "social.colibri.beta.channel.text", "3lkchannel1");
const THREAD = threadSpace(COMMUNITY, "3lkthread1");
const NOW = "2026-08-23T00:00:00.000Z";
const PICTURE_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiibsojllbf5xhqzy6a";

const jsonBlob = (cid: string, mimeType = "image/png") => ({
	$type: "blob",
	ref: { $link: cid },
	mimeType,
	size: 1234,
});

let database: TestDatabase;
let deps: ProjectionDeps;
let skipped: Array<{ ref: RecordRef; reason: string }>;
let authzChanges: AuthzChange[];

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
	authzChanges = [];
	deps = {
		db: database.db,
		tables: database.tables,
		now: () => NOW,
		onSkipped: (ref, reason) => skipped.push({ ref, reason }),
		onAuthzChanged: (change) => authzChanges.push(change),
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

	it("keeps the picture cid whether the record arrives as json or as lex", async () => {
		const record = {
			$type: "social.colibri.beta.community",
			name: "Protocol Nerds",
			managingApp: "did:web:appview.test",
			picture: jsonBlob(PICTURE_CID),
		};

		await applyChange(
			deps,
			put(SPACES.profile, COMMUNITY, "social.colibri.beta.community", SELF, record),
		);
		expect(skipped).toEqual([]);
		const [fromJson] = await database.db.select().from(database.tables.communities);
		expect(fromJson?.pictureCid).toBe(PICTURE_CID);

		await database.db.delete(database.tables.communities);
		await applyChange(
			deps,
			put(SPACES.profile, COMMUNITY, "social.colibri.beta.community", SELF, toLexForm(record)),
		);
		expect(skipped).toEqual([]);
		const [fromLex] = await database.db.select().from(database.tables.communities);
		expect(fromLex?.pictureCid).toBe(PICTURE_CID);
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

	it("stores a message attachment as a json blob the views can read", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3lkmsgblob", {
				$type: "social.colibri.beta.message",
				text: "with a picture",
				createdAt: NOW,
				attachments: [{ name: "shot.png", blob: jsonBlob(PICTURE_CID) }],
			}),
		);

		expect(skipped).toEqual([]);
		const [row] = await database.db.select().from(database.tables.messages);
		expect(row?.attachments).toEqual([{ name: "shot.png", blob: jsonBlob(PICTURE_CID) }]);
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
				subject: { $type: "social.colibri.beta.actor.defs#mutedActor", did: OUTSIDER },
				createdAt: NOW,
			}),
		);

		const [row] = await database.db.select().from(database.tables.mutes);
		expect(row?.subject).toBe(OUTSIDER);
	});

	it("projects a channel mute as its space reference", async () => {
		const channel = `at://${COMMUNITY}/space/social.colibri.beta.channel.text/3lkchan1`;
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.mute", "3lkmute2", {
				$type: "social.colibri.beta.actor.mute",
				subject: { $type: "social.colibri.beta.actor.defs#mutedChannel", channel },
				createdAt: NOW,
			}),
		);

		const [row] = await database.db.select().from(database.tables.mutes);
		expect(row?.subject).toBe(channel);
	});

	it("adopts the repo's rkey for a subject an immediate push already inserted", async () => {
		await database.db.insert(database.tables.mutes).values({
			did: MEMBER,
			rkey: "3lkpushed0001",
			subject: OUTSIDER,
			createdAt: NOW,
		});

		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.mute", "3lkfromrepo1", {
				$type: "social.colibri.beta.actor.mute",
				subject: { $type: "social.colibri.beta.actor.defs#mutedActor", did: OUTSIDER },
				createdAt: NOW,
			}),
		);

		const rows = await database.db.select().from(database.tables.mutes);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.rkey).toBe("3lkfromrepo1");
	});

	it("projects a favourited GIF as the whole view the picker renders", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.settings", SELF, {
				$type: "social.colibri.beta.actor.settings",
				gifFavorites: [
					{
						$type: "social.colibri.beta.embed.defs#gifView",
						id: "https://cdn.test/cat.gif",
						url: "https://cdn.test/cat.gif",
						previewUrl: "https://cdn.test/cat-small.gif",
						width: 320,
						height: 240,
						title: "a cat",
					},
				],
			}),
		);

		const [row] = await database.db.select().from(database.tables.actorSettings);
		expect(row?.gifFavorites).toEqual([
			{
				id: "https://cdn.test/cat.gif",
				url: "https://cdn.test/cat.gif",
				previewUrl: "https://cdn.test/cat-small.gif",
				width: 320,
				height: 240,
				title: "a cat",
			},
		]);
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

describe("channel projections", () => {
	const ROLE = "3lkrolemoderator";

	it("keeps who may see a channel alongside who may post in it", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "backstage",
				allowedRoles: [ROLE],
				allowedMembers: [MEMBER],
				visibleToRoles: [ROLE],
				visibleToMembers: [MEMBER],
			}),
		);

		const [row] = await database.db
			.select()
			.from(database.tables.channels)
			.where(eq(database.tables.channels.space, TEXT_CHANNEL));

		expect(row?.allowedRoles).toEqual([ROLE]);
		expect(row?.allowedMembers).toEqual([MEMBER]);
		expect(row?.visibleToRoles).toEqual([ROLE]);
		expect(row?.visibleToMembers).toEqual([MEMBER]);
	});

	it("clears the lists again when the record drops them", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "backstage",
				visibleToRoles: [ROLE],
				visibleToMembers: [MEMBER],
			}),
		);
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "backstage",
			}),
		);

		const [row] = await database.db
			.select()
			.from(database.tables.channels)
			.where(eq(database.tables.channels.space, TEXT_CHANNEL));

		expect(row?.visibleToRoles).toEqual([]);
		expect(row?.visibleToMembers).toEqual([]);
	});
});

describe("authz changes", () => {
	it("reports the community behind every collection an authorization decision reads", async () => {
		await applyChange(
			deps,
			put(SPACES.members, COMMUNITY, "social.colibri.beta.role", "3lkrole1", {
				$type: "social.colibri.beta.role",
				name: "Moderator",
				permissions: ["member.kick"],
				position: 10,
			}),
		);
		await applyChange(
			deps,
			put(SPACES.members, COMMUNITY, "social.colibri.beta.member", MEMBER, {
				$type: "social.colibri.beta.member",
				subject: MEMBER,
				joinedAt: NOW,
				roles: [],
			}),
		);
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "general",
			}),
		);
		await applyChange(deps, {
			space: TEXT_CHANNEL,
			author: COMMUNITY,
			puts: [],
			deletes: [{ collection: "social.colibri.beta.channel", rkey: SELF }],
		});

		expect(authzChanges).toEqual([
			{ community: COMMUNITY, collection: "social.colibri.beta.role" },
			{ community: COMMUNITY, collection: "social.colibri.beta.member" },
			{ community: COMMUNITY, collection: "social.colibri.beta.channel" },
			{ community: COMMUNITY, collection: "social.colibri.beta.channel" },
		]);
	});

	it("stays quiet for a record no authorization decision reads", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3lkmsg1", {
				$type: "social.colibri.beta.message",
				text: "hello",
				createdAt: NOW,
			}),
		);

		expect(authzChanges).toEqual([]);
	});

	it("stays quiet for a refused write", async () => {
		await applyChange(
			deps,
			put(SPACES.members, MEMBER, "social.colibri.beta.role", "3lkrole1", {
				$type: "social.colibri.beta.role",
				name: "Self-appointed",
				permissions: ["community.manage"],
				position: 99,
			}),
		);

		expect(skipped).toHaveLength(1);
		expect(authzChanges).toEqual([]);
	});
});

describe("thread projection", () => {
	const record = (overrides: Record<string, unknown> = {}) => ({
		$type: "social.colibri.beta.thread",
		name: "side conversation",
		channel: TEXT_CHANNEL,
		createdBy: MEMBER,
		createdAt: NOW,
		...overrides,
	});

	const threadRows = () =>
		database.db
			.select()
			.from(database.tables.threads)
			.where(eq(database.tables.threads.space, THREAD));

	it("projects a thread the community wrote", async () => {
		await applyChange(deps, put(THREAD, COMMUNITY, "social.colibri.beta.thread", SELF, record()));

		const [row] = await threadRows();
		expect(row).toMatchObject({
			space: THREAD,
			community: COMMUNITY,
			channel: TEXT_CHANNEL,
			name: "side conversation",
			createdBy: MEMBER,
			lastActivityAt: NOW,
		});
	});

	it("refuses a thread record written by anyone but the community", async () => {
		await applyChange(deps, put(THREAD, MEMBER, "social.colibri.beta.thread", SELF, record()));

		expect(await threadRows()).toHaveLength(0);
		expect(skipped[0]?.reason).toBe("collection may only be written by the space authority");
	});

	it("refuses a thread record outside a thread space", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.thread", SELF, record()),
		);

		expect(skipped[0]?.reason).toBe(
			"collection is not expected in a social.colibri.beta.channel.text space",
		);
	});

	it("moves a thread's last activity forward when a message lands", async () => {
		const later = "2026-08-24T00:00:00.000Z";
		await applyChange(deps, put(THREAD, COMMUNITY, "social.colibri.beta.thread", SELF, record()));
		await applyChange(
			deps,
			put(THREAD, MEMBER, "social.colibri.beta.message", "3lkmessage1", {
				$type: "social.colibri.beta.message",
				text: "over here",
				createdAt: later,
			}),
		);

		const [row] = await threadRows();
		expect(row?.lastActivityAt).toBe(later);
	});

	it("records a follow written by the follower and forgets it on delete", async () => {
		const follows = () =>
			database.db
				.select()
				.from(database.tables.threadFollows)
				.where(eq(database.tables.threadFollows.space, THREAD));

		await applyChange(
			deps,
			put(THREAD, MEMBER, "social.colibri.beta.thread.follow", SELF, {
				$type: "social.colibri.beta.thread.follow",
				createdAt: NOW,
			}),
		);
		expect(await follows()).toHaveLength(1);

		await applyChange(deps, {
			space: THREAD,
			author: MEMBER,
			puts: [],
			deletes: [{ collection: "social.colibri.beta.thread.follow", rkey: SELF }],
		});
		expect(await follows()).toHaveLength(0);
	});
});
