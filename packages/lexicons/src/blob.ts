import {
	getBlobCidString,
	isBlobRef,
	type JsonValue,
	jsonToLex,
	type LexValue,
	lexToJson,
} from "@atproto/lex";

export const toLexForm = <T>(value: T): T => jsonToLex(value as JsonValue) as T;

export const toJsonForm = <T>(value: T): T => lexToJson(value as LexValue) as T;

export const blobCid = (blob: unknown): string | null => {
	if (isBlobRef(blob)) return getBlobCidString(blob);
	const ref = (blob as { ref?: { $link?: unknown } } | null | undefined)?.ref;
	return typeof ref?.$link === "string" ? ref.$link : null;
};
