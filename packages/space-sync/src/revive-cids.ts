import { decodeCid, isCid } from "@atproto/lex-data";

export const reviveCids = (value: unknown): unknown => {
	if (value instanceof Uint8Array) return value;
	if (isCid(value)) return decodeCid(value.bytes);
	if (Array.isArray(value)) return value.map(reviveCids);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, reviveCids(entry)]));
};
