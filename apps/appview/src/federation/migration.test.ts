import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import type { ForwardAnswer, ForwardRequest } from "./forward.js";
import { ForwardUnreachable } from "./forward.js";
import { beginRemoteMigrations } from "./migration.js";

const HOME = "did:web:home.example";
const MARKET = "did:web:market.example";
const DOWN = "did:web:down.example";
const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxx";
const NOW = "2026-11-27T12:00:00.000Z";
const MARKET_SPACE = "at:space/did:plc:marketspacexxxxxxxxxxxx/social.colibri.beta.channel.text/a";

let database: TestDatabase;

const answer = (status: number, body: unknown): ForwardAnswer => {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: Buffer.from(JSON.stringify(body)),
	};
};

const contextWith = (forwarder: AppContext["forwarder"], enabled = true) => {
	return {
		config: {
			FEDERATION_ENABLED: enabled,
			appviewDids: [HOME],
		},
		database,
		identity: {
			serviceEndpointFor: async (did: string) => `https://${did.slice("did:web:".length)}`,
		},
		forwarder,
		log: { warn: vi.fn() },
	} as unknown as AppContext;
};

beforeEach(async () => {
	database = await openTestDatabase();

	await database.db.insert(database.tables.remoteSpaces).values([
		{
			did: USER,
			community: "did:plc:marketonexxxxxxxxxxxxxxxx",
			managingApp: MARKET,
			joinedAt: NOW,
		},
		{
			did: USER,
			community: "did:plc:markettwoxxxxxxxxxxxxxxxx",
			managingApp: MARKET,
			joinedAt: NOW,
		},
		{
			did: USER,
			community: "did:plc:downxxxxxxxxxxxxxxxxxxxx",
			managingApp: DOWN,
			joinedAt: NOW,
		},
	]);
});

afterEach(async () => {
	await database.destroy();
});

describe("beginRemoteMigrations", () => {
	it("starts the migration once on each managing AppView and collects their spaces", async () => {
		const forwarder = vi.fn(async (target: { managingApp: string }, _request: ForwardRequest) => {
			if (target.managingApp === DOWN) throw new ForwardUnreachable(DOWN);

			return answer(200, { spaces: [MARKET_SPACE] });
		});

		const spaces = await beginRemoteMigrations(
			contextWith(forwarder as unknown as AppContext["forwarder"]),
			USER,
		);

		expect(spaces).toEqual([MARKET_SPACE]);
		expect(forwarder).toHaveBeenCalledTimes(2);

		const request = forwarder.mock.calls.find(([target]) => target.managingApp === MARKET)?.[1];

		expect(request).toMatchObject({
			method: "POST",
			path: "/xrpc/social.colibri.beta.polyfill.beginMigration",
			actingFor: USER,
		});
	});

	it("asks no other AppView when federation is off", async () => {
		const forwarder = vi.fn();

		await expect(
			beginRemoteMigrations(
				contextWith(forwarder as unknown as AppContext["forwarder"], false),
				USER,
			),
		).resolves.toEqual([]);
		expect(forwarder).not.toHaveBeenCalled();
	});
});
