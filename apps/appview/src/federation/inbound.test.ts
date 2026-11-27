import { describe, expect, it, vi } from "vitest";
import {
	admitPeer,
	createBlockCache,
	createPeerLimiter,
	type InboundDeps,
	verifyForwarded,
} from "./inbound.js";

const PEER = "did:web:home.example";
const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxx";
const REQUEST = { token: "jwt", lxm: "social.colibri.beta.channel.listMessages", actingFor: USER };

const deps = (overrides: Partial<InboundDeps> = {}): InboundDeps => ({
	enabled: true,
	verify: vi.fn(async () => ({ did: PEER })),
	isBlocked: vi.fn(async () => false),
	allows: vi.fn(async () => true),
	limiter: { take: () => true },
	...overrides,
});

describe("admitPeer", () => {
	it("lets a known peer through and refuses one that is off, blocked or over its limit", async () => {
		await expect(admitPeer(deps(), PEER)).resolves.toBeUndefined();
		await expect(admitPeer(deps({ enabled: false }), PEER)).rejects.toMatchObject({
			customErrorName: "FederationDisabled",
		});
		await expect(
			admitPeer(deps({ isBlocked: vi.fn(async () => true) }), PEER),
		).rejects.toMatchObject({ customErrorName: "PeerBlocked" });
		await expect(admitPeer(deps({ limiter: { take: () => false } }), PEER)).rejects.toMatchObject({
			customErrorName: "RateLimitExceeded",
		});
	});
});

describe("verifyForwarded", () => {
	it("acts for the user once the peer is verified and declared", async () => {
		const inbound = deps();

		await expect(verifyForwarded(inbound, REQUEST)).resolves.toEqual({
			did: USER,
			lxm: REQUEST.lxm,
			peer: PEER,
		});
		expect(inbound.verify).toHaveBeenCalledWith("jwt", REQUEST.lxm);
		expect(inbound.allows).toHaveBeenCalledWith(USER, PEER);
	});

	it("refuses every forwarded request when federation is off", async () => {
		const inbound = deps({ enabled: false });

		await expect(verifyForwarded(inbound, REQUEST)).rejects.toMatchObject({
			customErrorName: "FederationDisabled",
		});
		expect(inbound.verify).not.toHaveBeenCalled();
	});

	it("refuses an acting-for value that isn't a DID", async () => {
		await expect(
			verifyForwarded(deps(), { ...REQUEST, actingFor: "alice.example" }),
		).rejects.toMatchObject({ customErrorName: "AuthRequired" });
	});

	it("refuses a token that doesn't verify", async () => {
		const inbound = deps({
			verify: async () => {
				throw new Error("bad signature");
			},
		});

		await expect(verifyForwarded(inbound, REQUEST)).rejects.toMatchObject({
			customErrorName: "AuthRequired",
			message: "bad signature",
		});
	});

	it("refuses a blocked peer before looking at the user", async () => {
		const inbound = deps({ isBlocked: async () => true });

		await expect(verifyForwarded(inbound, REQUEST)).rejects.toMatchObject({
			customErrorName: "PeerBlocked",
		});
		expect(inbound.allows).not.toHaveBeenCalled();
	});

	it("refuses a peer over its rate limit", async () => {
		await expect(
			verifyForwarded(deps({ limiter: { take: () => false } }), REQUEST),
		).rejects.toMatchObject({ customErrorName: "RateLimitExceeded", type: 429 });
	});

	it("refuses a peer the user hasn't declared", async () => {
		await expect(
			verifyForwarded(deps({ allows: async () => false }), REQUEST),
		).rejects.toMatchObject({ customErrorName: "NotDeclared", type: 403 });
	});
});

describe("createPeerLimiter", () => {
	it("allows a burst, then refills at the configured rate per peer", () => {
		let now = 0;
		const limiter = createPeerLimiter({ rate: 2, burst: 3, now: () => now });

		expect([1, 2, 3, 4].map(() => limiter.take(PEER))).toEqual([true, true, true, false]);
		expect(limiter.take("did:web:other.example")).toBe(true);

		now = 499;
		expect(limiter.take(PEER)).toBe(false);

		now = 1000;
		expect(limiter.take(PEER)).toBe(true);
		expect(limiter.take(PEER)).toBe(true);
		expect(limiter.take(PEER)).toBe(false);
	});
});

describe("createBlockCache", () => {
	it("asks the store again once the cached answer is 30 seconds old", async () => {
		let now = 0;
		const isBlocked = vi.fn(async () => false);
		const blocked = createBlockCache(isBlocked, { now: () => now });

		await blocked(PEER);
		now = 29_999;
		await blocked(PEER);
		expect(isBlocked).toHaveBeenCalledOnce();

		now = 30_000;
		await blocked(PEER);
		expect(isBlocked).toHaveBeenCalledTimes(2);
	});
});
