import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	channelSpace,
	communitySpaces,
	preferencesSpace,
	SELF,
	threadSpace,
	toLexForm,
} from "@colibri-social/lexicons";
import { tidAt, tidTime } from "@colibri-social/space";
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

	it("places a channel projected after the category that lists it", async () => {
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.category", "3lkcat1", {
				$type: "social.colibri.beta.category",
				name: "Staff",
				channelOrder: ["3lkchannel0", "3lkchannel1"],
				visibleToRoles: ["3lkrole2"],
			}),
		);
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "general",
			}),
		);

		const [row] = await database.db.select().from(database.tables.channels);
		expect(row?.category).toBe("3lkcat1");
		expect(row?.position).toBe(1);
	});

	it("places an unplaced channel again when its record is projected once more", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "general",
			}),
		);
		await database.db.insert(database.tables.categories).values({
			community: COMMUNITY,
			rkey: "3lkcat1",
			name: "Text",
			channelOrder: ["3lkchannel1"],
		});
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "general",
			}),
		);

		const [row] = await database.db.select().from(database.tables.channels);
		expect(row?.category).toBe("3lkcat1");
	});

	it("keeps the category of a channel that already has one", async () => {
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.category", "3lkcat1", {
				$type: "social.colibri.beta.category",
				name: "Text",
				channelOrder: ["3lkchannel1"],
			}),
		);
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "general",
			}),
		);
		await database.db.update(database.tables.channels).set({ category: "3lkcat2", position: 4 });
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.channel", SELF, {
				$type: "social.colibri.beta.channel",
				name: "renamed",
			}),
		);

		const [row] = await database.db.select().from(database.tables.channels);
		expect(row?.name).toBe("renamed");
		expect(row?.category).toBe("3lkcat2");
		expect(row?.position).toBe(4);
	});

	it("projects a category's permissions and announces them as an authz change", async () => {
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.category", "3lkcat1", {
				$type: "social.colibri.beta.category",
				name: "Staff",
				channelOrder: [],
				allowedRoles: ["3lkrole1"],
				visibleToRoles: ["3lkrole2"],
				visibleToMembers: ["did:plc:guest"],
			}),
		);

		expect(skipped).toEqual([]);
		const [row] = await database.db.select().from(database.tables.categories);
		expect(row).toMatchObject({
			ownerOnly: false,
			allowedRoles: ["3lkrole1"],
			allowedMembers: [],
			visibleToRoles: ["3lkrole2"],
			visibleToMembers: ["did:plc:guest"],
		});
		expect(authzChanges).toContainEqual({
			community: COMMUNITY,
			collection: "social.colibri.beta.category",
		});
	});
});

describe("default roles", () => {
	it("projects a default role as neither hoisted nor mentionable, whatever the record claims", async () => {
		await applyChange(
			deps,
			put(SPACES.members, COMMUNITY, "social.colibri.beta.role", "3lkmembers", {
				$type: "social.colibri.beta.role",
				name: "Members",
				permissions: ["thread.create"],
				position: 0,
				hoisted: true,
				mentionable: true,
				default: true,
			}),
		);

		expect(skipped).toEqual([]);
		const [row] = await database.db.select().from(database.tables.roles);
		expect(row).toMatchObject({ isDefault: true, hoisted: false, mentionable: false });
	});
});

describe("role badges", () => {
	const roleWithBadge = (badge: Record<string, unknown>) => ({
		$type: "social.colibri.beta.role",
		name: "Moderator",
		permissions: [],
		position: 10,
		badge,
	});

	it("projects an icon badge", async () => {
		await applyChange(
			deps,
			put(
				SPACES.members,
				COMMUNITY,
				"social.colibri.beta.role",
				"3lkrole1",
				roleWithBadge({
					$type: "social.colibri.beta.role#iconBadge",
					icon: "shield-check",
					color: "#76c4e5",
				}),
			),
		);

		expect(skipped).toEqual([]);
		const [row] = await database.db.select().from(database.tables.roles);
		expect(row?.badge).toEqual({ kind: "icon", icon: "shield-check", color: "#76c4e5" });
	});

	it("projects an image badge whether the record arrives as json or as lex", async () => {
		const record = roleWithBadge({
			$type: "social.colibri.beta.role#imageBadge",
			image: jsonBlob(PICTURE_CID, "image/webp"),
		});

		await applyChange(
			deps,
			put(SPACES.members, COMMUNITY, "social.colibri.beta.role", "3lkrole1", record),
		);
		expect(skipped).toEqual([]);
		const [fromJson] = await database.db.select().from(database.tables.roles);
		expect(fromJson?.badge).toEqual({
			kind: "image",
			cid: PICTURE_CID,
			mimeType: "image/webp",
			size: 1234,
		});

		await database.db.delete(database.tables.roles);
		await applyChange(
			deps,
			put(SPACES.members, COMMUNITY, "social.colibri.beta.role", "3lkrole1", toLexForm(record)),
		);
		expect(skipped).toEqual([]);
		const [fromLex] = await database.db.select().from(database.tables.roles);
		expect(fromLex?.badge).toEqual({
			kind: "image",
			cid: PICTURE_CID,
			mimeType: "image/webp",
			size: 1234,
		});
	});

	it("clears the badge when the record drops it", async () => {
		await applyChange(
			deps,
			put(
				SPACES.members,
				COMMUNITY,
				"social.colibri.beta.role",
				"3lkrole1",
				roleWithBadge({ $type: "social.colibri.beta.role#iconBadge", icon: "star" }),
			),
		);
		await applyChange(
			deps,
			put(SPACES.members, COMMUNITY, "social.colibri.beta.role", "3lkrole1", {
				$type: "social.colibri.beta.role",
				name: "Moderator",
				permissions: [],
				position: 10,
			}),
		);

		const [row] = await database.db.select().from(database.tables.roles);
		expect(row?.badge).toBeNull();
	});

	it("ignores a badge kind it does not know", async () => {
		await applyChange(
			deps,
			put(
				SPACES.members,
				COMMUNITY,
				"social.colibri.beta.role",
				"3lkrole1",
				roleWithBadge({ $type: "social.colibri.beta.role#stickerBadge", sticker: "x" }),
			),
		);

		const [row] = await database.db.select().from(database.tables.roles);
		expect(row?.name).toBe("Moderator");
		expect(row?.badge).toBeNull();
	});

	it("projects a Unicode emoji badge and a custom emoji badge", async () => {
		const uri = `at://${COMMUNITY}/blue.moji.collection.item/parrot`;
		await applyChange(
			deps,
			put(
				SPACES.members,
				COMMUNITY,
				"social.colibri.beta.role",
				"3lkrole1",
				roleWithBadge({ $type: "social.colibri.beta.role#emojiBadge", emoji: "🦜" }),
			),
		);
		await applyChange(
			deps,
			put(
				SPACES.members,
				COMMUNITY,
				"social.colibri.beta.role",
				"3lkrole2",
				roleWithBadge({
					$type: "social.colibri.beta.role#emojiBadge",
					customEmoji: { uri, cid: PICTURE_CID },
				}),
			),
		);

		expect(skipped).toEqual([]);
		const rows = await database.db.select().from(database.tables.roles);
		expect(rows.find((row) => row.rkey === "3lkrole1")?.badge).toEqual({
			kind: "emoji",
			emoji: "🦜",
		});
		expect(rows.find((row) => row.rkey === "3lkrole2")?.badge).toEqual({
			kind: "customEmoji",
			uri,
			cid: PICTURE_CID,
		});
	});

	it("drops an emoji badge that holds no emoji", async () => {
		await applyChange(
			deps,
			put(
				SPACES.members,
				COMMUNITY,
				"social.colibri.beta.role",
				"3lkrole1",
				roleWithBadge({ $type: "social.colibri.beta.role#emojiBadge", emoji: "x" }),
			),
		);

		const [row] = await database.db.select().from(database.tables.roles);
		expect(row?.name).toBe("Moderator");
		expect(row?.badge).toBeNull();
	});
});

describe("custom emoji policy", () => {
	it("projects the policy from the settings record and resets it when the record goes", async () => {
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.community.settings", SELF, {
				$type: "social.colibri.beta.community.settings",
				categoryOrder: [],
				requiresApprovalToJoin: false,
				customEmoji: "local",
			}),
		);
		const [local] = await database.db.select().from(database.tables.communities);
		expect(local?.customEmoji).toBe("local");

		await applyChange(deps, {
			space: SPACES.configuration,
			author: COMMUNITY,
			puts: [],
			deletes: [{ collection: "social.colibri.beta.community.settings", rkey: SELF }],
		});
		const [reset] = await database.db.select().from(database.tables.communities);
		expect(reset?.customEmoji).toBe("all");
	});

	it("reads an unknown policy as all", async () => {
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.community.settings", SELF, {
				$type: "social.colibri.beta.community.settings",
				categoryOrder: [],
				requiresApprovalToJoin: false,
				customEmoji: "sparkly",
			}),
		);
		const [row] = await database.db.select().from(database.tables.communities);
		expect(row?.customEmoji).toBe("all");
	});
});

describe("name colour override", () => {
	it("projects the override from the settings record and resets it when the record goes", async () => {
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.community.settings", SELF, {
				$type: "social.colibri.beta.community.settings",
				categoryOrder: [],
				requiresApprovalToJoin: false,
				overrideUserNameColors: true,
			}),
		);
		const [on] = await database.db.select().from(database.tables.communities);
		expect(on?.overrideUserNameColors).toBe(true);

		await applyChange(deps, {
			space: SPACES.configuration,
			author: COMMUNITY,
			puts: [],
			deletes: [{ collection: "social.colibri.beta.community.settings", rkey: SELF }],
		});
		const [off] = await database.db.select().from(database.tables.communities);
		expect(off?.overrideUserNameColors).toBe(false);
	});

	it("defaults the override to false", async () => {
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.community.settings", SELF, {
				$type: "social.colibri.beta.community.settings",
				categoryOrder: [],
				requiresApprovalToJoin: false,
			}),
		);
		const [row] = await database.db.select().from(database.tables.communities);
		expect(row?.overrideUserNameColors).toBe(false);
	});
});

describe("owner badge setting", () => {
	it("projects hideOwnerBadge from the settings record and resets it when the record goes", async () => {
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.community.settings", SELF, {
				$type: "social.colibri.beta.community.settings",
				categoryOrder: [],
				requiresApprovalToJoin: false,
				hideOwnerBadge: true,
			}),
		);
		const [on] = await database.db.select().from(database.tables.communities);
		expect(on?.hideOwnerBadge).toBe(true);

		await applyChange(deps, {
			space: SPACES.configuration,
			author: COMMUNITY,
			puts: [],
			deletes: [{ collection: "social.colibri.beta.community.settings", rkey: SELF }],
		});
		const [off] = await database.db.select().from(database.tables.communities);
		expect(off?.hideOwnerBadge).toBe(false);
	});

	it("defaults hideOwnerBadge to false", async () => {
		await applyChange(
			deps,
			put(SPACES.configuration, COMMUNITY, "social.colibri.beta.community.settings", SELF, {
				$type: "social.colibri.beta.community.settings",
				categoryOrder: [],
				requiresApprovalToJoin: false,
			}),
		);
		const [row] = await database.db.select().from(database.tables.communities);
		expect(row?.hideOwnerBadge).toBe(false);
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

describe("bridged attribution", () => {
	const attribution = {
		registration: "3lkbridgeaaaa",
		platform: "chat",
		remoteId: "alice-1",
		name: "Alice",
	};

	it("keeps attribution on a message the community wrote", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.message", "3mry5ybrkzc22", {
				$type: "social.colibri.beta.message",
				text: "relayed",
				createdAt: NOW,
				bridged: attribution,
			}),
		);

		const [row] = await database.db.select().from(database.tables.messages);
		expect(row?.bridged).toEqual(attribution);
	});

	it("drops attribution a member put on their own message", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3mry5ybrkzc22", {
				$type: "social.colibri.beta.message",
				text: "pretending",
				createdAt: NOW,
				bridged: attribution,
			}),
		);

		const [row] = await database.db.select().from(database.tables.messages);
		expect(row?.bridged).toBeNull();
	});

	it("keys a community-written reaction by the remote person who reacted", async () => {
		for (const [rkey, remoteId] of [
			["3lkreact1", "alice-1"],
			["3lkreact2", "bob-1"],
		] as const) {
			await applyChange(
				deps,
				put(TEXT_CHANNEL, COMMUNITY, "social.colibri.beta.reaction", rkey, {
					$type: "social.colibri.beta.reaction",
					emoji: "👍",
					target: { did: MEMBER, rkey: "3mry5ybrkzc22" },
					bridged: { ...attribution, remoteId },
				}),
			);
		}

		const rows = await database.db.select().from(database.tables.reactions);
		expect(rows.map((row) => row.bridgedFrom).sort()).toEqual([
			"3lkbridgeaaaa alice-1",
			"3lkbridgeaaaa bob-1",
		]);
	});

	it("stores the emoji record a custom reaction names", async () => {
		const customEmoji = {
			uri: `at://${MEMBER}/social.colibri.beta.emoji/3lkemoji1`,
			cid: "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm",
		};
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.reaction", "3lkreact1", {
				$type: "social.colibri.beta.reaction",
				emoji: ":party:",
				target: { did: MEMBER, rkey: "3mry5ybrkzc22" },
				customEmoji,
			}),
		);
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.reaction", "3lkreact2", {
				$type: "social.colibri.beta.reaction",
				emoji: "👍",
				target: { did: MEMBER, rkey: "3mry5ybrkzc22" },
			}),
		);

		const rows = await database.db.select().from(database.tables.reactions);
		const byRkey = new Map(rows.map((row) => [row.rkey, row.customEmoji]));
		expect(byRkey.get("3lkreact1")).toEqual(customEmoji);
		expect(byRkey.get("3lkreact2")).toBeNull();
	});
});

describe("message time window", () => {
	const hoursFromNow = (hours: number) =>
		new Date(Date.parse(NOW) + hours * 60 * 60 * 1000).toISOString();

	const live = (
		author: string,
		rkey: string,
		rev: string,
		value: Record<string, unknown> = {},
	): SpaceChange => ({
		space: TEXT_CHANNEL,
		author,
		puts: [
			{
				collection: "social.colibri.beta.message",
				rkey,
				cid: "bafytest",
				rev,
				value: { $type: "social.colibri.beta.message", text: "hi", createdAt: NOW, ...value },
			},
		],
		deletes: [],
	});

	const messageRows = () => database.db.select().from(database.tables.messages);

	it("refuses a message whose record key is not a TID", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "notatid", {
				$type: "social.colibri.beta.message",
				text: "hi",
				createdAt: NOW,
			}),
		);

		expect(await messageRows()).toHaveLength(0);
		expect(skipped[0]?.reason).toBe("message record key is not a TID");
	});

	it("refuses a message whose record key is more than 15 minutes ahead", async () => {
		await applyChange(
			deps,
			put(
				TEXT_CHANNEL,
				MEMBER,
				"social.colibri.beta.message",
				tidAt("2028-01-01T00:00:00.000Z", "a"),
				{
					$type: "social.colibri.beta.message",
					text: "from the future",
					createdAt: NOW,
				},
			),
		);

		expect(await messageRows()).toHaveLength(0);
		expect(skipped[0]?.reason).toBe("message record key is dated in the future");
	});

	it("accepts a record key a few minutes ahead of the server clock", async () => {
		const ahead = new Date(Date.parse(NOW) + 10 * 60 * 1000).toISOString();
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", tidAt(ahead, "a"), {
				$type: "social.colibri.beta.message",
				text: "slightly fast clock",
				createdAt: ahead,
			}),
		);

		expect(skipped).toEqual([]);
		expect(await messageRows()).toHaveLength(1);
	});

	it("refuses a message whose createdAt is more than 15 minutes ahead", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", tidAt(NOW, "a"), {
				$type: "social.colibri.beta.message",
				text: "dated 2028",
				createdAt: "2028-01-01T00:00:00.000Z",
			}),
		);

		expect(await messageRows()).toHaveLength(0);
		expect(skipped[0]?.reason).toBe("message createdAt is in the future");
	});

	it("refuses a live create whose record key is 25 hours older than its commit", async () => {
		await applyChange(deps, live(MEMBER, tidAt(hoursFromNow(-25), "a"), tidAt(NOW, "rev")));

		expect(await messageRows()).toHaveLength(0);
		expect(skipped[0]?.reason).toBe("message record key is more than a day older than its commit");
	});

	it("accepts a live create whose record key is 23 hours older than its commit", async () => {
		await applyChange(deps, live(MEMBER, tidAt(hoursFromNow(-23), "a"), tidAt(NOW, "rev")));

		expect(skipped).toEqual([]);
		expect(await messageRows()).toHaveLength(1);
	});

	it("accepts an old record key from a recovery snapshot that carries no rev", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", tidAt(hoursFromNow(-24 * 30), "a"), {
				$type: "social.colibri.beta.message",
				text: "from last month",
				createdAt: hoursFromNow(-24 * 30),
			}),
		);

		expect(skipped).toEqual([]);
		expect(await messageRows()).toHaveLength(1);
	});

	it("accepts an old bridge import the community wrote", async () => {
		const sent = hoursFromNow(-24 * 365);
		await applyChange(
			deps,
			live(COMMUNITY, tidAt(sent, "import"), tidAt(NOW, "rev"), {
				createdAt: sent,
				bridged: {
					registration: "3lkbridgeaaaa",
					platform: "chat",
					remoteId: "alice-1",
					name: "Alice",
					imported: true,
				},
			}),
		);

		expect(skipped).toEqual([]);
		expect(await messageRows()).toHaveLength(1);
	});

	it("applies the past bound to an import marker a member wrote themselves", async () => {
		const sent = hoursFromNow(-24 * 365);
		await applyChange(
			deps,
			live(MEMBER, tidAt(sent, "import"), tidAt(NOW, "rev"), {
				createdAt: sent,
				bridged: {
					registration: "3lkbridgeaaaa",
					platform: "chat",
					remoteId: "alice-1",
					name: "Alice",
					imported: true,
				},
			}),
		);

		expect(await messageRows()).toHaveLength(0);
		expect(skipped[0]?.reason).toBe("message record key is more than a day older than its commit");
	});

	it("refuses a future bridge import", async () => {
		const sent = "2028-01-01T00:00:00.000Z";
		await applyChange(
			deps,
			live(COMMUNITY, tidAt(sent, "import"), tidAt(NOW, "rev"), {
				createdAt: sent,
				bridged: {
					registration: "3lkbridgeaaaa",
					platform: "chat",
					remoteId: "alice-1",
					name: "Alice",
					imported: true,
				},
			}),
		);

		expect(await messageRows()).toHaveLength(0);
		expect(skipped[0]?.reason).toBe("message record key is dated in the future");
	});
});

describe("member-written collections", () => {
	it("accepts a message from any member of the channel space", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3mry5ybrkzc22", {
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
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3mry5ybrowc22", {
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

	it("stores a forwarded snapshot whole, blob refs included", async () => {
		const source = {
			space: channelSpace(COMMUNITY, "social.colibri.beta.channel.text", "3lkchannel2"),
			did: OUTSIDER,
			rkey: "3mry5ybrqus22",
			cid: PICTURE_CID,
		};

		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3mry5ybrpvk22", {
				$type: "social.colibri.beta.message",
				text: "worth reading",
				createdAt: NOW,
				forward: {
					source,
					createdAt: NOW,
					text: "the original",
					attachments: [{ name: "shot.png", blob: jsonBlob(PICTURE_CID) }],
				},
			}),
		);

		expect(skipped).toEqual([]);
		const [row] = await database.db.select().from(database.tables.messages);
		expect(row?.text).toBe("worth reading");
		expect(row?.forward).toEqual({
			source,
			createdAt: NOW,
			text: "the original",
			attachments: [{ name: "shot.png", blob: jsonBlob(PICTURE_CID) }],
		});
	});

	it("keeps a reply pointing at both the author and the key of its parent", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3mry5ybrlyk22", {
				$type: "social.colibri.beta.message",
				text: "replying",
				createdAt: NOW,
				parent: { did: OUTSIDER, rkey: "3mry5ybrkzc22" },
			}),
		);

		const [row] = await database.db.select().from(database.tables.messages);
		expect(row?.parentAuthor).toBe(OUTSIDER);
		expect(row?.parentRkey).toBe("3mry5ybrkzc22");
	});

	it("refuses a message that does not match its lexicon", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3mry5ybrmxs22", {
				$type: "social.colibri.beta.message",
				createdAt: NOW,
			}),
		);
		expect(await database.db.select().from(database.tables.messages)).toEqual([]);
		expect(skipped[0]?.reason).toMatch(/text/);
	});

	it("accepts a message written into a voice channel space", async () => {
		const voice = channelSpace(COMMUNITY, "social.colibri.beta.channel.voice", "3lkvoice1");
		await applyChange(
			deps,
			put(voice, MEMBER, "social.colibri.beta.message", "3mry5ybrnx222", {
				$type: "social.colibri.beta.message",
				text: "can you hear me",
				createdAt: NOW,
			}),
		);
		const [row] = await database.db.select().from(database.tables.messages);
		expect(row).toMatchObject({ space: voice, author: MEMBER, text: "can you hear me" });
		expect(skipped).toEqual([]);
	});

	it("accepts a reaction written into a voice channel space", async () => {
		const voice = channelSpace(COMMUNITY, "social.colibri.beta.channel.voice", "3lkvoice1");
		await applyChange(
			deps,
			put(voice, MEMBER, "social.colibri.beta.reaction", "3lkreact4", {
				$type: "social.colibri.beta.reaction",
				target: { did: MEMBER, rkey: "3mry5ybrnx222" },
				emoji: "👍",
			}),
		);
		const [row] = await database.db.select().from(database.tables.reactions);
		expect(row).toMatchObject({
			space: voice,
			author: MEMBER,
			targetRkey: "3mry5ybrnx222",
			emoji: "👍",
		});
		expect(skipped).toEqual([]);
	});

	it("refuses a thread follow written into a voice channel space", async () => {
		const voice = channelSpace(COMMUNITY, "social.colibri.beta.channel.voice", "3lkvoice1");
		await applyChange(
			deps,
			put(voice, MEMBER, "social.colibri.beta.thread.follow", "self", {
				$type: "social.colibri.beta.thread.follow",
				createdAt: NOW,
			}),
		);
		expect(skipped[0]?.reason).toMatch(/not expected/);
	});

	it("removes a message on delete", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3mry5ybrkzc22", {
				$type: "social.colibri.beta.message",
				text: "hello",
				createdAt: NOW,
			}),
		);
		await applyChange(deps, {
			space: TEXT_CHANNEL,
			author: MEMBER,
			puts: [],
			deletes: [{ collection: "social.colibri.beta.message", rkey: "3mry5ybrkzc22" }],
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
				subject: { did: MEMBER, collection: "social.colibri.beta.message", rkey: "3mry5ybrkzc22" },
				val: "hidden",
				createdAt: NOW,
			}),
		);

		const [row] = await database.db.select().from(database.tables.labels);
		expect(row?.src).toBe(COMMUNITY);
		expect(row?.val).toBe("hidden");
		expect(row?.subjectRkey).toBe("3mry5ybrkzc22");
	});

	it("accepts a label from a third-party labeler, leaving trust to the reader", async () => {
		await applyChange(
			deps,
			put(TEXT_CHANNEL, OUTSIDER, "social.colibri.beta.label", "3lklabel2", {
				$type: "social.colibri.beta.label",
				subject: { did: MEMBER, collection: "social.colibri.beta.message", rkey: "3mry5ybrkzc22" },
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

	it("projects an emoji follow and removes it on delete", async () => {
		const subject = `at://${OUTSIDER}/blue.moji.packs.pack/3lkpack1`;
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.emoji.follow", "3lkfollow1", {
				$type: "social.colibri.beta.emoji.follow",
				subject,
				createdAt: NOW,
			}),
		);

		const rows = await database.db.select().from(database.tables.emojiFollows);
		expect(rows).toEqual([
			{ follower: MEMBER, rkey: "3lkfollow1", subject, subjectOwner: OUTSIDER, createdAt: NOW },
		]);

		await applyChange(deps, {
			space: personal,
			author: MEMBER,
			puts: [],
			deletes: [{ collection: "social.colibri.beta.emoji.follow", rkey: "3lkfollow1" }],
		});
		expect(await database.db.select().from(database.tables.emojiFollows)).toEqual([]);
	});

	it("ignores an emoji follow of the author's own repo", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.emoji.follow", "3lkfollow2", {
				$type: "social.colibri.beta.emoji.follow",
				subject: `at://${MEMBER}/blue.moji.collection.item/wave`,
				createdAt: NOW,
			}),
		);

		expect(await database.db.select().from(database.tables.emojiFollows)).toEqual([]);
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

	it("keeps the newest read cursor per channel across record writes", async () => {
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
		await write([
			{ channel: "3lkchannel1", cursor: "3lkaaaaaaaaa4" },
			{ channel: "3lkchannel2", cursor: "3lkaaaaaaaaa1" },
		]);

		const rows = await database.db
			.select({
				channel: database.tables.readCursors.channel,
				cursor: database.tables.readCursors.cursor,
			})
			.from(database.tables.readCursors)
			.where(eq(database.tables.readCursors.did, MEMBER));
		expect(rows.sort((a, b) => a.channel.localeCompare(b.channel))).toEqual([
			{ channel: "3lkchannel1", cursor: "3lkaaaaaaaaa7" },
			{ channel: "3lkchannel2", cursor: "3lkaaaaaaaaa3" },
		]);
	});

	it("drops a community's read cursors when its record is deleted", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.channel.read", COMMUNITY, {
				$type: "social.colibri.beta.channel.read",
				community: COMMUNITY,
				cursors: [{ channel: "3lkchannel1", cursor: "3lkaaaaaaaaa2" }],
			}),
		);
		await applyChange(deps, {
			space: personal,
			author: MEMBER,
			puts: [],
			deletes: [{ collection: "social.colibri.beta.channel.read", rkey: COMMUNITY }],
		});

		expect(
			await database.db
				.select()
				.from(database.tables.readCursors)
				.where(eq(database.tables.readCursors.did, MEMBER)),
		).toEqual([]);
	});

	const remove = (collection: string, rkey: string): SpaceChange => ({
		space: personal,
		author: MEMBER,
		puts: [],
		deletes: [{ collection, rkey }],
	});

	const settingsRow = async () => {
		const [row] = await database.db
			.select()
			.from(database.tables.actorSettings)
			.where(eq(database.tables.actorSettings.did, MEMBER));
		return row;
	};

	it("projects a thread mute as the thread's space reference", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.mute", "3lkmute3", {
				$type: "social.colibri.beta.actor.mute",
				subject: { $type: "social.colibri.beta.actor.defs#mutedThread", thread: THREAD },
				createdAt: NOW,
			}),
		);

		const [row] = await database.db.select().from(database.tables.mutes);
		expect(row?.subject).toBe(THREAD);
	});

	it("projects client preferences next to the settings without touching them", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.settings", SELF, {
				$type: "social.colibri.beta.actor.settings",
				notificationLevel: "nothing",
			}),
		);
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.clientPreferences", SELF, {
				$type: "social.colibri.beta.actor.clientPreferences",
				controls: {
					$type: "social.colibri.beta.actor.defs#controls",
					swipeLeftAction: "reply",
					doubleTapEnabled: true,
				},
				theme: "light",
				developerMode: true,
				hideModeratedMessages: true,
				inboxPresentation: "modal",
				experiments: ["light-mode-v1"],
				dismissedLegacyCommunities: ["did:plc:legacyxxxxxxxxxxxxxxxxxxx"],
			}),
		);

		const row = await settingsRow();
		expect(row?.notificationLevel).toBe("nothing");
		expect(row?.clientPreferences).toEqual({
			controls: { swipeLeftAction: "reply", doubleTapEnabled: true },
			theme: "light",
			developerMode: true,
			hideModeratedMessages: true,
			inboxPresentation: "modal",
			experiments: ["light-mode-v1"],
			dismissedLegacyCommunities: ["did:plc:legacyxxxxxxxxxxxxxxxxxxx"],
		});
	});

	it("keeps client preferences when the settings record is deleted", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.clientPreferences", SELF, {
				$type: "social.colibri.beta.actor.clientPreferences",
				messagePreviews: false,
			}),
		);
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.settings", SELF, {
				$type: "social.colibri.beta.actor.settings",
				shareActivity: true,
			}),
		);
		await applyChange(deps, remove("social.colibri.beta.actor.settings", SELF));

		const row = await settingsRow();
		expect(row?.shareActivity).toBe(false);
		expect(row?.clientPreferences).toEqual({ messagePreviews: false });
	});

	it("projects composer state and clears it on delete", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.composerState", SELF, {
				$type: "social.colibri.beta.actor.composerState",
				emojiUsage: [{ emoji: "🐦", count: 3, lastUsed: NOW }],
				skinTone: 2,
				recentGifs: [
					{
						$type: "social.colibri.beta.embed.defs#gifView",
						id: "https://cdn.test/bird.gif",
						url: "https://cdn.test/bird.gif",
						previewUrl: "https://cdn.test/bird-small.gif",
						width: 200,
						height: 100,
					},
				],
			}),
		);

		expect((await settingsRow())?.composerState).toEqual({
			emojiUsage: [{ emoji: "🐦", count: 3, lastUsed: NOW }],
			skinTone: 2,
			recentGifs: [
				{
					id: "https://cdn.test/bird.gif",
					url: "https://cdn.test/bird.gif",
					previewUrl: "https://cdn.test/bird-small.gif",
					width: 200,
					height: 100,
				},
			],
		});

		await applyChange(deps, remove("social.colibri.beta.actor.composerState", SELF));
		expect((await settingsRow())?.composerState).toEqual({});
	});

	it("projects a Space notification level keyed by the community and removes it on delete", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.spaceNotification", COMMUNITY, {
				$type: "social.colibri.beta.actor.spaceNotification",
				level: "mentionsAndReplies",
				createdAt: NOW,
			}),
		);

		expect(await database.db.select().from(database.tables.spaceNotifications)).toEqual([
			{ did: MEMBER, community: COMMUNITY, level: "mentionsAndReplies" },
		]);

		await applyChange(deps, remove("social.colibri.beta.actor.spaceNotification", COMMUNITY));
		expect(await database.db.select().from(database.tables.spaceNotifications)).toEqual([]);
	});

	it("refuses a Space notification level whose key is not a DID", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.spaceNotification", "3lknotadid", {
				$type: "social.colibri.beta.actor.spaceNotification",
				level: "nothing",
				createdAt: NOW,
			}),
		);

		expect(await database.db.select().from(database.tables.spaceNotifications)).toEqual([]);
	});

	it("projects a Space moderation option keyed by the community and removes it on delete", async () => {
		await applyChange(
			deps,
			put(personal, MEMBER, "social.colibri.beta.actor.spaceModeration", COMMUNITY, {
				$type: "social.colibri.beta.actor.spaceModeration",
				hideModeratedMessages: true,
				createdAt: NOW,
			}),
		);

		expect(await database.db.select().from(database.tables.spaceModerations)).toEqual([
			{ did: MEMBER, community: COMMUNITY, hideModeratedMessages: true },
		]);

		await applyChange(deps, remove("social.colibri.beta.actor.spaceModeration", COMMUNITY));
		expect(await database.db.select().from(database.tables.spaceModerations)).toEqual([]);
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
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.message", "3mry5ybrkzc22", {
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
			{ ...deps, now: () => later },
			put(THREAD, MEMBER, "social.colibri.beta.message", "3mry5ybrk2222", {
				$type: "social.colibri.beta.message",
				text: "over here",
				createdAt: later,
			}),
		);

		const [row] = await threadRows();
		expect(row?.lastActivityAt).toBe(later);
	});

	it("keeps a thread's last activity at the server clock for a message a few minutes ahead", async () => {
		const later = "2026-08-24T00:00:00.000Z";
		await applyChange(deps, put(THREAD, COMMUNITY, "social.colibri.beta.thread", SELF, record()));
		await applyChange(
			{ ...deps, now: () => later },
			put(THREAD, MEMBER, "social.colibri.beta.message", tidAt(later, "a"), {
				$type: "social.colibri.beta.message",
				text: "fast clock",
				createdAt: new Date(Date.parse(later) + 10 * 60 * 1000).toISOString(),
			}),
		);

		const [row] = await threadRows();
		expect(row?.lastActivityAt).toBe(later);
	});

	it("keeps a thread's last activity at the server clock for a thread record dated ahead", async () => {
		await applyChange(
			deps,
			put(
				THREAD,
				COMMUNITY,
				"social.colibri.beta.thread",
				SELF,
				record({ createdAt: "2030-01-01T00:00:00.000Z" }),
			),
		);

		const [row] = await threadRows();
		expect(row?.lastActivityAt).toBe(NOW);
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

describe("message edits written without updatedAt", () => {
	const RKEY = tidAt("2026-08-22T23:00:00.000Z", "edit");
	const EDIT_REV = tidAt("2026-08-22T23:30:00.000Z", "rev");
	const EDITED_AT = new Date(tidTime(EDIT_REV) as number).toISOString();

	const messagePut = (value: Record<string, unknown>, rev?: string): SpaceChange => ({
		space: TEXT_CHANNEL,
		author: MEMBER,
		puts: [
			{
				collection: "social.colibri.beta.message",
				rkey: RKEY,
				cid: "bafytest",
				value: { $type: "social.colibri.beta.message", createdAt: NOW, ...value },
				...(rev ? { rev } : {}),
			},
		],
		deletes: [],
	});

	const storedUpdatedAt = async () => {
		const [row] = await database.db
			.select({ updatedAt: database.tables.messages.updatedAt })
			.from(database.tables.messages)
			.where(eq(database.tables.messages.rkey, RKEY));
		return row?.updatedAt;
	};

	it("leaves a new message unedited", async () => {
		await applyChange(deps, messagePut({ text: "hello" }, EDIT_REV));

		expect(await storedUpdatedAt()).toBeNull();
	});

	it("marks a changed text as edited at the commit time", async () => {
		await applyChange(deps, messagePut({ text: "hello" }));
		await applyChange(deps, messagePut({ text: "hello there" }, EDIT_REV));

		expect(await storedUpdatedAt()).toBe(EDITED_AT);
	});

	it("falls back to the current time without a commit rev", async () => {
		await applyChange(deps, messagePut({ text: "hello" }));
		await applyChange(
			deps,
			messagePut({ text: "hello", suppressedEmbeds: ["https://example.com/"] }),
		);

		expect(await storedUpdatedAt()).toBe(NOW);
	});

	it("keeps the stored edit time when the same record replays", async () => {
		await applyChange(deps, messagePut({ text: "hello" }));
		await applyChange(deps, messagePut({ text: "hello there" }, EDIT_REV));
		await applyChange(deps, messagePut({ text: "hello there" }, tidAt(NOW, "replay")));

		expect(await storedUpdatedAt()).toBe(EDITED_AT);
	});

	it("leaves an unchanged replay of an unedited message unedited", async () => {
		await applyChange(deps, messagePut({ text: "hello" }));
		await applyChange(deps, messagePut({ text: "hello" }, EDIT_REV));

		expect(await storedUpdatedAt()).toBeNull();
	});

	it("keeps the updatedAt a client writes", async () => {
		await applyChange(deps, messagePut({ text: "hello" }));
		await applyChange(deps, messagePut({ text: "hello!", updatedAt: NOW }, EDIT_REV));

		expect(await storedUpdatedAt()).toBe(NOW);
	});
});

describe("duplicate reaction records", () => {
	const TARGET = { did: COMMUNITY, rkey: "3lkmessage1" };
	const FIRST = "3lkreactfirst";
	const SECOND = "3lkreactsecond";

	const reactionValue = (emoji = "👍") => ({
		$type: "social.colibri.beta.reaction",
		target: TARGET,
		emoji,
	});

	const mirror = (rkey: string, value: Record<string, unknown>) =>
		database.db.insert(database.tables.records).values({
			space: TEXT_CHANNEL,
			author: MEMBER,
			collection: "social.colibri.beta.reaction",
			rkey,
			cid: "bafytest",
			value,
			indexedAt: NOW,
		});

	const unmirror = (rkey: string) =>
		database.db.delete(database.tables.records).where(eq(database.tables.records.rkey, rkey));

	const remove = (rkey: string): SpaceChange => ({
		space: TEXT_CHANNEL,
		author: MEMBER,
		puts: [],
		deletes: [{ collection: "social.colibri.beta.reaction", rkey }],
	});

	const storedKeys = async () =>
		(await database.db.select().from(database.tables.reactions)).map((row) => row.rkey);

	beforeEach(async () => {
		for (const rkey of [FIRST, SECOND]) {
			await mirror(rkey, reactionValue());
			await applyChange(
				deps,
				put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.reaction", rkey, reactionValue()),
			);
		}
	});

	it("keeps one row that points at the newest record", async () => {
		expect(await storedKeys()).toEqual([SECOND]);
	});

	it("falls back to the other record when the stored one is deleted", async () => {
		await unmirror(SECOND);
		await applyChange(deps, remove(SECOND));

		expect(await storedKeys()).toEqual([FIRST]);
	});

	it("keeps the reaction when the record that is not stored is deleted", async () => {
		await unmirror(FIRST);
		await applyChange(deps, remove(FIRST));

		expect(await storedKeys()).toEqual([SECOND]);
	});

	it("drops the reaction once both records are deleted", async () => {
		await unmirror(SECOND);
		await applyChange(deps, remove(SECOND));
		await unmirror(FIRST);
		await applyChange(deps, remove(FIRST));

		expect(await storedKeys()).toEqual([]);
	});

	it("updates the stored row when the same record changes", async () => {
		await database.db
			.update(database.tables.records)
			.set({ value: reactionValue("🎉") })
			.where(eq(database.tables.records.rkey, SECOND));
		await applyChange(
			deps,
			put(TEXT_CHANNEL, MEMBER, "social.colibri.beta.reaction", SECOND, reactionValue("🎉")),
		);

		const rows = await database.db.select().from(database.tables.reactions);
		expect(rows.map((row) => [row.rkey, row.emoji]).sort()).toEqual([
			[FIRST, "👍"],
			[SECOND, "🎉"],
		]);
	});
});
