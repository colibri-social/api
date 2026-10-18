import { fileTypeFromBuffer } from "file-type";
import { BlobRejectedError } from "./errors.js";

export const ALLOWED_MIME_TYPES = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"video/mp4",
	"video/webm",
	"audio/mpeg",
	"audio/ogg",
	"audio/wav",
	"application/pdf",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

const ALLOWED = new Set<string>(ALLOWED_MIME_TYPES);

export const isAllowedMimeType = (mimeType: string): mimeType is AllowedMimeType =>
	ALLOWED.has(mimeType);

export const sniffMimeType = async (bytes: Uint8Array): Promise<AllowedMimeType> => {
	const detected = await fileTypeFromBuffer(bytes);
	const mimeType = detected?.mime.split(";")[0]?.trim();
	if (!mimeType || !isAllowedMimeType(mimeType)) {
		throw new BlobRejectedError("mimeNotAllowed", mimeType ?? "unknown");
	}
	return mimeType;
};

export const DOWNLOAD_MIME_TYPE = "application/octet-stream";

export type ServedMimeType = AllowedMimeType | typeof DOWNLOAD_MIME_TYPE;

export const isDownloadMimeType = (mimeType: string): boolean => mimeType === DOWNLOAD_MIME_TYPE;

export const sniffServedType = async (bytes: Uint8Array): Promise<ServedMimeType> => {
	const detected = await fileTypeFromBuffer(bytes);
	const mimeType = detected?.mime.split(";")[0]?.trim();
	return mimeType && isAllowedMimeType(mimeType) ? mimeType : DOWNLOAD_MIME_TYPE;
};
