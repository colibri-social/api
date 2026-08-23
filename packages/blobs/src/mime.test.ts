import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BlobRejectedError } from "./errors.js";
import { ALLOWED_MIME_TYPES, sniffMimeType } from "./mime.js";

const pngBytes = () =>
	sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
		.png()
		.toBuffer();

describe("sniffMimeType", () => {
	it("detects the real type from bytes rather than trusting a declared content type", async () => {
		const bytes = await pngBytes();
		const sniffed = await sniffMimeType(bytes);
		expect(sniffed).toBe("image/png");
	});

	it("rejects a bitmap that file-type recognises but the allowlist does not", async () => {
		const bmp = new Uint8Array(64);
		bmp[0] = 0x42;
		bmp[1] = 0x4d;

		await expect(sniffMimeType(bmp)).rejects.toMatchObject({
			name: "BlobRejectedError",
			reason: "mimeNotAllowed",
		});
	});

	it("rejects text/html", async () => {
		const html = new TextEncoder().encode("<!doctype html><html><body>hi</body></html>");
		await expect(sniffMimeType(html)).rejects.toBeInstanceOf(BlobRejectedError);
	});

	it("rejects an SVG image", async () => {
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
		await expect(sniffMimeType(svg)).rejects.toBeInstanceOf(BlobRejectedError);
	});

	it("accepts a PDF", async () => {
		const pdf = new TextEncoder().encode("%PDF-1.4\n%rest of a fake but recognisable pdf\n");
		const sniffed = await sniffMimeType(pdf);
		expect(sniffed).toBe("application/pdf");
	});

	it("exposes the allowlist for callers", () => {
		expect(ALLOWED_MIME_TYPES).toContain("image/jpeg");
		expect(ALLOWED_MIME_TYPES).toContain("application/pdf");
		expect(ALLOWED_MIME_TYPES).not.toContain("text/html");
	});
});
