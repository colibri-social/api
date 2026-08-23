import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dimensionsOf, renderVariant } from "./variants.js";

const stillImage = (width: number, height: number) =>
	sharp({
		create: { width, height, channels: 3, background: { r: 200, g: 20, b: 20 } },
	})
		.png()
		.toBuffer();

const animatedGif = async (width: number, height: number, frames: number) => {
	const pngFrames = await Promise.all(
		Array.from({ length: frames }, (_, index) =>
			sharp({
				create: { width, height, channels: 3, background: { r: index * 10, g: 0, b: 0 } },
			})
				.png()
				.toBuffer(),
		),
	);
	return sharp(pngFrames, { join: { animated: true, across: 1 } })
		.gif()
		.toBuffer();
};

describe("renderVariant", () => {
	it("returns the original bytes untouched for the full variant", async () => {
		const bytes = await stillImage(500, 500);
		const rendered = await renderVariant(bytes, "image/png", "full");
		expect(rendered.bytes).toEqual(bytes);
		expect(rendered.mimeType).toBe("image/png");
	});

	it("returns non-image bytes untouched even for a resizable variant", async () => {
		const bytes = new TextEncoder().encode("%PDF-1.4 not really an image");
		const rendered = await renderVariant(bytes, "application/pdf", "thumbnail");
		expect(rendered.bytes).toEqual(bytes);
		expect(rendered.mimeType).toBe("application/pdf");
	});

	it("constrains a thumbnail to a 320px max edge", async () => {
		const bytes = await stillImage(1024, 512);
		const rendered = await renderVariant(bytes, "image/png", "thumbnail");
		const metadata = await sharp(rendered.bytes).metadata();
		expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(320);
		expect(rendered.mimeType).toBe("image/webp");
	});

	it("never upscales a thumbnail smaller than the max edge", async () => {
		const bytes = await stillImage(32, 32);
		const rendered = await renderVariant(bytes, "image/png", "thumbnail");
		const metadata = await sharp(rendered.bytes).metadata();
		expect(metadata.width).toBe(32);
		expect(metadata.height).toBe(32);
	});

	it("crops an avatar to a 256x256 square", async () => {
		const bytes = await stillImage(800, 400);
		const rendered = await renderVariant(bytes, "image/png", "avatar");
		const metadata = await sharp(rendered.bytes).metadata();
		expect(metadata.width).toBe(256);
		expect(metadata.height).toBe(256);
	});

	it("never upscales an avatar smaller than 256px", async () => {
		const bytes = await stillImage(100, 50);
		const rendered = await renderVariant(bytes, "image/png", "avatar");
		const metadata = await sharp(rendered.bytes).metadata();
		expect(metadata.width).toBeLessThanOrEqual(100);
		expect(metadata.height).toBeLessThanOrEqual(50);
	});

	it("crops a banner to 1500x500", async () => {
		const bytes = await stillImage(3000, 3000);
		const rendered = await renderVariant(bytes, "image/png", "banner");
		const metadata = await sharp(rendered.bytes).metadata();
		expect(metadata.width).toBe(1500);
		expect(metadata.height).toBe(500);
	});

	it("re-encodes a still raster source to WebP", async () => {
		const bytes = await stillImage(200, 200);
		const rendered = await renderVariant(bytes, "image/png", "avatar");
		expect(rendered.mimeType).toBe("image/webp");
		const metadata = await sharp(rendered.bytes).metadata();
		expect(metadata.format).toBe("webp");
	});

	it("keeps an animated GIF animated after resizing", async () => {
		const gif = await animatedGif(200, 100, 3);
		const rendered = await renderVariant(gif, "image/gif", "thumbnail");
		expect(rendered.mimeType).toBe("image/gif");
		const metadata = await sharp(rendered.bytes, { animated: true }).metadata();
		expect(metadata.pages).toBe(3);
	});
});

describe("dimensionsOf", () => {
	it("reports the intrinsic width and height of a still image", async () => {
		const bytes = await stillImage(640, 480);
		expect(await dimensionsOf(bytes)).toEqual({ width: 640, height: 480 });
	});

	it("reports a single frame's dimensions for an animated image", async () => {
		const gif = await animatedGif(120, 80, 4);
		expect(await dimensionsOf(gif)).toEqual({ width: 120, height: 80 });
	});

	it("returns null for bytes that are not a decodable image", async () => {
		const bytes = new TextEncoder().encode("definitely not an image");
		expect(await dimensionsOf(bytes)).toBeNull();
	});
});
