import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	CommunityCredentialError,
	type CredentialRecord,
	type HandOverResult,
} from "@colibri-social/community";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import {
	finishSignIn,
	handleAuthorizeHost,
	handleGetHostAuthorization,
	handleGetHosting,
	handleHandOverHost,
} from "./hosting.js";

const OURS = "https://pds.ours.test";
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const OWNER = "did:plc:ownerxxxxxxxxxxxxxxxxxxxxxxxx";
const STRANGER = "did:plc:strangerxxxxxxxxxxxxxxxxxxxxx";
const BYO = "did:plc:broughtmyownxxxxxxxxxxxxxxxxxxx";

let database: TestDatabase;
let ctx: AppContext;
let record: CredentialRecord | null;
let authorized: Array<{ identifier: string; request: string }>;
let handOver: () => Promise<HandOverResult>;
let communities: Set<string>;
let revoked: string[];
let storedOAuth: Array<{ community: string; connectedBy: string; pdsEndpoint: string }>;
let known: Set<string>;

const errorOf = async (run: () => Promise<unknown>) =>
	run().then(
		() => {
			throw new Error("expected a failure");
		},
		(error: { error?: string; customErrorName?: string }) => error.customErrorName ?? error.error,
	);

const build = (options: { oauth?: boolean } = {}) => {
	ctx = {
		database,
		pds: { service: OURS },
		config: {},
		sync: { wake: () => {} },
		log: { warn: () => {}, info: () => {} },
		hostOAuth:
			options.oauth === false
				? null
				: {
						revoke: async (did: string) => {
							revoked.push(did);
						},
						authorize: async (identifier: string, request: string) => {
							authorized.push({ identifier, request });
							return new URL(`https://auth.test/authorize?request=${request}`);
						},
					},
		identity: {
			resolveHandle: async (handle: string) => {
				if (handle === "nightowls.example.com") return BYO;
				throw new Error("unknown handle");
			},
		},
		loader: {
			community: async (did: string) => (communities.has(did) ? { did } : null),
			authz: async (community: string, actor: string) => ({
				actor,
				community,
				isOwner: false,
				isBanned: false,
				member: null,
				roles: actor === OWNER ? [{ protected: true, position: 0 }] : [],
			}),
		},
		credentials: {
			describe: async () => record,
			has: async (did: string) => known.has(did),
			storeOAuth: async (credentials: {
				community: string;
				connectedBy: string;
				pdsEndpoint: string;
			}) => {
				storedOAuth.push(credentials);
			},
			handOver: () => handOver(),
		},
	} as unknown as AppContext;
};

beforeEach(async () => {
	database = await openTestDatabase();
	record = null;
	authorized = [];
	revoked = [];
	storedOAuth = [];
	known = new Set();
	communities = new Set([COMMUNITY]);
	handOver = async () => ({
		password: "fresh-password",
		identifier: "night-owls.ours.test",
		expiresAt: "2026-10-23T11:00:00.000Z",
	});
	build();
});

afterEach(async () => {
	await database.destroy();
});

describe("authorizeHost", () => {
	it("starts a sign-in for a new community and remembers who asked", async () => {
		const result = await handleAuthorizeHost(ctx, OWNER, {
			identifier: "nightowls.example.com",
			intent: "adopt",
			name: "Night Owls",
		});

		expect(authorized).toEqual([{ identifier: BYO, request: result.request }]);
		expect(result.authorizeUrl).toContain(result.request);
		await expect(handleGetHostAuthorization(ctx, OWNER, result.request)).resolves.toEqual({
			status: "pending",
		});
	});

	it("is unavailable without a host sign-in key", async () => {
		build({ oauth: false });
		await expect(
			errorOf(() =>
				handleAuthorizeHost(ctx, OWNER, {
					identifier: "nightowls.example.com",
					intent: "adopt",
					name: "Night Owls",
				}),
			),
		).resolves.toBe("HostSignInUnavailable");
	});

	it("refuses an account that is already a community here", async () => {
		communities.add(BYO);
		await expect(
			errorOf(() =>
				handleAuthorizeHost(ctx, OWNER, {
					identifier: "nightowls.example.com",
					intent: "adopt",
					name: "Night Owls",
				}),
			),
		).resolves.toBe("AlreadyExists");
		expect(authorized).toEqual([]);
	});

	it("only lets administrators reconnect a community", async () => {
		await expect(
			errorOf(() =>
				handleAuthorizeHost(ctx, STRANGER, {
					identifier: COMMUNITY,
					intent: "reconnect",
					community: COMMUNITY,
				}),
			),
		).resolves.toBe("Forbidden");

		const result = await handleAuthorizeHost(ctx, OWNER, {
			identifier: COMMUNITY,
			intent: "reconnect",
			community: COMMUNITY,
		});
		expect(authorized).toEqual([{ identifier: COMMUNITY, request: result.request }]);
	});
});

describe("getHostAuthorization", () => {
	it("hides another user's sign-in", async () => {
		const { request } = await handleAuthorizeHost(ctx, OWNER, {
			identifier: "nightowls.example.com",
			intent: "adopt",
			name: "Night Owls",
		});

		await expect(errorOf(() => handleGetHostAuthorization(ctx, STRANGER, request))).resolves.toBe(
			"RequestNotFound",
		);
	});

	it("reports which account the user signed in as by mistake", async () => {
		const { request } = await handleAuthorizeHost(ctx, OWNER, {
			identifier: "nightowls.example.com",
			intent: "adopt",
			name: "Night Owls",
		});
		await database.db
			.update(database.tables.hostAuthorizations)
			.set({ status: "failed", failure: "wrongAccount:alex.example.com" });

		await expect(handleGetHostAuthorization(ctx, OWNER, request)).resolves.toEqual({
			status: "failed",
			failure: "wrongAccount",
			signedInAs: "alex.example.com",
		});
	});
});

describe("getHosting", () => {
	it("describes a community Colibri hosts", async () => {
		record = {
			community: COMMUNITY,
			pdsEndpoint: OURS,
			identifier: "night-owls.ours.test",
			source: "provisioned",
			connectedBy: null,
			needsReauthAt: null,
			handOver: { handedOverBy: OWNER, expiresAt: "2026-10-23T11:00:00.000Z" },
			createdAt: "2026-10-01T00:00:00.000Z",
		};

		const { hosting } = await handleGetHosting(ctx, OWNER, COMMUNITY);

		expect(hosting).toMatchObject({
			kind: "colibri",
			account: "night-owls.ours.test",
			server: OURS,
			needsSignIn: false,
			handOverExpiresAt: "2026-10-23T11:00:00.000Z",
		});
	});

	it("describes a community on its owner's account that needs a sign-in", async () => {
		record = {
			community: COMMUNITY,
			pdsEndpoint: "https://pds.example.com",
			identifier: "nightowls.example.com",
			source: "oauth",
			connectedBy: OWNER,
			needsReauthAt: "2026-10-21T00:00:00.000Z",
			handOver: null,
			createdAt: "2026-10-01T00:00:00.000Z",
		};

		const { hosting } = await handleGetHosting(ctx, OWNER, COMMUNITY);

		expect(hosting).toMatchObject({
			kind: "own",
			connectedBy: OWNER,
			needsSignIn: true,
			needsSignInSince: "2026-10-21T00:00:00.000Z",
		});
	});

	it("is only for administrators", async () => {
		await expect(errorOf(() => handleGetHosting(ctx, STRANGER, COMMUNITY))).resolves.toBe(
			"Forbidden",
		);
	});
});

describe("handOverHost", () => {
	it("returns the new password and when it stops working", async () => {
		await expect(
			handleHandOverHost(ctx, OWNER, { community: COMMUNITY, email: "lou@example.com" }),
		).resolves.toEqual({
			identifier: "night-owls.ours.test",
			password: "fresh-password",
			expiresAt: "2026-10-23T11:00:00.000Z",
		});
	});

	it("rejects an email that can't receive codes", async () => {
		await expect(
			errorOf(() => handleHandOverHost(ctx, OWNER, { community: COMMUNITY, email: "lou" })),
		).resolves.toBe("InvalidRequest");
	});

	it("reports an account that can't be handed over", async () => {
		handOver = async () => {
			throw new CommunityCredentialError(COMMUNITY, "handOverUnavailable", "moved");
		};
		await expect(
			errorOf(() =>
				handleHandOverHost(ctx, OWNER, { community: COMMUNITY, email: "lou@example.com" }),
			),
		).resolves.toBe("HandOverUnavailable");
	});

	it("is only for administrators", async () => {
		await expect(
			errorOf(() =>
				handleHandOverHost(ctx, STRANGER, { community: COMMUNITY, email: "lou@example.com" }),
			),
		).resolves.toBe("Forbidden");
	});
});

const signInAs = (did: string, handle: string, request: string) =>
	({
		request,
		session: { did },
		host: {
			pds: { service: "https://pds.example.com", listSpaces: async () => ({ spaces: [] }) },
			session: { did, handle },
		},
	}) as never;

describe("finishing a sign-in", () => {
	it("refuses a different account and lets go of its session", async () => {
		const { request } = await handleAuthorizeHost(ctx, OWNER, {
			identifier: "nightowls.example.com",
			intent: "adopt",
			name: "Night Owls",
		});

		await expect(
			finishSignIn(ctx, signInAs(STRANGER, "alex.example.com", request)),
		).resolves.toEqual({ id: request, failure: "wrongAccount" });
		expect(revoked).toEqual([STRANGER]);
		await expect(handleGetHostAuthorization(ctx, OWNER, request)).resolves.toMatchObject({
			status: "failed",
			signedInAs: "alex.example.com",
		});
	});

	it("keeps the session of a wrong account that runs another community here", async () => {
		known.add(STRANGER);
		const { request } = await handleAuthorizeHost(ctx, OWNER, {
			identifier: "nightowls.example.com",
			intent: "adopt",
			name: "Night Owls",
		});

		await finishSignIn(ctx, signInAs(STRANGER, "alex.example.com", request));

		expect(revoked).toEqual([]);
	});

	it("reconnects a community through the new sign-in", async () => {
		const { request } = await handleAuthorizeHost(ctx, OWNER, {
			identifier: COMMUNITY,
			intent: "reconnect",
			community: COMMUNITY,
		});

		await expect(
			finishSignIn(ctx, signInAs(COMMUNITY, "nightowls.example.com", request)),
		).resolves.toEqual({ id: request, failure: undefined });
		expect(storedOAuth).toEqual([
			{
				community: COMMUNITY,
				pdsEndpoint: "https://pds.example.com",
				identifier: "nightowls.example.com",
				connectedBy: OWNER,
			},
		]);
		await expect(handleGetHostAuthorization(ctx, OWNER, request)).resolves.toEqual({
			status: "done",
			community: COMMUNITY,
		});
	});
});
