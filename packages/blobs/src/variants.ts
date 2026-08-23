import sharp from "sharp";
import type { AllowedMimeType } from "./mime.js";

export const VARIANTS = ["thumbnail", "avatar", "banner", "full"] as const;

export type Variant = (typeof VARIANTS)[number];

export const isVariant = (value: string): value is Variant =>
	(VARIANTS as readonly string[]).includes(value);

export type Dimensions = {
	width: number;
	height: number;
};

export type RenderedVariant = {
	bytes: Uint8Array;
	mimeType: string;
};

const RESIZABLE_MIME_TYPES = new Set<AllowedMimeType>([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
]);

export const isResizableImage = (mimeType: string): boolean =>
	RESIZABLE_MIME_TYPES.has(mimeType as AllowedMimeType);

type Bounds = {
	width: number;
	height: number;
	fit: "inside" | "cover";
};

const boundsFor = (variant: Exclude<Variant, "full">): Bounds => {
	if (variant === "thumbnail") return { width: 320, height: 320, fit: "inside" };
	if (variant === "avatar") return { width: 256, height: 256, fit: "cover" };
	return { width: 1500, height: 500, fit: "cover" };
};

const animatedFormatFor = (mimeType: string): "gif" | "webp" =>
	mimeType === "image/gif" ? "gif" : "webp";

export const renderVariant = async (
	bytes: Uint8Array,
	mimeType: string,
	variant: Variant,
): Promise<RenderedVariant> => {
	if (variant === "full" || !isResizableImage(mimeType)) {
		return { bytes, mimeType };
	}

	const probe = sharp(bytes, { animated: true });
	const metadata = await probe.metadata();
	const animated = (metadata.pages ?? 1) > 1;
	const bounds = boundsFor(variant);

	const pipeline = sharp(bytes, { animated }).resize({
		width: bounds.width,
		height: bounds.height,
		fit: bounds.fit,
		withoutEnlargement: true,
	});

	if (animated) {
		const outputFormat = animatedFormatFor(mimeType);
		const outBytes = await pipeline.toFormat(outputFormat).toBuffer();
		return { bytes: outBytes, mimeType: `image/${outputFormat}` };
	}

	const outBytes = await pipeline.toFormat("webp").toBuffer();
	return { bytes: outBytes, mimeType: "image/webp" };
};

export const dimensionsOf = async (bytes: Uint8Array): Promise<Dimensions | null> => {
	try {
		const metadata = await sharp(bytes).metadata();
		const width = metadata.width;
		const height = metadata.pageHeight ?? metadata.height;
		if (!width || !height) return null;
		return { width, height };
	} catch {
		return null;
	}
};
