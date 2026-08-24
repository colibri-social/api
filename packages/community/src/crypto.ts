import { randomBytes, webcrypto } from "node:crypto";

const ALGORITHM = "AES-GCM";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export class MasterKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MasterKeyError";
	}
}

export type Sealed = {
	ciphertextBase64: string;
	nonceBase64: string;
};

const bytes = (value: Buffer | Uint8Array): Uint8Array<ArrayBuffer> => {
	const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
	copy.set(value);
	return copy;
};

export class SecretBox {
	private constructor(private readonly key: webcrypto.CryptoKey) {}

	static async fromBase64(encoded: string): Promise<SecretBox> {
		let raw: Buffer;
		try {
			raw = Buffer.from(encoded, "base64");
		} catch {
			throw new MasterKeyError("the credential encryption key is not valid base64");
		}
		if (raw.byteLength !== KEY_BYTES) {
			throw new MasterKeyError(
				`the credential encryption key must be ${KEY_BYTES} bytes, got ${raw.byteLength}`,
			);
		}
		const key = await webcrypto.subtle.importKey("raw", bytes(raw), ALGORITHM, false, [
			"encrypt",
			"decrypt",
		]);
		return new SecretBox(key);
	}

	static generateKeyBase64(): string {
		return randomBytes(KEY_BYTES).toString("base64");
	}

	async seal(plaintext: string): Promise<Sealed> {
		const nonce = randomBytes(NONCE_BYTES);
		const ciphertext = await webcrypto.subtle.encrypt(
			{ name: ALGORITHM, iv: bytes(nonce) },
			this.key,
			bytes(Buffer.from(plaintext, "utf8")),
		);
		return {
			ciphertextBase64: Buffer.from(ciphertext).toString("base64"),
			nonceBase64: nonce.toString("base64"),
		};
	}

	async open(sealed: Sealed): Promise<string> {
		const plaintext = await webcrypto.subtle.decrypt(
			{ name: ALGORITHM, iv: bytes(Buffer.from(sealed.nonceBase64, "base64")) },
			this.key,
			bytes(Buffer.from(sealed.ciphertextBase64, "base64")),
		);
		return Buffer.from(plaintext).toString("utf8");
	}
}

const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const generatePassword = (length = 40): string => {
	const bytes = randomBytes(length);
	let out = "";
	for (const byte of bytes) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
	return out;
};

const HANDLE_LETTERS = "abcdefghijkmnopqrstuvwxyz";
const HANDLE_ALPHABET = `${HANDLE_LETTERS}23456789`;

export const generateHandlePrefix = (length = 16): string => {
	const bytes = randomBytes(length);
	let out = HANDLE_LETTERS[(bytes[0] as number) % HANDLE_LETTERS.length] as string;
	for (let i = 1; i < length; i++) {
		out += HANDLE_ALPHABET[(bytes[i] as number) % HANDLE_ALPHABET.length];
	}
	return out;
};
