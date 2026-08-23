import type { Secp256k1Keypair } from "@atproto/crypto";
import { type IdentityConfig, SERVICE_FRAGMENTS, serviceId } from "./config.js";

export type VerificationMethod = {
	id: string;
	type: "Multikey";
	controller: string;
	publicKeyMultibase: string;
};

export type ServiceEntry = {
	id: string;
	type: string;
	serviceEndpoint: string;
};

export type DidDocument = {
	"@context": string[];
	id: string;
	verificationMethod: VerificationMethod[];
	service: ServiceEntry[];
};

export const buildDidDocument = (
	config: Pick<IdentityConfig, "did" | "publicUrl">,
	keypair: Secp256k1Keypair,
): DidDocument => ({
	"@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
	id: config.did,
	verificationMethod: [
		{
			id: serviceId(config.did, "atproto"),
			type: "Multikey",
			controller: config.did,
			publicKeyMultibase: keypair.did().slice("did:key:".length),
		},
	],
	service: [
		{
			id: `#${SERVICE_FRAGMENTS.appview}`,
			type: "ColibriAppView",
			serviceEndpoint: config.publicUrl,
		},
		{
			id: `#${SERVICE_FRAGMENTS.notifs}`,
			type: "ColibriNotificationService",
			serviceEndpoint: config.publicUrl,
		},
		{
			id: `#${SERVICE_FRAGMENTS.syncer}`,
			type: "AtprotoSpaceSyncer",
			serviceEndpoint: config.publicUrl,
		},
	],
});
