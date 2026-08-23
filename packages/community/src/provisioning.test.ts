import { communitySpaces } from "@colibri-social/lexicons";
import type { PdsClient, PdsSession } from "@colibri-social/space";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommunityCredentials, StoredCredentials } from "./credentials.js";
import { CommunityProvisioner, ProvisioningRefused } from "./provisioning.js";

const APPVIEW = "did:web:appview.test";
const APPVIEW_SERVICE = `${APPVIEW}#colibri_appview`;
const OURS = "https://pds.ours.test";
const THEIRS = "https://pds.theirs.test";
const COMMUNITY = "did:plc:brought-my-own";
const CREATOR = "did:plc:creator";

type Write = {
	service: string;
	space: string;
	collection: string;
	record: Record<string, unknown>;
};

let writes: Write[];
let createdSpaces: Array<{ service: string; type: string; skey: string; policy: unknown }>;
let stored: StoredCredentials[];
let forgotten: string[];
let existingSpaces: string[];
let sessionDid: string;

const fakeClient = (service: string): PdsClient =>
	({
		service,
		login: async () => ({ did: sessionDid, handle: "byo.example" }) as unknown as PdsSession,
		listSpaces: async () => ({ spaces: existingSpaces.map((uri) => ({ uri })) }),
		createSpace: async (
			_session: PdsSession,
			params: { type: string; skey: string; policy: unknown },
		) => {
			createdSpaces.push({ service, ...params });
			return { uri: `at://${COMMUNITY}/${params.type}/${params.skey}` };
		},
		putRecord: async (
			_session: PdsSession,
			write: { space: string; collection: string; record: Record<string, unknown> },
		) => {
			writes.push({ service, ...write });
			return { uri: `${write.space}/${write.collection}`, cid: "bafycid" };
		},
	}) as unknown as PdsClient;

const clients = new Map<string, PdsClient>();
const clientFor = (endpoint: string): PdsClient => {
	const existing = clients.get(endpoint);
	if (existing) return existing;
	const client = fakeClient(endpoint);
	clients.set(endpoint, client);
	return client;
};

const fakeCredentials = (): CommunityCredentials =>
	({
		clientFor,
		store: async (credentials: StoredCredentials) => {
			stored.push(credentials);
		},
		forget: async (community: string) => {
			forgotten.push(community);
		},
	}) as unknown as CommunityCredentials;

const provisioner = () =>
	new CommunityProvisioner({
		pds: clientFor(OURS),
		admin: null,
		credentials: fakeCredentials(),
		handleDomain: "colibri.test",
		appviewService: APPVIEW_SERVICE,
		now: () => new Date("2026-08-23T00:00:00.000Z"),
	});

const adopt = () =>
	provisioner().adopt({
		did: COMMUNITY,
		pdsEndpoint: THEIRS,
		identifier: "byo.example",
		password: "hunter2",
		name: "Brought My Own",
		creator: CREATOR,
	});

beforeEach(() => {
	writes = [];
	createdSpaces = [];
	stored = [];
	forgotten = [];
	existingSpaces = [];
	sessionDid = COMMUNITY;
	clients.clear();
});

describe("adopting an existing account", () => {
	it("creates every space on the account's own PDS, never the AppView's", async () => {
		await adopt();

		expect(createdSpaces.length).toBeGreaterThan(0);
		expect(new Set(createdSpaces.map((space) => space.service))).toEqual(new Set([THEIRS]));
		expect(new Set(writes.map((write) => write.service))).toEqual(new Set([THEIRS]));
	});

	it("stamps the AppView as the managing app, without the service fragment", async () => {
		await adopt();

		const profile = writes.find(
			(write) => write.collection === "social.colibri.beta.community",
		)?.record;
		expect(profile?.managingApp).toBe(APPVIEW);
		expect(profile?.name).toBe("Brought My Own");
	});

	it("stores the credentials against the account's own PDS", async () => {
		await adopt();

		expect(stored).toEqual([
			{
				community: COMMUNITY,
				pdsEndpoint: THEIRS,
				identifier: "byo.example",
				password: "hunter2",
				source: "registered",
			},
		]);
	});

	it("keeps the account's own handle rather than minting one", async () => {
		const result = await adopt();
		expect(result.handle).toBe("byo.example");
		expect(result.did).toBe(COMMUNITY);
	});

	it("seeds the same starter layout community.create does", async () => {
		const result = await adopt();

		expect(result.channels.text).toContain("social.colibri.beta.channel.text");
		expect(result.channels.voice).toContain("social.colibri.beta.channel.voice");
		const collections = writes.map((write) => write.collection);
		expect(collections).toContain("social.colibri.beta.role");
		expect(collections).toContain("social.colibri.beta.member");
		expect(collections).toContain("social.colibri.beta.category");
		expect(collections).toContain("social.colibri.beta.community.settings");
	});

	it("refuses credentials that authenticate a different account", async () => {
		sessionDid = "did:plc:someone-else";

		await expect(adopt()).rejects.toThrow(ProvisioningRefused);
		await expect(adopt()).rejects.toMatchObject({ reason: "identityMismatch" });
		expect(stored).toEqual([]);
		expect(createdSpaces).toEqual([]);
	});

	it("refuses an account that already has community spaces", async () => {
		existingSpaces = [communitySpaces(COMMUNITY).members];

		await expect(adopt()).rejects.toMatchObject({ reason: "alreadyASpaceCommunity" });
		expect(stored).toEqual([]);
		expect(createdSpaces).toEqual([]);
	});

	it("refuses to provision a new account with no PDS admin password", async () => {
		await expect(provisioner().create({ name: "Nope", creator: CREATOR })).rejects.toMatchObject({
			reason: "adminUnavailable",
		});
	});
});
