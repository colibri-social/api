import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { COLLECTIONS, communitySpaces, SPACE_TYPES } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommunityLoader } from "./loader.js";
import { healPermissionOverrides, legacyToOverrides } from "./permission-heal.js";
import type { CommunityWriter, RecordWrite } from "./writes.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";

const OPEN = {
	ownerOnly: false,
	allowedRoles: [],
	allowedMembers: [],
	visibleToRoles: [],
	visibleToMembers: [],
};

describe("legacyToOverrides", () => {
	it("returns nothing for an open scope", () => {
		expect(
			legacyToOverrides(OPEN, { defaultRole: "everyone", postingKeys: ["message.send"] }),
		).toEqual([]);
	});

	it("turns a visible list into a default-role Deny plus Allows", () => {
		const overrides = legacyToOverrides(
			{ ...OPEN, visibleToRoles: ["staff"], visibleToMembers: ["did:plc:guest"] },
			{ defaultRole: "everyone", postingKeys: ["message.send"] },
		);

		expect(overrides).toEqual([
			{ role: "everyone", allow: [], deny: ["channel.view"] },
			{ role: "staff", allow: ["channel.view"], deny: [] },
			{ member: "did:plc:guest", allow: ["channel.view"], deny: [] },
		]);
	});

	it("turns posting lists and ownerOnly into the posting keys", () => {
		expect(
			legacyToOverrides(
				{ ...OPEN, allowedRoles: ["leads"] },
				{ defaultRole: "everyone", postingKeys: ["voice.connect"] },
			),
		).toEqual([
			{ role: "everyone", allow: [], deny: ["voice.connect"] },
			{ role: "leads", allow: ["voice.connect"], deny: [] },
		]);
		expect(
			legacyToOverrides(
				{ ...OPEN, ownerOnly: true, allowedRoles: ["leads"] },
				{ defaultRole: "everyone", postingKeys: ["message.send", "voice.connect"] },
			),
		).toEqual([{ role: "everyone", allow: [], deny: ["message.send", "voice.connect"] }]);
	});

	it("skips the Deny when the default role is itself listed", () => {
		expect(
			legacyToOverrides(
				{ ...OPEN, visibleToRoles: ["everyone", "staff"] },
				{ defaultRole: "everyone", postingKeys: ["message.send"] },
			),
		).toEqual([]);
	});

	it("folds legacy role channel overrides in, with deny winning", () => {
		expect(
			legacyToOverrides(
				{ ...OPEN, visibleToRoles: ["staff"] },
				{
					defaultRole: "everyone",
					postingKeys: ["message.send"],
					roleOverrides: [
						{
							role: "staff",
							override: { channel: "c", allow: ["label.apply"], deny: ["channel.view"] },
						},
					],
				},
			),
		).toEqual([
			{ role: "everyone", allow: [], deny: ["channel.view"] },
			{ role: "staff", allow: ["label.apply"], deny: ["channel.view"] },
		]);
	});
});

describe("healPermissionOverrides", () => {
	let database: TestDatabase;

	const records = new Map<string, Record<string, unknown>>();

	const writer = (writes: RecordWrite[]) =>
		({
			spaces: (community: string) => communitySpaces(community),
			currentRecord: async (_community: string, space: string, collection: string, rkey: string) =>
				records.get(`${space}|${collection}|${rkey}`) ?? null,
			put: async (_community: string, write: RecordWrite) => {
				writes.push(write);
				return { uri: "", rkey: write.rkey ?? "" };
			},
		}) as unknown as CommunityWriter;

	const run = (writes: RecordWrite[]) =>
		healPermissionOverrides(
			{
				db: database.db,
				tables: database.tables,
				loader: new CommunityLoader({ db: database.db, tables: database.tables }),
				writer: writer(writes),
			},
			COMMUNITY,
		);

	const space = `at://${COMMUNITY}/space/${SPACE_TYPES.channelVoice}/3lkvoice`;

	beforeEach(async () => {
		database = await openTestDatabase();
		records.clear();
		await database.db.insert(database.tables.roles).values([
			{
				community: COMMUNITY,
				rkey: "everyone",
				name: "Members",
				permissions: [],
				position: 0,
				isDefault: true,
			},
			{
				community: COMMUNITY,
				rkey: "staff",
				name: "Staff",
				permissions: [],
				position: 2,
				channelOverrides: [{ channel: "3lkvoice", allow: [], deny: ["voice.camera"] }],
			},
		]);
		await database.db.insert(database.tables.channels).values({
			space,
			community: COMMUNITY,
			spaceType: SPACE_TYPES.channelVoice,
			skey: "3lkvoice",
			name: "Stage",
			allowedRoles: ["staff"],
		});
		records.set(`${space}|${COLLECTIONS.channel}|self`, {
			$type: COLLECTIONS.channel,
			name: "Stage",
			allowedRoles: ["staff"],
		});
		records.set(`${communitySpaces(COMMUNITY).members}|${COLLECTIONS.role}|staff`, {
			$type: COLLECTIONS.role,
			name: "Staff",
			permissions: [],
			position: 2,
			channelOverrides: [{ channel: "3lkvoice", allow: [], deny: ["voice.camera"] }],
		});
	});

	afterEach(async () => {
		await database.close();
	});

	it("rewrites legacy channel fields and strips role channel overrides", async () => {
		const writes: RecordWrite[] = [];

		expect(await run(writes)).toEqual({ categories: 0, channels: 1, roles: 1 });

		const [channelWrite, roleWrite] = writes;

		expect(channelWrite?.record).toEqual({
			$type: COLLECTIONS.channel,
			name: "Stage",
			permissionOverrides: [
				{ role: "everyone", allow: [], deny: ["voice.connect"] },
				{ role: "staff", allow: ["voice.connect"], deny: ["voice.camera"] },
			],
		});
		expect(roleWrite?.record).not.toHaveProperty("channelOverrides");
	});

	it("leaves channels that already have overrides alone", async () => {
		await database.db.update(database.tables.channels).set({ permissionOverrides: [] });
		await database.db.update(database.tables.roles).set({ channelOverrides: [] });

		const writes: RecordWrite[] = [];

		expect(await run(writes)).toBeNull();
		expect(writes).toEqual([]);
	});
});
