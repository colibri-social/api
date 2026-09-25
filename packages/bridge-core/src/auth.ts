import { randomBytes } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";

export type ServiceAuthSigner = {
	did: string;
	token(audience: string, lxm: string): Promise<string>;
};

export type GeneratedSigningKey = {
	privateKeyHex: string;
	publicDidKey: string;
};

const encodeSegment = (value: unknown): string =>
	Buffer.from(JSON.stringify(value)).toString("base64url");

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export const createServiceAuthSigner = async (
	did: string,
	privateKeyHex: string,
	lifetimeSeconds = 60,
): Promise<ServiceAuthSigner> => {
	const keypair = await Secp256k1Keypair.import(privateKeyHex);
	return {
		did,
		token: async (audience, lxm) => {
			const issuedAt = Math.floor(Date.now() / 1000);
			const unsigned = `${encodeSegment({ typ: "JWT", alg: keypair.jwtAlg })}.${encodeSegment({
				iss: did,
				aud: audience,
				iat: issuedAt,
				exp: issuedAt + lifetimeSeconds,
				lxm,
				jti: randomBytes(16).toString("hex"),
			})}`;
			const signature = await keypair.sign(new TextEncoder().encode(unsigned));
			return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
		},
	};
};

export const generateSigningKey = async (): Promise<GeneratedSigningKey> => {
	const keypair = await Secp256k1Keypair.create({ exportable: true });
	return { privateKeyHex: hex(await keypair.export()), publicDidKey: keypair.did() };
};

export const publicDidKeyFor = async (privateKeyHex: string): Promise<string> =>
	(await Secp256k1Keypair.import(privateKeyHex)).did();
