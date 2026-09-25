import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type CachedIdentity, IdentityResolver, type IdentityStore } from "./resolver.js";

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";

const store = (rows: CachedIdentity[]) => {
	const saved: CachedIdentity[][] = [];
	const byDid = new Map(rows.map((row) => [row.did, row]));
	const impl: IdentityStore = {
		load: async (dids) => new Map([...byDid].filter(([did]) => dids.includes(did))),
		save: async (entries) => {
			saved.push([...entries]);
			for (const entry of entries) byDid.set(entry.did, entry);
		},
	};
	return { store: impl, saved };
};

const cached = (overrides: Partial<CachedIdentity> = {}): CachedIdentity => ({
	did: DID,
	handle: "alice.test",
	handleVerified: true,
	pds: "https://pds.test",
	signingKey: null,
	fetchedAt: new Date(),
	...overrides,
});

const resolver = (identityStore: IdentityStore) =>
	new IdentityResolver({
		plcUrl: "http://plc.invalid",
		staleSeconds: 3600,
		maxSeconds: 86_400,
		store: identityStore,
		handleTtlSeconds: 3600,
	});

describe("resolveVerifiedHandles", () => {
	it("serves a fresh verified handle from the store without resolving", async () => {
		const { store: impl, saved } = store([cached()]);

		const resolved = await resolver(impl).resolveVerifiedHandles([DID]);

		expect(resolved.get(DID)).toBe("alice.test");
		expect(saved).toEqual([]);
	});

	it("reports null for a cached handle that failed verification", async () => {
		const { store: impl, saved } = store([cached({ handleVerified: false })]);

		const resolved = await resolver(impl).resolveVerifiedHandles([DID]);

		expect(resolved.get(DID)).toBeNull();
		expect(saved).toEqual([]);
	});

	it("re-resolves and writes back once the entry falls outside the TTL", async () => {
		const stale = new Date(Date.now() - 7200 * 1000);
		const { store: impl, saved } = store([cached({ fetchedAt: stale })]);

		const resolved = await resolver(impl).resolveVerifiedHandles([DID]);

		expect(resolved.get(DID)).toBeNull();
		expect(saved).toHaveLength(1);
		expect(saved[0]?.[0]?.did).toBe(DID);
	});

	it("treats an entry that was never verified as a miss", async () => {
		const { store: impl, saved } = store([cached({ handleVerified: null })]);

		await resolver(impl).resolveVerifiedHandles([DID]);

		expect(saved).toHaveLength(1);
	});

	it("collapses duplicate DIDs and keeps unrelated ones separate", async () => {
		const { store: impl } = store([cached(), cached({ did: OTHER, handle: "bob.test" })]);

		const resolved = await resolver(impl).resolveVerifiedHandles([DID, DID, OTHER]);

		expect(resolved.size).toBe(2);
		expect(resolved.get(DID)).toBe("alice.test");
		expect(resolved.get(OTHER)).toBe("bob.test");
	});

	it("returns an empty map for no DIDs", async () => {
		const { store: impl } = store([]);
		expect((await resolver(impl).resolveVerifiedHandles([])).size).toBe(0);
	});

	it("resolveVerifiedHandle reads through the same cache", async () => {
		const { store: impl, saved } = store([cached()]);

		expect(await resolver(impl).resolveVerifiedHandle(DID)).toBe("alice.test");
		expect(saved).toEqual([]);
	});
});

describe("signingKeyFor", () => {
	const KEY = "did:key:zQ3shWWLnM6rug8V4CbHxLbDN6gA14JCekjyKZQi2kmF7WAev";
	let server: Server | null = null;

	afterEach(async () => {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = null;
	});

	const serveDocument = async (document: (did: string) => unknown): Promise<string> => {
		server = createServer((_, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(document(did)));
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
		const did = `did:web:localhost%3A${(server.address() as AddressInfo).port}`;
		return did;
	};

	it("accepts a DID document that carries only a signing key", async () => {
		const did = await serveDocument((id) => ({
			id,
			verificationMethod: [
				{
					id: `${id}#atproto`,
					type: "Multikey",
					controller: id,
					publicKeyMultibase: KEY.replace("did:key:", ""),
				},
			],
		}));

		await expect(resolver(store([]).store).signingKeyFor(did, false)).resolves.toBe(KEY);
	});

	it("refuses a did:key issuer", async () => {
		await expect(resolver(store([]).store).signingKeyFor(KEY, false)).rejects.toThrow(
			"not a did:plc or did:web identity",
		);
	});
});
