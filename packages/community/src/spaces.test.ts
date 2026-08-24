import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	channelSpace,
	communitySpaces,
	preferencesSpace,
	SPACE_TYPES,
} from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spaceRegistry } from "./spaces.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxxx";
const HOST = "https://pds.test";

let database: TestDatabase;
let kicked: string[];
let dropped: string[];

const registry = () =>
	spaceRegistry({
		database,
		onRegistered: (uri) => kicked.push(uri),
		onForgotten: (uri) => dropped.push(uri),
		now: () => new Date("2026-08-23T00:00:00.000Z"),
	});

const rows = () => database.db.select().from(database.tables.spaces);

beforeEach(async () => {
	database = await openTestDatabase();
	kicked = [];
	dropped = [];
});

afterEach(async () => {
	await database.destroy();
});

describe("spaceRegistry", () => {
	it("splits a space reference into the columns the sweep reads back", async () => {
		const space = communitySpaces(COMMUNITY).members;
		await registry().register({ uri: space, community: COMMUNITY, host: HOST });

		expect(await rows()).toEqual([
			{
				uri: space,
				authority: COMMUNITY,
				spaceType: SPACE_TYPES.communityMembers,
				skey: "self",
				community: COMMUNITY,
				host: HOST,
				createdAt: "2026-08-23T00:00:00.000Z",
			},
		]);
	});

	it("records a channel space against its community", async () => {
		const space = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel001");
		await registry().register({ uri: space, community: COMMUNITY, host: HOST });

		const [row] = await rows();
		expect(row).toMatchObject({
			authority: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey: "3lkchannel001",
			community: COMMUNITY,
		});
	});

	it("records a personal space with no community", async () => {
		await registry().register({ uri: preferencesSpace(USER), community: null, host: HOST });

		const [row] = await rows();
		expect(row).toMatchObject({ authority: USER, community: null });
	});

	it("tells the caller to sweep, once per registration", async () => {
		const space = communitySpaces(COMMUNITY).profile;
		await registry().register({ uri: space, community: COMMUNITY, host: HOST });
		await registry().register({ uri: space, community: COMMUNITY, host: HOST });

		expect(kicked).toEqual([space, space]);
	});

	it("is idempotent, and moves a space that changed host", async () => {
		const space = communitySpaces(COMMUNITY).configuration;
		await registry().register({ uri: space, community: COMMUNITY, host: HOST });
		await registry().register({ uri: space, community: COMMUNITY, host: "https://moved.test" });

		const all = await rows();
		expect(all).toHaveLength(1);
		expect(all[0]?.host).toBe("https://moved.test");
	});

	it("forgets a space without touching the others", async () => {
		const spaces = communitySpaces(COMMUNITY);
		await registry().register({ uri: spaces.profile, community: COMMUNITY, host: HOST });
		await registry().register({ uri: spaces.members, community: COMMUNITY, host: HOST });

		await registry().forget(spaces.profile);

		expect((await rows()).map((row) => row.uri)).toEqual([spaces.members]);
	});

	it("tells the caller when a space is forgotten, so the sync engine can drop it", async () => {
		const space = communitySpaces(COMMUNITY).profile;
		await registry().register({ uri: space, community: COMMUNITY, host: HOST });

		expect(dropped).toEqual([]);

		await registry().forget(space);

		expect(dropped).toEqual([space]);
	});

	it("rejects something that is not a space reference rather than storing it", async () => {
		await expect(
			registry().register({
				uri: `at://${COMMUNITY}/social.colibri.beta.community/self`,
				community: COMMUNITY,
				host: HOST,
			}),
		).rejects.toThrow();

		expect(await rows()).toEqual([]);
		expect(kicked).toEqual([]);
	});
});
