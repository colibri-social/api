import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	COLLECTIONS,
	channelSpace,
	communitySpaces,
	SELF,
	SPACE_TYPES,
	threadSpace,
} from "@colibri-social/lexicons";
import { applyChange, type ProjectionDeps } from "@colibri-social/projections";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitCommunityWrites } from "./admission.js";
import { type BridgeFailure, type BridgeRegistration, Bridges } from "./bridges.js";
import type { CommunityCredentials } from "./credentials.js";
import { CommunityLoader } from "./loader.js";
import { CommunityWriter } from "./writes.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const ADMIN = "did:plc:adminxxxxxxxxxxxxxxxxxxxxxxx";
const BRIDGE = "did:plc:bridgexxxxxxxxxxxxxxxxxxxxxx";
const OTHER_BRIDGE = "did:plc:otherbridgexxxxxxxxxxxxxxxx";
const SPACES = communitySpaces(COMMUNITY);
const GENERAL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel001");
const RANDOM = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel002");
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxx";
const REMOTE = { platform: "chat", remoteSpace: "server-1", remoteSpaceName: "Server One" };
const ALICE = { id: "alice-1", name: "Alice" };
const BOB = { id: "bob-1", name: "Bob" };

let database: TestDatabase;
let bridges: Bridges;
let writer: CommunityWriter;
let clock: Date;

const fakeCredentials = (): CommunityCredentials => {
	const pds = {
		putRecord: async (_session: unknown, write: { collection: string; rkey: string }) => ({
			uri: `at://${COMMUNITY}/${write.collection}/${write.rkey}`,
			cid: `bafy${write.rkey}`,
		}),
		deleteRecord: async () => undefined,
		uploadBlob: async (_session: unknown, bytes: Uint8Array, mimeType: string) => ({
			blob: { $type: "blob", ref: { $link: "bafyblob" }, mimeType, size: bytes.byteLength },
		}),
	};
	return { connect: async () => ({ pds, session: {} }) } as unknown as CommunityCredentials;
};

const expectFailure = async (work: Promise<unknown>, failure: BridgeFailure) => {
	await expect(work).rejects.toMatchObject({ name: "BridgeError", failure });
};

type Limit = { capacity: number; refillPerSecond: number };

const createBridges = (rateLimit?: Limit, importRateLimit?: Limit) =>
	new Bridges({
		db: database.db,
		tables: database.tables,
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		writer,
		now: () => clock,
		...(rateLimit ? { rateLimit } : {}),
		...(importRateLimit ? { importRateLimit } : {}),
	});

const paired = async (): Promise<BridgeRegistration> => {
	const { code } = await bridges.createPairing(BRIDGE, REMOTE);
	return bridges.redeemPairing(COMMUNITY, ADMIN, code);
};

const linked = async (): Promise<BridgeRegistration> => {
	const registration = await paired();
	return bridges.update(
		{ community: COMMUNITY, registration: registration.id },
		{ links: [{ channel: GENERAL, remoteRoom: "room-1", remoteName: "general" }] },
	);
};

const keyOf = (registration: BridgeRegistration) => ({
	community: COMMUNITY,
	registration: registration.id,
});

const messages = () => database.db.select().from(database.tables.messages);
const reactions = () => database.db.select().from(database.tables.reactions);

beforeEach(async () => {
	database = await openTestDatabase();
	clock = new Date("2026-09-24T12:00:00.000Z");
	const projections: ProjectionDeps = {
		db: database.db,
		tables: database.tables,
		now: () => clock.toISOString(),
		admit: admitCommunityWrites(database.tables),
	};
	writer = new CommunityWriter({
		credentials: fakeCredentials(),
		mirror: { db: database.db, tables: database.tables, projections },
	});
	bridges = createBridges();

	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		handle: null,
		name: "Bridged",
		description: null,
		managingApp: null,
		pictureCid: null,
		bannerCid: null,
		labelers: [],
		migratedFrom: null,
		profileSpace: SPACES.profile,
		configSpace: SPACES.configuration,
		membersSpace: SPACES.members,
		moderationSpace: SPACES.moderation,
		indexedAt: clock.toISOString(),
	});
	for (const [space, name] of [
		[GENERAL, "general"],
		[RANDOM, "random"],
	] as const) {
		await applyChange(
			{ db: database.db, tables: database.tables, now: () => clock.toISOString() },
			{
				space,
				author: COMMUNITY,
				puts: [
					{
						collection: "social.colibri.beta.channel",
						rkey: SELF,
						cid: `bafychannel${name}`,
						value: { $type: "social.colibri.beta.channel", name },
					},
				],
				deletes: [],
			},
		);
	}
});

afterEach(async () => {
	await database.destroy();
});

describe("pairing", () => {
	it("registers a bridge with no links when an admin redeems its code", async () => {
		const registration = await paired();

		expect(registration).toMatchObject({
			community: COMMUNITY,
			bridge: BRIDGE,
			platform: "chat",
			remoteSpace: "server-1",
			remoteSpaceName: "Server One",
			links: [],
			enabled: true,
			createdBy: ADMIN,
		});
		expect(await bridges.registrationsHeldBy(BRIDGE)).toHaveLength(1);
	});

	it("accepts a code typed in lower case with separators", async () => {
		const { code } = await bridges.createPairing(BRIDGE, REMOTE);
		const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`;

		await expect(bridges.redeemPairing(COMMUNITY, ADMIN, typed)).resolves.toMatchObject({
			bridge: BRIDGE,
		});
	});

	it("refuses a code that was already used", async () => {
		const { code } = await bridges.createPairing(BRIDGE, REMOTE);
		await bridges.redeemPairing(COMMUNITY, ADMIN, code);

		await expectFailure(bridges.redeemPairing(COMMUNITY, ADMIN, code), "pairingNotFound");
	});

	it("refuses an expired code", async () => {
		const { code } = await bridges.createPairing(BRIDGE, REMOTE);
		clock = new Date(clock.getTime() + 11 * 60 * 1000);

		await expectFailure(bridges.pairing(code), "pairingNotFound");
	});

	it("refuses to connect the same remote space twice", async () => {
		await paired();
		const { code } = await bridges.createPairing(BRIDGE, REMOTE);

		await expectFailure(bridges.redeemPairing(COMMUNITY, ADMIN, code), "alreadyRegistered");
	});

	it("caps how many codes a bridge can hold open", async () => {
		for (let i = 0; i < 10; i++) await bridges.createPairing(BRIDGE, REMOTE);

		await expectFailure(bridges.createPairing(BRIDGE, REMOTE), "rateLimited");
	});
});

describe("links", () => {
	it("refuses a link to a channel the community does not have", async () => {
		const registration = await paired();
		const missing = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkmissing001");

		await expectFailure(
			bridges.update(keyOf(registration), {
				links: [{ channel: missing, remoteRoom: "room-9", remoteName: "gone" }],
			}),
			"channelNotFound",
		);
	});

	it("replaces the remote room list a bridge reports", async () => {
		const registration = await paired();
		await bridges.putRemoteRooms(BRIDGE, keyOf(registration), [
			{ id: "room-1", name: "general" },
			{ id: "room-2", name: "random", kind: "text", parent: "Chat" },
		]);
		await bridges.putRemoteRooms(BRIDGE, keyOf(registration), [{ id: "room-2", name: "random" }]);

		const rooms = await bridges.remoteRooms(keyOf(registration));
		expect(rooms.map((room) => room.remoteRoom)).toEqual(["room-2"]);
	});
});

describe("bridged messages", () => {
	it("writes a message as the community with the remote author attached", async () => {
		const registration = await linked();

		const { rkey } = await bridges.postMessage(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			author: ALICE,
			text: "hello from elsewhere",
			remoteMessage: "remote-msg-1",
		});

		const [row] = await messages();
		expect(row).toMatchObject({
			space: GENERAL,
			author: COMMUNITY,
			rkey,
			text: "hello from elsewhere",
			bridged: {
				registration: registration.id,
				platform: "chat",
				remoteId: "alice-1",
				name: "Alice",
				remoteMessage: "remote-msg-1",
			},
		});
	});

	it("refuses a channel that is not linked", async () => {
		const registration = await linked();

		await expectFailure(
			bridges.postMessage(BRIDGE, {
				...keyOf(registration),
				channel: RANDOM,
				author: ALICE,
				text: "wrong room",
			}),
			"channelNotLinked",
		);
		expect(await messages()).toEqual([]);
	});

	it("refuses a bridge writing through another bridge's registration", async () => {
		const registration = await linked();

		await expectFailure(
			bridges.postMessage(OTHER_BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				author: ALICE,
				text: "impostor",
			}),
			"forbidden",
		);
	});

	it("refuses writes while an admin has paused the registration", async () => {
		const registration = await linked();
		await bridges.update(keyOf(registration), { enabled: false });

		await expectFailure(
			bridges.postMessage(BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				author: ALICE,
				text: "paused",
			}),
			"disabled",
		);
	});

	it("keeps a future timestamp from moving a message ahead of now", async () => {
		const registration = await linked();

		await bridges.postMessage(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			author: ALICE,
			text: "from the future",
			createdAt: "2030-01-01T00:00:00.000Z",
		});

		const [row] = await messages();
		expect(row?.createdAt).toBe(clock.toISOString());
	});

	it("edits and deletes its own messages", async () => {
		const registration = await linked();
		const { rkey } = await bridges.postMessage(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			author: ALICE,
			text: "first",
		});

		await bridges.editMessage(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			rkey,
			text: "second",
		});
		const [edited] = await messages();
		expect(edited?.text).toBe("second");
		expect(edited?.updatedAt).toBe(clock.toISOString());
		expect(edited?.bridged?.remoteId).toBe("alice-1");

		await bridges.deleteMessage(BRIDGE, { ...keyOf(registration), channel: GENERAL, rkey });
		expect(await messages()).toEqual([]);
	});

	it("refuses to edit a community message that no bridge wrote", async () => {
		const registration = await linked();
		const { rkey } = await writer.put(COMMUNITY, {
			space: GENERAL,
			collection: "social.colibri.beta.message",
			record: {
				$type: "social.colibri.beta.message",
				text: "an announcement",
				createdAt: clock.toISOString(),
			},
		});

		await expectFailure(
			bridges.editMessage(BRIDGE, { ...keyOf(registration), channel: GENERAL, rkey, text: "x" }),
			"notBridged",
		);
	});

	it("stops accepting writes once the registration is revoked", async () => {
		const registration = await linked();
		await bridges.revoke(keyOf(registration));

		expect(await bridges.registrationsHeldBy(BRIDGE)).toEqual([]);
		await expectFailure(
			bridges.postMessage(BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				author: ALICE,
				text: "too late",
			}),
			"registrationNotFound",
		);
	});

	it("rate limits a registration that writes too quickly", async () => {
		bridges = createBridges({ capacity: 2, refillPerSecond: 0 });
		const registration = await linked();
		const post = () =>
			bridges.postMessage(BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				author: ALICE,
				text: "spam",
			});

		await post();
		await post();
		await expectFailure(post(), "rateLimited");
	});
});

describe("bridged reactions", () => {
	it("counts two remote people reacting with the same emoji separately", async () => {
		const registration = await linked();
		const { rkey } = await bridges.postMessage(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			author: ALICE,
			text: "react to me",
		});
		const target = { did: COMMUNITY, rkey };

		await bridges.addReaction(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			author: ALICE,
			target,
			emoji: "👍",
		});
		await bridges.addReaction(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			author: BOB,
			target,
			emoji: "👍",
		});

		const rows = await reactions();
		expect(rows.map((row) => row.bridgedFrom).sort()).toEqual([
			`${registration.id} alice-1`,
			`${registration.id} bob-1`,
		]);
	});

	it("refuses the same person reacting twice with one emoji, then removes the reaction", async () => {
		const registration = await linked();
		const { rkey } = await bridges.postMessage(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			author: ALICE,
			text: "react to me",
		});
		const reaction = {
			...keyOf(registration),
			channel: GENERAL,
			author: BOB,
			target: { did: COMMUNITY, rkey },
			emoji: "🎉",
		};

		const added = await bridges.addReaction(BRIDGE, reaction);
		await expectFailure(bridges.addReaction(BRIDGE, reaction), "alreadyReacted");

		const removed = await bridges.removeReaction(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			rkey: added.rkey,
		});
		expect(removed.emoji).toBe("🎉");
		expect(await reactions()).toEqual([]);
	});
});

const openThread = async (
	skey: string,
	channel: string,
	extra: Record<string, unknown> = {},
): Promise<string> => {
	const space = threadSpace(COMMUNITY, skey);
	await writer.put(COMMUNITY, {
		space,
		collection: COLLECTIONS.thread,
		rkey: SELF,
		record: {
			$type: COLLECTIONS.thread,
			name: skey,
			channel,
			createdBy: COMMUNITY,
			createdAt: clock.toISOString(),
			...extra,
		},
	});
	return space;
};

describe("bridged threads", () => {
	it("writes into a thread beside a linked channel", async () => {
		const registration = await linked();
		const thread = await openThread("3lkthread0001", GENERAL);

		await bridges.postMessage(BRIDGE, {
			...keyOf(registration),
			channel: thread,
			author: ALICE,
			text: "in a thread",
		});

		expect(await bridges.mayRead(BRIDGE, thread)).toBe(true);
		const [row] = await messages();
		expect(row).toMatchObject({ space: thread, author: COMMUNITY });
	});

	it("refuses private threads and threads beside unlinked channels", async () => {
		const registration = await linked();
		const secret = await openThread("3lkthread0002", GENERAL, { visibleToMembers: [ADMIN] });
		const elsewhere = await openThread("3lkthread0003", RANDOM);

		for (const channel of [secret, elsewhere]) {
			expect(await bridges.mayRead(BRIDGE, channel)).toBe(false);
			await expectFailure(
				bridges.postMessage(BRIDGE, { ...keyOf(registration), channel, author: ALICE, text: "x" }),
				"channelNotLinked",
			);
		}
	});

	it("opens threads only beside a linked channel, never inside a thread", async () => {
		const registration = await linked();
		const thread = await openThread("3lkthread0004", GENERAL);

		expect((await bridges.threadOpener(BRIDGE, keyOf(registration), GENERAL)).id).toBe(
			registration.id,
		);
		await expectFailure(
			bridges.threadOpener(BRIDGE, keyOf(registration), thread),
			"channelNotLinked",
		);
		await expectFailure(
			bridges.threadOpener(BRIDGE, keyOf(registration), GENERAL, {
				did: COMMUNITY,
				rkey: "3lkmissing001",
			}),
			"messageNotFound",
		);
	});

	it("changes only threads opened for the calling registration", async () => {
		const registration = await linked();
		const own = await openThread("3lkthread0005", GENERAL, {
			bridged: { registration: registration.id, platform: "chat", remoteId: "t-1", name: "Alice" },
		});
		const members = await openThread("3lkthread0006", GENERAL);

		expect((await bridges.ownThread(BRIDGE, keyOf(registration), own)).record.name).toBe(
			"3lkthread0005",
		);
		await expectFailure(bridges.ownThread(BRIDGE, keyOf(registration), members), "notBridged");
		await expectFailure(bridges.ownThread(BRIDGE, keyOf(registration), GENERAL), "threadNotFound");
		await expectFailure(bridges.ownThread(OTHER_BRIDGE, keyOf(registration), own), "forbidden");
	});
});

describe("moderation mirroring", () => {
	const memberMessage = async () => {
		await applyChange(
			{ db: database.db, tables: database.tables, now: () => clock.toISOString() },
			{
				space: GENERAL,
				author: MEMBER,
				puts: [
					{
						collection: COLLECTIONS.message,
						rkey: "3lkmember0001",
						cid: "bafymember",
						value: { $type: COLLECTIONS.message, text: "hi", createdAt: clock.toISOString() },
					},
				],
				deletes: [],
			},
		);
		return { did: MEMBER, rkey: "3lkmember0001" };
	};

	it("refuses to hide messages until an admin turns mirroring on", async () => {
		const registration = await linked();
		const subject = await memberMessage();
		const input = { ...keyOf(registration), channel: GENERAL, subject };

		await expectFailure(bridges.hideable(BRIDGE, input), "moderationMirrorOff");

		const mirrored = await bridges.update(keyOf(registration), { mirrorModeration: true });
		expect(mirrored.mirrorModeration).toBe(true);
		expect((await bridges.hideable(BRIDGE, input)).id).toBe(registration.id);
	});

	it("refuses to hide community messages and messages that do not exist", async () => {
		const registration = await linked();
		await bridges.update(keyOf(registration), { mirrorModeration: true });
		const { rkey } = await bridges.postMessage(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			author: ALICE,
			text: "relayed",
		});

		await expectFailure(
			bridges.hideable(BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				subject: { did: COMMUNITY, rkey },
			}),
			"notBridged",
		);
		await expectFailure(
			bridges.hideable(BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				subject: { did: MEMBER, rkey: "3lkmissing001" },
			}),
			"recordNotFound",
		);
	});
});

describe("history import", () => {
	const SINCE = "2026-09-01T00:00:00.000Z";

	const requested = async (since?: string): Promise<BridgeRegistration> => {
		const registration = await paired();
		return bridges.update(keyOf(registration), {
			links: [
				{
					channel: GENERAL,
					remoteRoom: "room-1",
					remoteName: "general",
					backfill: { ...(since ? { since } : {}), requestedAt: clock.toISOString() },
				},
			],
		});
	};

	const earlier = (remoteMessage: string, createdAt: string) => ({
		author: ALICE,
		text: `sent ${createdAt}`,
		remoteMessage,
		createdAt,
	});

	it("writes imported messages at their original time, ordered among live ones", async () => {
		const registration = await requested(SINCE);
		const live = await bridges.postMessage(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			author: BOB,
			text: "live",
		});

		const results = await bridges.importMessages(BRIDGE, {
			...keyOf(registration),
			channel: GENERAL,
			messages: [
				earlier("old-1", "2026-09-05T08:00:00.000Z"),
				earlier("old-2", "2026-09-10T08:00:00.000Z"),
			],
		});

		const [first, second] = results.map((result) => result.rkey);
		expect(results.map((result) => result.remoteMessage)).toEqual(["old-1", "old-2"]);
		expect(first && second && first < second && second < live.rkey).toBe(true);
		const rows = await messages();
		expect(rows.find((row) => row.rkey === first)).toMatchObject({
			createdAt: "2026-09-05T08:00:00.000Z",
			bridged: { remoteMessage: "old-1", imported: true },
		});
	});

	it("keeps one record when the same message is imported twice", async () => {
		const registration = await requested();
		const input = {
			...keyOf(registration),
			channel: GENERAL,
			messages: [earlier("old-1", "2020-01-01T00:00:00.000Z")],
		};

		const [first] = await bridges.importMessages(BRIDGE, input);
		const [again] = await bridges.importMessages(BRIDGE, input);

		expect(again?.rkey).toBe(first?.rkey);
		expect(await messages()).toHaveLength(1);
	});

	it("refuses an import no admin asked for", async () => {
		const registration = await linked();

		await expectFailure(
			bridges.importMessages(BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				messages: [earlier("old-1", "2026-09-05T08:00:00.000Z")],
			}),
			"backfillNotRequested",
		);
	});

	it("refuses messages outside the requested range", async () => {
		const registration = await requested(SINCE);
		const importing = (createdAt: string) =>
			bridges.importMessages(BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				messages: [earlier("old-1", createdAt)],
			});

		await expectFailure(importing("2026-08-31T23:59:59.000Z"), "outsideBackfillRange");
		await expectFailure(importing("2026-09-24T12:00:01.000Z"), "outsideBackfillRange");
		expect(await messages()).toHaveLength(0);
	});

	it("charges imports to their own budget", async () => {
		bridges = createBridges(
			{ capacity: 1, refillPerSecond: 0 },
			{ capacity: 3, refillPerSecond: 0 },
		);
		const registration = await requested();
		const importing = (count: number) =>
			bridges.importMessages(BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				messages: Array.from({ length: count }, (_, index) =>
					earlier(`old-${count}-${index}`, "2026-09-05T08:00:00.000Z"),
				),
			});

		await importing(3);
		await expectFailure(importing(1), "rateLimited");
		await expect(
			bridges.postMessage(BRIDGE, {
				...keyOf(registration),
				channel: GENERAL,
				author: BOB,
				text: "live",
			}),
		).resolves.toMatchObject({ rkey: expect.any(String) });
	});

	it("shows progress only for the import currently requested", async () => {
		const registration = await requested(SINCE);
		const report = {
			...keyOf(registration),
			channel: GENERAL,
			requestedAt: clock.toISOString(),
			state: "running" as const,
			imported: 40,
			from: SINCE,
			until: clock.toISOString(),
			reached: "2026-09-12T00:00:00.000Z",
		};

		await bridges.reportBackfill(BRIDGE, report);
		expect(await bridges.backfills(registration)).toEqual([
			expect.objectContaining({ channel: GENERAL, imported: 40, state: "running" }),
		]);

		await expectFailure(
			bridges.reportBackfill(BRIDGE, { ...report, requestedAt: SINCE }),
			"backfillNotRequested",
		);
		clock = new Date("2026-09-25T12:00:00.000Z");
		const again = await bridges.update(keyOf(registration), {
			links: [
				{
					channel: GENERAL,
					remoteRoom: "room-1",
					remoteName: "general",
					backfill: { since: SINCE, requestedAt: clock.toISOString() },
				},
			],
		});
		expect(await bridges.backfills(again)).toEqual([]);
	});
});
