import { JoseKey } from "@atproto/jwk-jose";
import { createDpopProof, dpopJktForKey } from "@atproto/space";

export type DpopProofRequest = {
	method: string;
	url: string;
	credential?: string;
};

export class DpopKey {
	private constructor(
		private readonly key: JoseKey,
		readonly thumbprint: string,
	) {}

	static async generate(): Promise<DpopKey> {
		const key = await JoseKey.generate(["ES256"]);
		return new DpopKey(key, await dpopJktForKey(key));
	}

	static async fromJwk(jwk: string): Promise<DpopKey> {
		const key = await JoseKey.fromImportable(JSON.parse(jwk));
		return new DpopKey(key, await dpopJktForKey(key));
	}

	exportJwk(): string {
		return JSON.stringify(this.key.privateJwk);
	}

	proof({ method, url, credential }: DpopProofRequest): Promise<string> {
		const htu = canonicalHtu(url);
		return createDpopProof(
			this.key,
			credential ? { htm: method, htu, credential } : { htm: method, htu },
		);
	}
}

const canonicalHtu = (url: string): string => {
	const parsed = new URL(url);
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
};
