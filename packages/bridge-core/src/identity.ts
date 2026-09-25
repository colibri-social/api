export type BridgeDidDocument = {
	"@context": string[];
	id: string;
	verificationMethod: Array<{
		id: string;
		type: "Multikey";
		controller: string;
		publicKeyMultibase: string;
	}>;
};

export const bridgeDidDocument = (did: string, publicDidKey: string): BridgeDidDocument => ({
	"@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
	id: did,
	verificationMethod: [
		{
			id: `${did}#atproto`,
			type: "Multikey",
			controller: did,
			publicKeyMultibase: publicDidKey.replace(/^did:key:/, ""),
		},
	],
});
