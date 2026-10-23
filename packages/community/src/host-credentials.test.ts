import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import type { HostSession, PdsAdmin, PdsClient } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CommunityCredentialError,
	CommunityCredentials,
	type CommunityHost,
	HostAuthorizationLost,
} from "./credentials.js";
import { SecretBox } from "./crypto.js";

const OURS = "https://pds.ours.test";
const ELSEWHERE = "https://pds.elsewhere.test";
const COMMUNITY = "did:plc:community";
const OWNER = "did:plc:owner";

let database: TestDatabase;
let current: Map<string, string>;
let passwords: Array<{ did: string; password: string }>;
let emails: Array<{ did: string; email: string }>;
let oauthOpen: (community: string) => Promise<CommunityHost>;
let clock: Date;

const fakeClient = (service: string): PdsClient =>
	({
		service,
		login: async ({ identifier }: { identifier: string; password: string }) =>
			({ did: identifier, handle: `${identifier}.test` }) as unknown as HostSession,
	}) as unknown as PdsClient;

const fakeAdmin = (): PdsAdmin =>
	({
		getAccountInfo: async (did: string) => ({ handle: `${did}.test` }),
		updateAccountPassword: async (did: string, password: string) => {
			passwords.push({ did, password });
		},
		updateAccountEmail: async (did: string, email: string) => {
			emails.push({ did, email });
		},
	}) as unknown as PdsAdmin;

const build = async (): Promise<CommunityCredentials> =>
	new CommunityCredentials({
		db: database.db,
		tables: database.tables,
		secrets: await SecretBox.fromBase64(SecretBox.generateKeyBase64()),
		pds: fakeClient(OURS),
		admin: fakeAdmin(),
		oauth: { open: (community) => oauthOpen(community) },
		currentHost: async (did) => current.get(did) ?? OURS,
		clientFor: fakeClient,
		now: () => clock,
	});

const storeProvisioned = (credentials: CommunityCredentials) =>
	credentials.store({
		community: COMMUNITY,
		pdsEndpoint: OURS,
		identifier: "night-owls.ours.test",
		password: "original",
		source: "provisioned",
	});

beforeEach(async () => {
	database = await openTestDatabase();
	current = new Map();
	passwords = [];
	emails = [];
	clock = new Date("2026-10-23T10:00:00.000Z");
	oauthOpen = async () => {
		throw new Error("unexpected oauth open");
	};
});

afterEach(async () => {
	await database.destroy();
});

describe("signed-in hosts", () => {
	it("opens a signed-in community through the oauth hosts", async () => {
		const credentials = await build();
		await credentials.storeOAuth({
			community: COMMUNITY,
			pdsEndpoint: ELSEWHERE,
			identifier: "nightowls.example.com",
			connectedBy: OWNER,
		});
		const host = {
			pds: fakeClient(ELSEWHERE),
			session: { did: COMMUNITY, handle: "nightowls.example.com" },
		} as unknown as CommunityHost;
		oauthOpen = async () => host;

		await expect(credentials.connect(COMMUNITY)).resolves.toBe(host);
		await expect(credentials.load(COMMUNITY)).resolves.toBeNull();
		await expect(credentials.has(COMMUNITY)).resolves.toBe(true);
		expect((await credentials.describe(COMMUNITY))?.connectedBy).toBe(OWNER);
	});

	it("asks for a new sign-in once the authorization is gone", async () => {
		const credentials = await build();
		await credentials.storeOAuth({
			community: COMMUNITY,
			pdsEndpoint: ELSEWHERE,
			identifier: "nightowls.example.com",
			connectedBy: OWNER,
		});
		oauthOpen = async (community) => {
			throw new HostAuthorizationLost(community);
		};

		const failure = await credentials.connect(COMMUNITY).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CommunityCredentialError);
		expect((failure as CommunityCredentialError).failure).toBe("reauthRequired");
		expect((await credentials.describe(COMMUNITY))?.needsReauthAt).toBe(clock.toISOString());
	});

	it("clears the sign-in request when the owner signs in again", async () => {
		const credentials = await build();
		await storeProvisioned(credentials);
		await credentials.markNeedsReauth(COMMUNITY);

		await credentials.storeOAuth({
			community: COMMUNITY,
			pdsEndpoint: ELSEWHERE,
			identifier: "nightowls.example.com",
			connectedBy: OWNER,
		});

		const record = await credentials.describe(COMMUNITY);
		expect(record?.needsReauthAt).toBeNull();
		expect(record?.source).toBe("oauth");
	});
});

describe("moved accounts", () => {
	it("does not reset the password of an account that moved to another server", async () => {
		const credentials = await build();
		current.set(COMMUNITY, ELSEWHERE);

		const failure = await credentials.recover(COMMUNITY).catch((error: unknown) => error);

		expect((failure as CommunityCredentialError).failure).toBe("reauthRequired");
		expect(passwords).toEqual([]);
	});

	it("notices a move from an identity change", async () => {
		const credentials = await build();
		await storeProvisioned(credentials);
		current.set(COMMUNITY, ELSEWHERE);

		await expect(credentials.hostChanged(COMMUNITY)).resolves.toBe(true);
		expect((await credentials.describe(COMMUNITY))?.needsReauthAt).toBe(clock.toISOString());
	});

	it("ignores an identity change that kept the server", async () => {
		const credentials = await build();
		await storeProvisioned(credentials);

		await expect(credentials.hostChanged(COMMUNITY)).resolves.toBe(false);
		expect((await credentials.describe(COMMUNITY))?.needsReauthAt).toBeNull();
	});
});

describe("hand-overs", () => {
	it("sets the owner's email, resets the password and keeps it for an hour", async () => {
		const credentials = await build();
		await storeProvisioned(credentials);

		const result = await credentials.handOver(COMMUNITY, {
			email: "lou@example.com",
			handedOverBy: OWNER,
		});

		expect(emails).toEqual([{ did: COMMUNITY, email: "lou@example.com" }]);
		expect(passwords).toEqual([{ did: COMMUNITY, password: result.password }]);
		expect(result.identifier).toBe("night-owls.ours.test");
		expect(result.expiresAt).toBe("2026-10-23T11:00:00.000Z");
		expect((await credentials.load(COMMUNITY))?.password).toBe(result.password);
		expect((await credentials.describe(COMMUNITY))?.handOver).toEqual({
			handedOverBy: OWNER,
			expiresAt: result.expiresAt,
		});
	});

	it("refuses to hand over an account hosted elsewhere", async () => {
		const credentials = await build();
		await credentials.store({
			community: COMMUNITY,
			pdsEndpoint: ELSEWHERE,
			identifier: "nightowls.example.com",
			password: "theirs",
			source: "registered",
		});

		const failure = await credentials
			.handOver(COMMUNITY, { email: "lou@example.com", handedOverBy: OWNER })
			.catch((error: unknown) => error);

		expect((failure as CommunityCredentialError).failure).toBe("handOverUnavailable");
		expect(emails).toEqual([]);
	});

	it("replaces the password once the hour passes and the account stayed", async () => {
		const credentials = await build();
		await storeProvisioned(credentials);
		const handed = await credentials.handOver(COMMUNITY, {
			email: "lou@example.com",
			handedOverBy: OWNER,
		});

		clock = new Date("2026-10-23T10:59:00.000Z");
		await expect(credentials.expireHandOvers()).resolves.toEqual({ reset: [], moved: [] });

		clock = new Date("2026-10-23T11:00:00.000Z");
		await expect(credentials.expireHandOvers()).resolves.toEqual({
			reset: [COMMUNITY],
			moved: [],
		});

		const stored = await credentials.load(COMMUNITY);
		expect(stored?.password).not.toBe(handed.password);
		expect(passwords.at(-1)?.password).toBe(stored?.password);
		expect((await credentials.describe(COMMUNITY))?.handOver).toBeNull();
	});

	it("leaves a moved account alone and asks for a sign-in instead", async () => {
		const credentials = await build();
		await storeProvisioned(credentials);
		await credentials.handOver(COMMUNITY, { email: "lou@example.com", handedOverBy: OWNER });
		const resetsBefore = passwords.length;

		current.set(COMMUNITY, ELSEWHERE);
		clock = new Date("2026-10-23T11:30:00.000Z");

		await expect(credentials.expireHandOvers()).resolves.toEqual({
			reset: [],
			moved: [COMMUNITY],
		});
		expect(passwords.length).toBe(resetsBefore);
		const record = await credentials.describe(COMMUNITY);
		expect(record?.handOver).toBeNull();
		expect(record?.needsReauthAt).toBe(clock.toISOString());
	});
});
