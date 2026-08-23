import { Secp256k1Keypair } from "@atproto/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ServiceAuthError } from "./errors.js";
import type { IdentityResolver } from "./resolver.js";
import { mintServiceAuth, ServiceAuth } from "./service-auth.js";

const AUDIENCE = "did:web:appview.example";
const ISSUER = "did:web:user.example";

let keypair: Secp256k1Keypair;
let otherKeypair: Secp256k1Keypair;

const resolverFor = (key: Secp256k1Keypair): IdentityResolver =>
	({ signingKeyFor: async () => key.did() }) as unknown as IdentityResolver;

const authFor = (
	options: {
		key?: Secp256k1Keypair;
		maxLifetimeSeconds?: number;
		audience?: string | readonly string[];
	} = {},
) =>
	new ServiceAuth({
		audience: options.audience ?? AUDIENCE,
		maxLifetimeSeconds: options.maxLifetimeSeconds ?? 300,
		resolver: resolverFor(options.key ?? keypair),
	});

const mint = (overrides: { aud?: string; lxm?: string | null; lifetimeSeconds?: number } = {}) =>
	mintServiceAuth({
		issuer: ISSUER,
		audience: overrides.aud ?? AUDIENCE,
		lxm: overrides.lxm === undefined ? "social.colibri.beta.actor.getProfile" : overrides.lxm,
		keypair,
		lifetimeSeconds: overrides.lifetimeSeconds ?? 60,
	});

beforeAll(async () => {
	keypair = await Secp256k1Keypair.create({ exportable: true });
	otherKeypair = await Secp256k1Keypair.create({ exportable: true });
});

describe("service auth", () => {
	it("accepts a token minted for this audience and method", async () => {
		const caller = await authFor().verify(await mint(), "social.colibri.beta.actor.getProfile");
		expect(caller).toEqual({ did: ISSUER, lxm: "social.colibri.beta.actor.getProfile" });
	});

	it("refuses a token minted for another audience", async () => {
		const token = await mint({ aud: "did:web:someone.else" });
		await expect(authFor().verify(token, null)).rejects.toBeInstanceOf(ServiceAuthError);
	});

	it("accepts any identifier this service answers as", async () => {
		const serviceId = `${AUDIENCE}#colibri_appview`;
		const audience = [AUDIENCE, serviceId];

		const bare = await authFor({ audience }).verify(await mint(), null);
		expect(bare.did).toBe(ISSUER);

		const fragment = await authFor({ audience }).verify(await mint({ aud: serviceId }), null);
		expect(fragment.did).toBe(ISSUER);
	});

	it("refuses a service fragment it does not answer as", async () => {
		const token = await mint({ aud: `${AUDIENCE}#someone_elses_service` });
		await expect(
			authFor({ audience: [AUDIENCE, `${AUDIENCE}#colibri_appview`] }).verify(token, null),
		).rejects.toMatchObject({ failure: "wrongAudience" });
	});

	it("refuses a token minted for another method", async () => {
		const token = await mint({ lxm: "social.colibri.beta.actor.setStatus" });
		await expect(
			authFor().verify(token, "social.colibri.beta.actor.getProfile"),
		).rejects.toBeInstanceOf(ServiceAuthError);
	});

	it("refuses a token signed by a different key", async () => {
		const token = await mint();
		await expect(authFor({ key: otherKeypair }).verify(token, null)).rejects.toMatchObject({
			failure: "badSignature",
		});
	});

	it("refuses an expired token", async () => {
		const token = await mint({ lifetimeSeconds: -10 });
		await expect(authFor().verify(token, null)).rejects.toMatchObject({ failure: "expired" });
	});

	it("refuses a token whose lifetime exceeds the cap, before resolving anything", async () => {
		const token = await mint({ lifetimeSeconds: 3600 });
		const auth = new ServiceAuth({
			audience: AUDIENCE,
			maxLifetimeSeconds: 300,
			resolver: {
				signingKeyFor: () => {
					throw new Error("must not resolve an over-long token");
				},
			} as unknown as IdentityResolver,
		});
		await expect(auth.verify(token, null)).rejects.toMatchObject({ failure: "lifetimeTooLong" });
	});

	it("refuses a token that is not a JWT", async () => {
		await expect(authFor().verify("not-a-jwt", null)).rejects.toMatchObject({
			failure: "malformed",
		});
	});

	it("skips the method check when none is required", async () => {
		const caller = await authFor().verify(await mint({ lxm: null }), null);
		expect(caller.did).toBe(ISSUER);
	});
});
