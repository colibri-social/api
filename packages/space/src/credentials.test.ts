import { Secp256k1Keypair } from "@atproto/crypto";
import { createSpaceToken, parseSpaceToken, verifySpaceSignature } from "@atproto/space";
import { beforeEach, describe, expect, it } from "vitest";
import { inMemoryCredentialStorage, SpaceCredentials } from "./credentials.js";
import { SpaceCredentialError } from "./errors.js";
import { StaticSpaceHostResolver } from "./host.js";
import { spaceRef } from "./space-ref.js";

const AUTHORITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const HOST = "https://pds.test";
const SPACE = spaceRef(AUTHORITY, "social.colibri.beta.channel.text", "3lkabcdefgh2k");

type HostBehaviour = {
	failWith?: { status: number; error: string };
	rejectTokensOnce?: string;
	lifetimeSeconds?: number;
};

type Recorded = {
	authorization: string | null;
	signatureInput: string | null;
	keyId: string;
	body: { space: string; clientAttestation?: string };
};

const fakeSpaceHost = (authorityKey: Secp256k1Keypair, behaviour: HostBehaviour = {}) => {
	const calls: Recorded[] = [];

	const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
		const headers = new Headers(init?.headers);
		const body = JSON.parse(String(init?.body ?? "{}"));

		if (behaviour.rejectTokensOnce === headers.get("authorization")?.slice("Bearer ".length)) {
			return new Response(JSON.stringify({ error: "InvalidDelegationToken" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		if (behaviour.failWith) {
			return new Response(JSON.stringify({ error: behaviour.failWith.error }), {
				status: behaviour.failWith.status,
				headers: { "content-type": "application/json" },
			});
		}

		const keyId = await verifySpaceSignature(Object.fromEntries(headers.entries())).catch(
			() => null,
		);
		if (!keyId) {
			return new Response(JSON.stringify({ error: "BadSpaceSignature" }), { status: 401 });
		}

		calls.push({
			authorization: headers.get("authorization"),
			signatureInput: headers.get("signature-input"),
			keyId,
			body,
		});

		const credential = await createSpaceToken(
			"credential",
			{
				iss: AUTHORITY,
				sub: body.space,
				keyId,
				expiresInSec: behaviour.lifetimeSeconds ?? 600,
			},
			authorityKey,
		);
		return new Response(JSON.stringify({ credential }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	return { fetchImpl, calls };
};

let authorityKey: Secp256k1Keypair;

beforeEach(async () => {
	authorityKey = await Secp256k1Keypair.create({ exportable: true });
});

const credentialsFor = (
	fetchImpl: typeof globalThis.fetch,
	overrides: Partial<{
		delegation: () => Promise<string | null>;
		renewBeforeSeconds: number;
		clientAttestation: () => Promise<string | undefined>;
	}> = {},
) =>
	new SpaceCredentials({
		hosts: new StaticSpaceHostResolver(new Map([[AUTHORITY, HOST]])),
		delegation: overrides.delegation ?? (async () => "delegation-token"),
		storage: inMemoryCredentialStorage(),
		fetch: fetchImpl,
		renewBeforeSeconds: overrides.renewBeforeSeconds ?? 120,
		...(overrides.clientAttestation ? { clientAttestation: overrides.clientAttestation } : {}),
	});

describe("space credentials", () => {
	it("exchanges a delegation token for a credential bound to its own key", async () => {
		const host = fakeSpaceHost(authorityKey);
		const credential = await credentialsFor(host.fetchImpl).acquire(SPACE);

		expect(host.calls).toHaveLength(1);
		expect(host.calls[0]?.authorization).toBe("Bearer delegation-token");
		expect(host.calls[0]?.keyId).toBe(credential.key.did);

		const parsed = parseSpaceToken("credential", credential.credential);
		expect(parsed.payload.sub).toBe(SPACE);
		expect(parsed.payload.cnf?.kid).toBe(credential.key.did);
	});

	it("signs only the authorization header of the delegation exchange", async () => {
		const host = fakeSpaceHost(authorityKey);
		const credential = await credentialsFor(host.fetchImpl).acquire(SPACE);
		expect(host.calls[0]?.signatureInput).toBe(
			`atproto-space=("authorization");keyid="${credential.key.did}"`,
		);
	});

	it("reuses a cached credential rather than minting a second one", async () => {
		const host = fakeSpaceHost(authorityKey);
		const credentials = credentialsFor(host.fetchImpl);
		const first = await credentials.acquire(SPACE);
		const second = await credentials.acquire(SPACE);

		expect(host.calls).toHaveLength(1);
		expect(second.credential).toBe(first.credential);
		expect(second.key.did).toBe(first.key.did);
	});

	it("mints again once the cached credential is inside the renewal window", async () => {
		const host = fakeSpaceHost(authorityKey, { lifetimeSeconds: 60 });
		const credentials = credentialsFor(host.fetchImpl, { renewBeforeSeconds: 300 });
		await credentials.acquire(SPACE);
		await credentials.acquire(SPACE);
		expect(host.calls).toHaveLength(2);
	});

	it("keeps a still-valid credential when nothing can mint a delegation token", async () => {
		const host = fakeSpaceHost(authorityKey, { lifetimeSeconds: 60 });
		let tokens = 0;
		const credentials = credentialsFor(host.fetchImpl, {
			delegation: async () => (tokens++ === 0 ? "delegation-token" : null),
		});

		const first = await credentials.acquire(SPACE);
		const second = await credentials.acquire(SPACE);

		expect(host.calls).toHaveLength(1);
		expect(second.credential).toBe(first.credential);
		expect(second.key.did).toBe(first.key.did);
	});

	it("collapses concurrent requests for the same space into one exchange", async () => {
		const host = fakeSpaceHost(authorityKey);
		const credentials = credentialsFor(host.fetchImpl);
		await Promise.all([
			credentials.acquire(SPACE),
			credentials.acquire(SPACE),
			credentials.acquire(SPACE),
		]);
		expect(host.calls).toHaveLength(1);
	});

	it("passes a client attestation when one is configured", async () => {
		const host = fakeSpaceHost(authorityKey);
		await credentialsFor(host.fetchImpl, {
			clientAttestation: async () => "attestation-jwt",
		}).acquire(SPACE);
		expect(host.calls[0]?.body.clientAttestation).toBe("attestation-jwt");
	});

	it("mints a fresh delegation token when the authority says the first one was spent", async () => {
		const host = fakeSpaceHost(authorityKey, { rejectTokensOnce: "spent-token" });
		const minted: string[] = [];
		const credentials = credentialsFor(host.fetchImpl, {
			delegation: async () => {
				const token = minted.length === 0 ? "spent-token" : "fresh-token";
				minted.push(token);
				return token;
			},
		});

		const credential = await credentials.acquire(SPACE);

		expect(minted).toEqual(["spent-token", "fresh-token"]);
		expect(host.calls[0]?.authorization).toBe("Bearer fresh-token");
		expect(parseSpaceToken("credential", credential.credential).payload.sub).toBe(SPACE);
	});

	it("does not replay a caller-supplied delegation token", async () => {
		const host = fakeSpaceHost(authorityKey, { rejectTokensOnce: "client-token" });
		let mints = 0;
		const credentials = credentialsFor(host.fetchImpl, {
			delegation: async () => {
				mints += 1;
				return "server-token";
			},
		});

		await expect(credentials.acquireWith(SPACE, "client-token")).rejects.toMatchObject({
			reason: "invalidDelegationToken",
		});
		expect(mints).toBe(0);
	});

	it("reports a space with no delegation token distinctly", async () => {
		const host = fakeSpaceHost(authorityKey);
		const credentials = credentialsFor(host.fetchImpl, { delegation: async () => null });
		await expect(credentials.acquire(SPACE)).rejects.toMatchObject({
			reason: "noDelegationToken",
		});
		expect(host.calls).toHaveLength(0);
	});

	it("reports a deleted space distinctly, so a syncer knows to drop its copy", async () => {
		const host = fakeSpaceHost(authorityKey, { failWith: { status: 400, error: "SpaceDeleted" } });
		await expect(credentialsFor(host.fetchImpl).acquire(SPACE)).rejects.toMatchObject({
			reason: "spaceDeleted",
		});
	});

	it("reports a refusal distinctly from an outage", async () => {
		const refused = fakeSpaceHost(authorityKey, {
			failWith: { status: 400, error: "UserNotAuthorized" },
		});
		await expect(credentialsFor(refused.fetchImpl).acquire(SPACE)).rejects.toMatchObject({
			reason: "refused",
		});

		const down = fakeSpaceHost(authorityKey, { failWith: { status: 502, error: "BadGateway" } });
		await expect(credentialsFor(down.fetchImpl).acquire(SPACE)).rejects.toMatchObject({
			reason: "upstream",
		});
	});

	it("reports an unresolvable authority without calling anything", async () => {
		const credentials = new SpaceCredentials({
			hosts: new StaticSpaceHostResolver(new Map()),
			delegation: async () => "delegation-token",
			storage: inMemoryCredentialStorage(),
			fetch: async () => {
				throw new Error("must not be called");
			},
		});
		await expect(credentials.acquire(SPACE)).rejects.toBeInstanceOf(SpaceCredentialError);
	});
});
