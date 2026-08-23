import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import type { PdsAdmin, PdsClient, PdsSession } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommunityCredentialError, CommunityCredentials } from "./credentials.js";
import { SecretBox } from "./crypto.js";

const OURS = "https://pds.ours.test";
const THEIRS = "https://pds.theirs.test";
const LOCAL = "did:plc:local";
const FOREIGN = "did:plc:foreign";

let database: TestDatabase;
let logins: Array<{ service: string; identifier: string }>;
let clients: string[];
let resets: string[];

const fakeClient = (service: string): PdsClient =>
	({
		service,
		login: async ({ identifier }: { identifier: string; password: string }) => {
			logins.push({ service, identifier });
			return { did: identifier, handle: `${identifier}.test` } as unknown as PdsSession;
		},
	}) as unknown as PdsClient;

const fakeAdmin = (): PdsAdmin =>
	({
		getAccountInfo: async (did: string) => ({ handle: `${did}.test` }),
		updateAccountPassword: async (did: string) => {
			resets.push(did);
		},
	}) as unknown as PdsAdmin;

const build = async (): Promise<CommunityCredentials> =>
	new CommunityCredentials({
		db: database.db,
		tables: database.tables,
		secrets: await SecretBox.fromBase64(SecretBox.generateKeyBase64()),
		pds: fakeClient(OURS),
		admin: fakeAdmin(),
		clientFor: (endpoint) => {
			clients.push(endpoint);
			return fakeClient(endpoint);
		},
	});

beforeEach(async () => {
	database = await openTestDatabase();
	logins = [];
	clients = [];
	resets = [];
});

afterEach(async () => {
	await database.destroy();
});

describe("community credentials", () => {
	it("logs a locally hosted community into the AppView's own PDS", async () => {
		const credentials = await build();
		await credentials.store({
			community: LOCAL,
			pdsEndpoint: OURS,
			identifier: LOCAL,
			password: "secret",
			source: "provisioned",
		});

		const host = await credentials.connect(LOCAL);

		expect(host.pds.service).toBe(OURS);
		expect(logins).toEqual([{ service: OURS, identifier: LOCAL }]);
		expect(clients).toEqual([]);
	});

	it("logs a community hosted elsewhere into its own PDS, not ours", async () => {
		const credentials = await build();
		await credentials.store({
			community: FOREIGN,
			pdsEndpoint: THEIRS,
			identifier: FOREIGN,
			password: "secret",
			source: "registered",
		});

		const host = await credentials.connect(FOREIGN);

		expect(host.pds.service).toBe(THEIRS);
		expect(logins).toEqual([{ service: THEIRS, identifier: FOREIGN }]);
		expect(clients).toEqual([THEIRS]);
	});

	it("reuses one client per endpoint", async () => {
		const credentials = await build();
		expect(credentials.clientFor(THEIRS)).toBe(credentials.clientFor(THEIRS));
		expect(clients).toEqual([THEIRS]);
	});

	it("refuses to reset the password of a community hosted elsewhere", async () => {
		const credentials = await build();
		await expect(
			credentials.recover(FOREIGN, {
				community: FOREIGN,
				pdsEndpoint: THEIRS,
				identifier: FOREIGN,
				password: "secret",
				source: "registered",
			}),
		).rejects.toMatchObject({ failure: "recoveryUnavailable" });
		expect(resets).toEqual([]);
	});

	it("still resets the password of a community it provisioned", async () => {
		const credentials = await build();
		const recovered = await credentials.recover(LOCAL, {
			community: LOCAL,
			pdsEndpoint: OURS,
			identifier: LOCAL,
			password: "stale",
			source: "provisioned",
		});
		expect(recovered.pdsEndpoint).toBe(OURS);
		expect(resets).toEqual([LOCAL]);
	});

	it("surfaces a credential error rather than a session when nothing is stored", async () => {
		const credentials = new CommunityCredentials({
			db: database.db,
			tables: database.tables,
			secrets: await SecretBox.fromBase64(SecretBox.generateKeyBase64()),
			pds: fakeClient(OURS),
			admin: null,
		});
		await expect(credentials.connect(FOREIGN)).rejects.toBeInstanceOf(CommunityCredentialError);
	});
});
