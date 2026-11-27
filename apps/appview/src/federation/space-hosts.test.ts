import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { XrpcError } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpaceHosts } from "./space-hosts.js";

const OURS = "did:web:appview.example";
const THEIRS = "did:web:other.example";
const REMOTE = "did:plc:remotexxxxxxxxxxxxxxxxxxxx";
const LOCAL = "did:plc:localxxxxxxxxxxxxxxxxxxxxx";
const UNKNOWN = "did:plc:unknownxxxxxxxxxxxxxxxxxxx";
const NOW = "2026-11-26T12:00:00.000Z";

let database: TestDatabase;

const getPublicRecord = vi.fn(async (repo: string) => {
	if (repo === REMOTE) return { value: { managingApp: THEIRS } };

	throw new XrpcError(400, "RecordNotFound", "not found", "com.atproto.repo.getRecord");
});

const hosts = () =>
	createSpaceHosts({
		database,
		self: [OURS],
		identity: {
			resolveDid: async (did) => ({
				did,
				handle: null,
				pds: "https://pds.example",
				signingKey: "did:key:z",
			}),
			serviceEndpointFor: async (did) => (did === THEIRS ? "https://other.example" : undefined),
		},
		clientFor: () => ({ getPublicRecord }) as never,
	});

beforeEach(async () => {
	database = await openTestDatabase();
	getPublicRecord.mockClear();
});

afterEach(async () => {
	await database.destroy();
});

describe("createSpaceHosts", () => {
	it("answers from the communities table for a community this AppView manages", async () => {
		await database.db.insert(database.tables.communities).values({
			did: LOCAL,
			name: "Local",
			managingApp: OURS,
			profileSpace: "p",
			configSpace: "c",
			membersSpace: "m",
			moderationSpace: "o",
			indexedAt: NOW,
		});

		await expect(hosts().resolve(LOCAL)).resolves.toEqual({ local: true, managingApp: OURS });
		expect(getPublicRecord).not.toHaveBeenCalled();
	});

	it("stores the remote host in space_hosts and reads it back from there", async () => {
		await expect(hosts().resolve(REMOTE)).resolves.toEqual({
			local: false,
			managingApp: THEIRS,
			endpoint: "https://other.example",
		});

		const [row] = await database.db.select().from(database.tables.spaceHosts);

		expect(row).toMatchObject({
			authority: REMOTE,
			managingApp: THEIRS,
			endpoint: "https://other.example",
		});

		await hosts().resolve(REMOTE);
		expect(getPublicRecord).toHaveBeenCalledOnce();
	});

	it("caches a community without a host record as unknown", async () => {
		await expect(hosts().resolve(UNKNOWN)).resolves.toBeUndefined();

		const [row] = await database.db.select().from(database.tables.spaceHosts);

		expect(row).toMatchObject({ authority: UNKNOWN, managingApp: null, endpoint: null });
	});
});
