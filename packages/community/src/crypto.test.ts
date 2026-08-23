import { describe, expect, it } from "vitest";
import { generatePassword, MasterKeyError, SecretBox } from "./crypto.js";

const box = () => SecretBox.fromBase64(SecretBox.generateKeyBase64());

describe("secret box", () => {
	it("round trips a password", async () => {
		const secrets = await box();
		const sealed = await secrets.seal("hunter2");
		expect(await secrets.open(sealed)).toBe("hunter2");
	});

	it("never repeats a nonce for the same plaintext", async () => {
		const secrets = await box();
		const first = await secrets.seal("same");
		const second = await secrets.seal("same");
		expect(first.nonceBase64).not.toBe(second.nonceBase64);
		expect(first.ciphertextBase64).not.toBe(second.ciphertextBase64);
	});

	it("refuses ciphertext sealed under a different key", async () => {
		const sealed = await (await box()).seal("hunter2");
		await expect((await box()).open(sealed)).rejects.toThrow();
	});

	it("refuses tampered ciphertext", async () => {
		const secrets = await box();
		const sealed = await secrets.seal("hunter2");
		const raw = Buffer.from(sealed.ciphertextBase64, "base64");
		raw[0] = (raw[0] ?? 0) ^ 0xff;
		await expect(
			secrets.open({ ...sealed, ciphertextBase64: raw.toString("base64") }),
		).rejects.toThrow();
	});

	it("refuses a key that is not 32 bytes", async () => {
		await expect(SecretBox.fromBase64(Buffer.alloc(16).toString("base64"))).rejects.toBeInstanceOf(
			MasterKeyError,
		);
	});
});

describe("generated passwords", () => {
	it("is long and unpredictable", () => {
		const passwords = new Set(Array.from({ length: 100 }, () => generatePassword()));
		expect(passwords.size).toBe(100);
		expect([...passwords][0]).toHaveLength(40);
	});

	it("avoids characters that are easy to misread", () => {
		const sample = Array.from({ length: 50 }, () => generatePassword()).join("");
		expect(sample).not.toMatch(/[lIO01]/);
	});
});
