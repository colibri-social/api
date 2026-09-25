import { type IdentityResolver, ServiceAuth } from "@colibri-social/identity";
import { describe, expect, it } from "vitest";
import { createServiceAuthSigner, generateSigningKey, publicDidKeyFor } from "./auth.js";
import { bridgeDidDocument } from "./identity.js";

const BRIDGE = "did:web:bridge.example.com";
const APPVIEW = "did:web:api.example.com";

const verifierFor = (publicDidKey: string) =>
	new ServiceAuth({
		audience: APPVIEW,
		maxLifetimeSeconds: 300,
		resolver: { signingKeyFor: async () => publicDidKey } as unknown as IdentityResolver,
	});

describe("createServiceAuthSigner", () => {
	it("mints a token the AppView's verifier accepts", async () => {
		const key = await generateSigningKey();
		const signer = await createServiceAuthSigner(BRIDGE, key.privateKeyHex);

		const token = await signer.token(APPVIEW, "social.colibri.beta.bridge.postMessage");
		const caller = await verifierFor(key.publicDidKey).verify(
			token,
			"social.colibri.beta.bridge.postMessage",
		);

		expect(caller).toEqual({ did: BRIDGE, lxm: "social.colibri.beta.bridge.postMessage" });
	});

	it("is refused for a different method", async () => {
		const key = await generateSigningKey();
		const signer = await createServiceAuthSigner(BRIDGE, key.privateKeyHex);
		const token = await signer.token(APPVIEW, "social.colibri.beta.bridge.postMessage");

		await expect(
			verifierFor(key.publicDidKey).verify(token, "social.colibri.beta.bridge.revoke"),
		).rejects.toThrow();
	});
});

describe("bridgeDidDocument", () => {
	it("publishes the signing key under the atproto verification method", async () => {
		const key = await generateSigningKey();

		const document = bridgeDidDocument(BRIDGE, await publicDidKeyFor(key.privateKeyHex));

		expect(document.verificationMethod[0]).toMatchObject({
			id: `${BRIDGE}#atproto`,
			type: "Multikey",
			publicKeyMultibase: key.publicDidKey.replace("did:key:", ""),
		});
	});
});
