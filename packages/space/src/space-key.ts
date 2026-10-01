import { P256Keypair } from "@atproto/crypto";
import { createSpaceSigHeaders } from "@atproto/space";
import type { DidString } from "@atproto/syntax";

export type SpaceSignatureRequest = {
	authorization: string;
	audience?: DidString;
};

export class SpaceKey {
	private constructor(private readonly keypair: P256Keypair) {}

	static async generate(): Promise<SpaceKey> {
		return new SpaceKey(await P256Keypair.create({ exportable: true }));
	}

	static async fromExported(privateKey: string): Promise<SpaceKey> {
		return new SpaceKey(
			await P256Keypair.import(Buffer.from(privateKey, "base64"), { exportable: true }),
		);
	}

	get did(): string {
		return this.keypair.did();
	}

	async export(): Promise<string> {
		return Buffer.from(await this.keypair.export()).toString("base64");
	}

	headers(request: SpaceSignatureRequest): Promise<Record<string, string>> {
		return createSpaceSigHeaders(this.keypair, request);
	}
}
