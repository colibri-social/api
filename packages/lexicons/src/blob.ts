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

const MAX_LINK_DEPTH = 4;

export const linkCid = (link: unknown, depth = 0): string | null => {
	if (typeof link === "string") return link.length > 0 ? link : null;
	if (!link || typeof link !== "object" || depth >= MAX_LINK_DEPTH) return null;
	const record = link as { $link?: unknown; "/"?: unknown };
	if (record.$link !== undefined) return linkCid(record.$link, depth + 1);
	if (record["/"] !== undefined) return linkCid(record["/"], depth + 1);
	const text = String(link);
	return text.startsWith("[object") ? null : text;
};

export const blobCid = (blob: unknown): string | null => {
	if (isBlobRef(blob)) return getBlobCidString(blob);
	return linkCid((blob as { ref?: unknown } | null | undefined)?.ref);
};

export const withJsonBlobRef = <T>(item: T): T => {
	const blob = (item as { blob?: unknown } | null | undefined)?.blob;
	if (!blob || typeof blob !== "object") return item;
	const cid = blobCid(blob);
	if (!cid) return item;
	return { ...item, blob: { ...blob, ref: { $link: cid } } };
};
