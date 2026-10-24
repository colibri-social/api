import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { COLLECTIONS, LEGACY_COLLECTIONS, SPACE_TYPES, spaceUri } from "@colibri-social/lexicons";
import type { PdsClient } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommunityCredentials } from "./credentials.js";
import {
	activeBans,
	categoryChannelOrder,
	channelSpaceFor,
	legacyChannelRkey,
	legacyMessageRows,
	MIGRATION_STEPS,
	type MigrationStep,
	migrateCommunity,
	rewriteLegacyFacets,
} from "./migrate.js";
import type { SpaceRegistry } from "./spaces.js";
import type { CommunityWriter } from "./writes.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxx";
const ADMIN = "did:plc:adminxxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxx";
const BANNED = "did:plc:bannedxxxxxxxxxxxxxxxxxxx";
const OUTSIDER = "did:plc:outsiderxxxxxxxxxxxxxxxxx";

const TEXT = "3lkchantext01";
const VOICE = "3lkchanvoice1";
const CATEGORY = "3lkcategory01";

const legacy = (did: string, collection: string, rkey: string, value: Record<string, unknown>) => ({
	uri: `at://${did}/${collection}/${rkey}`,
	cid: "bafy",
	value,
});

describe("migration steps", () => {
	it("runs in order and finishes on done", () => {
		expect(MIGRATION_STEPS.at(0)).toBe("readingLegacyRepo");
		expect(MIGRATION_STEPS.at(-1)).toBe("done");
		expect(new Set(MIGRATION_STEPS).size).toBe(MIGRATION_STEPS.length);
	});

	it("retires the legacy community only after every other write", () => {
		expect(MIGRATION_STEPS.at(-2)).toBe("retiringLegacyCommunity");
	});
});

describe("activeBans", () => {
	it("keeps the latest ban or unban per subject", () => {
		const records = [
			legacy(COMMUNITY, LEGACY_COLLECTIONS.moderation, "3lk001", {
				action: "ban",
				subject: { did: BANNED },
				createdAt: "2026-01-01T00:00:00Z",
			}),
			legacy(COMMUNITY, LEGACY_COLLECTIONS.moderation, "3lk002", {
				action: "ban",
				subject: { did: MEMBER },
				createdAt: "2026-01-02T00:00:00Z",
			}),
			legacy(COMMUNITY, LEGACY_COLLECTIONS.moderation, "3lk003", {
				action: "unban",
				subject: { did: MEMBER },
				createdAt: "2026-01-03T00:00:00Z",
			}),
			legacy(COMMUNITY, LEGACY_COLLECTIONS.moderation, "3lk004", {
				action: "kick",
				subject: { did: OUTSIDER },
				createdAt: "2026-01-04T00:00:00Z",
			}),
		];

		expect(activeBans(records).map((record) => record.value.subject?.did)).toEqual([BANNED]);
	});
});

describe("legacyChannelRkey", () => {
	it("accepts a bare rkey and a channel URI in this community", () => {
		expect(legacyChannelRkey(COMMUNITY, TEXT)).toBe(TEXT);
		expect(
			legacyChannelRkey(COMMUNITY, `at://${COMMUNITY}/${LEGACY_COLLECTIONS.channel}/${TEXT}`),
		).toBe(TEXT);
	});

	it("rejects a channel in another community", () => {
		expect(
			legacyChannelRkey(COMMUNITY, `at://${OUTSIDER}/${LEGACY_COLLECTIONS.channel}/${TEXT}`),
		).toBeUndefined();
		expect(legacyChannelRkey(COMMUNITY, undefined)).toBeUndefined();
	});
});

describe("channelSpaceFor", () => {
	it("keeps the legacy rkey as the space key and picks the space type", () => {
		expect(
			channelSpaceFor(
				COMMUNITY,
				legacy(COMMUNITY, LEGACY_COLLECTIONS.channel, VOICE, {
					type: "social.colibri.channel.voice",
				}),
			),
		).toBe(spaceUri(COMMUNITY, SPACE_TYPES.channelVoice, VOICE));
		expect(
			channelSpaceFor(COMMUNITY, legacy(COMMUNITY, LEGACY_COLLECTIONS.channel, TEXT, {})),
		).toBe(spaceUri(COMMUNITY, SPACE_TYPES.channelText, TEXT));
	});
});

describe("rewriteLegacyFacets", () => {
	const textSpace = spaceUri(COMMUNITY, SPACE_TYPES.channelText, TEXT);
	const spaces = new Map([[TEXT, textSpace]]);

	it("moves features onto the beta facet types and remaps channel links", () => {
		const facets = [
			{
				$type: "social.colibri.richtext.facet",
				index: { byteStart: 0, byteEnd: 4 },
				features: [
					{ $type: "social.colibri.richtext.facet#bold" },
					{ $type: "social.colibri.richtext.facet#channel", channel: TEXT },
				],
			},
		];

		expect(rewriteLegacyFacets(facets, COMMUNITY, spaces)).toEqual([
			{
				$type: "social.colibri.beta.richtext.facet",
				index: { byteStart: 0, byteEnd: 4 },
				features: [
					{ $type: "social.colibri.beta.richtext.facet#bold" },
					{ $type: "social.colibri.beta.richtext.facet#channel", channel: textSpace },
				],
			},
		]);
	});

	it("drops the Bluesky type on the index and keeps Bluesky links and mentions", () => {
		const facets = [
			{
				$type: "social.colibri.richtext.facet",
				index: { $type: "app.bsky.richtext.facet#byteSlice", byteStart: 0, byteEnd: 18 },
				features: [
					{ $type: "social.colibri.richtext.facet#heading", level: 1 },
					{ $type: "app.bsky.richtext.facet#link", uri: "https://colibri.social" },
					{ $type: "app.bsky.richtext.facet#tag", tag: "birds" },
				],
			},
		];

		expect(rewriteLegacyFacets(facets, COMMUNITY, spaces)).toEqual([
			{
				$type: "social.colibri.beta.richtext.facet",
				index: { byteStart: 0, byteEnd: 18 },
				features: [
					{ $type: "social.colibri.beta.richtext.facet#heading", level: 1 },
					{ $type: "social.colibri.beta.richtext.facet#link", uri: "https://colibri.social" },
				],
			},
		]);
	});

	it("drops channel links it cannot place and facets left empty", () => {
		const facets = [
			{
				index: { byteStart: 0, byteEnd: 4 },
				features: [{ $type: "social.colibri.richtext.facet#channel", channel: "3lkmissing001" }],
			},
		];

		expect(rewriteLegacyFacets(facets, COMMUNITY, spaces)).toBeNull();
	});
});

describe("legacyMessageRows", () => {
	const textSpace = spaceUri(COMMUNITY, SPACE_TYPES.channelText, TEXT);
	const spaces = new Map([[TEXT, textSpace]]);

	it("places messages in their channel space and resolves reply authors", () => {
		const rows = legacyMessageRows(
			COMMUNITY,
			[
				{
					author: ADMIN,
					record: legacy(ADMIN, LEGACY_COLLECTIONS.message, "3lkmsg0000001", {
						text: "hello",
						channel: TEXT,
						createdAt: "2026-01-01T00:00:00Z",
					}),
				},
				{
					author: MEMBER,
					record: legacy(MEMBER, LEGACY_COLLECTIONS.message, "3lkmsg0000002", {
						text: "hi back",
						channel: TEXT,
						parent: "3lkmsg0000001",
						createdAt: "2026-01-01T00:01:00Z",
					}),
				},
				{
					author: MEMBER,
					record: legacy(MEMBER, LEGACY_COLLECTIONS.message, "3lkmsg0000003", {
						text: "elsewhere",
						channel: "3lkotherchan1",
						createdAt: "2026-01-01T00:02:00Z",
					}),
				},
			],
			spaces,
			"2026-10-22T00:00:00Z",
		);

		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			space: textSpace,
			author: MEMBER,
			rkey: "3lkmsg0000002",
			parentAuthor: ADMIN,
			parentRkey: "3lkmsg0000001",
			fromLegacyRepo: true,
		});
	});

	it("drops a reply link whose parent is not in the mirrored history", () => {
		const [row] = legacyMessageRows(
			COMMUNITY,
			[
				{
					author: MEMBER,
					record: legacy(MEMBER, LEGACY_COLLECTIONS.message, "3lkmsg0000004", {
						text: "orphan",
						channel: TEXT,
						parent: "3lkgone000001",
						createdAt: "2026-01-01T00:00:00Z",
					}),
				},
			],
			spaces,
			"2026-10-22T00:00:00Z",
		);

		expect(row).toMatchObject({ parentAuthor: null, parentRkey: null });
	});
	it("leaves out messages dated ahead of the import", () => {
		const rows = legacyMessageRows(
			COMMUNITY,
			[
				{
					author: MEMBER,
					record: legacy(MEMBER, LEGACY_COLLECTIONS.message, "3lkmsg0000005", {
						text: "from the future",
						channel: TEXT,
						createdAt: "2026-10-22T01:00:00Z",
					}),
				},
				{
					author: MEMBER,
					record: legacy(MEMBER, LEGACY_COLLECTIONS.message, "3lkmsg0000006", {
						text: "a little early",
						channel: TEXT,
						createdAt: "2026-10-22T00:10:00Z",
					}),
				},
			],
			spaces,
			"2026-10-22T00:00:00Z",
		);

		expect(rows.map((row) => row.rkey)).toEqual(["3lkmsg0000006"]);
	});
});

describe("categoryChannelOrder", () => {
	it("keeps the stored order and appends channels that only name the category", () => {
		const channels = [
			legacy(COMMUNITY, LEGACY_COLLECTIONS.channel, TEXT, { category: CATEGORY }),
			legacy(COMMUNITY, LEGACY_COLLECTIONS.channel, VOICE, { category: CATEGORY }),
		];

		expect(categoryChannelOrder(CATEGORY, [VOICE, "3lkdeleted001"], channels)).toEqual([
			VOICE,
			TEXT,
		]);
	});
});

describe("migrateCommunity", () => {
	let database: TestDatabase;

	type Write = { space: string; collection: string; rkey: string };

	const repos = new Map<string, Map<string, ReturnType<typeof legacy>[]>>();
	const seed = (did: string, collection: string, rkey: string, value: Record<string, unknown>) => {
		const repo = repos.get(did) ?? new Map();
		repos.set(did, repo);
		repo.set(collection, [...(repo.get(collection) ?? []), legacy(did, collection, rkey, value)]);
	};

	const client = {
		service: "https://pds.test",
		getPublicRecord: async (repo: string, collection: string, rkey: string) => {
			const found = repos
				.get(repo)
				?.get(collection)
				?.find((record) => record.uri.endsWith(`/${rkey}`));
			if (!found) throw new Error("not found");
			return found;
		},
		xrpc: {
			query: async (_method: string, params: { repo: string; collection: string }) => ({
				records: repos.get(params.repo)?.get(params.collection) ?? [],
			}),
		},
	};

	const harness = (failOn?: (write: Write) => boolean) => {
		const writes: Write[] = [];
		const createdSpaces: string[] = [];
		const repoWrites: Array<Record<string, unknown>> = [];
		const host = {
			session: {},
			pds: {
				service: "https://pds.test",
				createSpace: async (_session: unknown, input: { spaceType: string; skey: string }) => {
					createdSpaces.push(`${input.spaceType}/${input.skey}`);
				},
				putRepoRecord: async (_session: unknown, write: { record: Record<string, unknown> }) => {
					repoWrites.push(write.record);
				},
			},
		};
		const deps = {
			database,
			hostFor: async () => "https://pds.test",
			credentials: {
				connect: async () => host,
				clientFor: () => client as unknown as PdsClient,
			} as unknown as CommunityCredentials,
			writer: {
				put: async (_community: string, write: Write) => {
					if (failOn?.(write)) throw new Error("PDS unavailable");
					writes.push({ space: write.space, collection: write.collection, rkey: write.rkey });
					return { rkey: write.rkey };
				},
			} as unknown as CommunityWriter,
			spaces: { register: async () => undefined } as unknown as SpaceRegistry,
			appviewService: "did:web:appview.test#colibri_appview",
			log: () => undefined,
		};
		return { deps, writes, createdSpaces, repoWrites };
	};

	beforeEach(async () => {
		database = await openTestDatabase();
		repos.clear();
		seed(COMMUNITY, LEGACY_COLLECTIONS.community, "self", { name: "Flock", categoryOrder: [] });
		seed(COMMUNITY, LEGACY_COLLECTIONS.role, "3lkroleowner1", { name: "Owner", protected: true });
		seed(COMMUNITY, LEGACY_COLLECTIONS.member, "3lkmember0001", {
			subject: ADMIN,
			roles: ["3lkroleowner1"],
		});
		seed(COMMUNITY, LEGACY_COLLECTIONS.member, "3lkmember0002", { subject: MEMBER, roles: [] });
		seed(COMMUNITY, LEGACY_COLLECTIONS.member, "3lkmember0003", { subject: BANNED, roles: [] });
		seed(COMMUNITY, LEGACY_COLLECTIONS.moderation, "3lkmod0000001", {
			action: "ban",
			subject: { did: BANNED },
			createdBy: ADMIN,
			createdAt: "2026-01-01T00:00:00Z",
		});
		seed(COMMUNITY, LEGACY_COLLECTIONS.channel, TEXT, { name: "general", category: CATEGORY });
		seed(COMMUNITY, LEGACY_COLLECTIONS.category, CATEGORY, { name: "Chat", channelOrder: [TEXT] });
		seed(MEMBER, LEGACY_COLLECTIONS.message, "3lkmsg0000001", {
			text: "hello",
			channel: TEXT,
			createdAt: "2026-01-01T00:00:00Z",
		});
		seed(BANNED, LEGACY_COLLECTIONS.message, "3lkmsg0000002", {
			text: "spam",
			channel: TEXT,
			createdAt: "2026-01-01T00:00:00Z",
		});
	});

	afterEach(async () => {
		await database.destroy();
	});

	it("copies structure, skips banned members, mirrors history and retires the legacy record", async () => {
		const { deps, writes, repoWrites } = harness();

		const report = await migrateCommunity(deps, COMMUNITY);

		expect(report).toMatchObject({ members: 2, bans: 1, channels: 1, legacyMessages: 1 });
		expect(writes.filter((write) => write.collection === COLLECTIONS.member)).toEqual([
			expect.objectContaining({ rkey: ADMIN }),
			expect.objectContaining({ rkey: MEMBER }),
		]);
		expect(writes).toContainEqual(
			expect.objectContaining({ collection: COLLECTIONS.moderation, rkey: "3lkmod0000001" }),
		);
		expect(repoWrites).toEqual([
			expect.objectContaining({ name: "Flock", migratedTo: expect.stringContaining(COMMUNITY) }),
		]);

		const messages = await database.db.select().from(database.tables.messages);
		expect(messages).toEqual([
			expect.objectContaining({
				author: MEMBER,
				space: spaceUri(COMMUNITY, SPACE_TYPES.channelText, TEXT),
				fromLegacyRepo: true,
			}),
		]);
	});

	it("builds the Space under a new account and leaves the legacy record alone", async () => {
		const NEW = "did:plc:newaccountxxxxxxxxxxxxxxx";
		const { deps, writes, repoWrites, createdSpaces } = harness();

		await migrateCommunity({ ...deps, target: NEW }, COMMUNITY);

		expect(repoWrites).toEqual([]);
		expect(writes.every((write) => write.space.startsWith(`at://${NEW}/`))).toBe(true);
		expect(createdSpaces).toContain(`${SPACE_TYPES.channelText}/${TEXT}`);
		const messages = await database.db.select().from(database.tables.messages);
		expect(messages).toEqual([
			expect.objectContaining({
				community: NEW,
				space: spaceUri(NEW, SPACE_TYPES.channelText, TEXT),
				author: MEMBER,
			}),
		]);
	});

	it("resumes after a failure without redoing finished steps", async () => {
		const done = new Set<MigrationStep>();
		const failing = harness((write) => write.collection === COLLECTIONS.channel);
		await expect(
			migrateCommunity(
				{ ...failing.deps, completed: done, onStepDone: async (step) => void done.add(step) },
				COMMUNITY,
			),
		).rejects.toThrow("PDS unavailable");
		expect(done.has("migratingBans")).toBe(true);
		expect(done.has("migratingChannels")).toBe(false);

		const resumed = harness();
		await migrateCommunity(
			{ ...resumed.deps, completed: done, onStepDone: async (step) => void done.add(step) },
			COMMUNITY,
		);

		expect(resumed.writes.some((write) => write.collection === COLLECTIONS.member)).toBe(false);
		expect(resumed.writes.some((write) => write.collection === COLLECTIONS.channel)).toBe(true);
		expect(resumed.createdSpaces).toEqual([`${SPACE_TYPES.channelText}/${TEXT}`]);
		expect(done.has("retiringLegacyCommunity")).toBe(true);
	});
});
