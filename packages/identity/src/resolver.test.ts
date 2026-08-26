import { describe, expect, it } from "vitest";
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
