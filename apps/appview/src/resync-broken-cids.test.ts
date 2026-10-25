import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { channelSpace, SPACE_TYPES } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resyncBrokenCids } from "./resync-broken-cids.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const BROKEN = "did:plc:brokenxxxxxxxxxxxxxxxxxxxxx";
const HEALTHY = "did:plc:healthyxxxxxxxxxxxxxxxxxxxx";
const CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannel001");
const NOW = "2026-10-25T12:00:00.000Z";
const silent = { info: () => {} };

let database: TestDatabase;

const attachmentRecord = (link: string) => ({
	text: "",
	createdAt: NOW,
	attachments: [{ blob: { $type: "blob", mimeType: "image/png", size: 4, ref: { $link: link } } }],
});

const insertRepo = async (author: string, link: string) => {
	await database.db.insert(database.tables.spaceRepos).values({
		space: CHANNEL,
		author,
		appliedRev: "3lkrev0000001",
		setHashBase64: "hash",
		state: "active",
	});
	await database.db.insert(database.tables.records).values({
		space: CHANNEL,
		author,
		collection: "social.colibri.beta.message",
		rkey: "3lkmessage001",
		cid: "bafyreicid",
		value: attachmentRecord(link),
		indexedAt: NOW,
	});
};

const cursorOf = async (author: string) =>
	(await database.db.select().from(database.tables.spaceRepos)).find(
		(row) => row.author === author,
	);

beforeEach(async () => {
	database = await openTestDatabase();
	await insertRepo(BROKEN, "[object Object]");
	await insertRepo(HEALTHY, "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
});

afterEach(async () => {
	await database.destroy();
});

describe("resyncBrokenCids", () => {
	it("resets and queues only repos whose records hold a stringified object", async () => {
		const queued: string[] = [];

		const broken = await resyncBrokenCids(
			database,
			{ notifyWrite: (space, author) => void queued.push(`${space} ${author}`) },
			silent,
		);

		expect(broken).toEqual([{ space: CHANNEL, author: BROKEN }]);
		expect(queued).toEqual([`${CHANNEL} ${BROKEN}`]);
		expect(await cursorOf(BROKEN)).toMatchObject({
			appliedRev: null,
			setHashBase64: null,
			state: "pending",
		});
		expect(await cursorOf(HEALTHY)).toMatchObject({ appliedRev: "3lkrev0000001", state: "active" });
	});
});
