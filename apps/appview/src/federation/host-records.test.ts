import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import type { CommunityHost } from "@colibri-social/community";
import { XrpcError } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { backfillHostRecords } from "./host-records.js";

const OURS = "did:web:appview.example";
const NOW = "2026-11-26T12:00:00.000Z";

let database: TestDatabase;
let written: string[];
let published: Map<string, string>;
let held: Set<string>;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

const insertCommunity = (did: string, managingApp: string | null) =>
	database.db.insert(database.tables.communities).values({
		did,
		name: did,
		managingApp,
		profileSpace: `at:space/${did}/profile/self`,
		configSpace: `at:space/${did}/configuration/self`,
		membersSpace: `at:space/${did}/members/self`,
		moderationSpace: `at:space/${did}/moderation/self`,
		indexedAt: NOW,
	});

const hostFor = (did: string): CommunityHost =>
	({
		session: { did, handle: did, run: vi.fn() },
		pds: {
			getPublicRecord: async () => {
				const managingApp = published.get(did);

				if (!managingApp) {
					throw new XrpcError(400, "RecordNotFound", "not found", "com.atproto.repo.getRecord");
				}

				return { value: { managingApp } };
			},
			putRepoRecord: async () => {
				if (did.endsWith("broken")) {
					throw new XrpcError(403, "Forbidden", "missing scope", "com.atproto.repo.putRecord");
				}

				written.push(did);

				return { uri: `at://${did}`, cid: "bafycid" };
			},
		},
	}) as unknown as CommunityHost;

const context = () =>
	({
		database,
		log,
		config: { APPVIEW_DID: OURS },
		credentials: {
			has: async (did: string) => held.has(did),
			connect: async (did: string) => hostFor(did),
		},
	}) as unknown as AppContext;

beforeEach(async () => {
	database = await openTestDatabase();
	written = [];
	published = new Map();
	held = new Set();
	log = { info: vi.fn(), warn: vi.fn() };
});

afterEach(async () => {
	await database.destroy();
});

describe("backfillHostRecords", () => {
	it("writes the record for communities this AppView manages and holds credentials for", async () => {
		await insertCommunity("did:plc:missing", OURS);
		await insertCommunity("did:plc:legacy", null);
		await insertCommunity("did:plc:current", OURS);
		await insertCommunity("did:plc:elsewhere", "did:web:other.example");
		await insertCommunity("did:plc:nocreds", OURS);
		held = new Set(["did:plc:missing", "did:plc:legacy", "did:plc:current", "did:plc:elsewhere"]);
		published.set("did:plc:current", OURS);

		await backfillHostRecords(context());

		expect(written.sort()).toEqual(["did:plc:legacy", "did:plc:missing"]);
		expect(log.info).toHaveBeenCalledWith(
			{ written: 2, code: "HostRecordsWritten" },
			"federation.hostRecords",
		);
	});

	it("logs a failed write and carries on with the next community", async () => {
		await insertCommunity("did:plc:broken", OURS);
		await insertCommunity("did:plc:fine", OURS);
		held = new Set(["did:plc:broken", "did:plc:fine"]);

		await backfillHostRecords(context());

		expect(written).toEqual(["did:plc:fine"]);
		expect(log.warn).toHaveBeenCalledWith(
			{ community: "did:plc:broken", code: "Forbidden" },
			"federation.hostRecordFailed",
		);
	});
});
