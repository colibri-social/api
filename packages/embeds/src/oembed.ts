import type { Dispatcher } from "undici";
import { z } from "zod";
import { type GuardedFetchResult, guardedFetch, type HostResolver } from "./fetch.js";
import type { LinkTag } from "./html.js";
import type { EmbedAuthor, EmbedProvider } from "./types.js";

const OEMBED_MAX_BYTES = 64 * 1024;
const OEMBED_TYPE = "application/json+oembed";
const AUTHOR_NAME_MAX = 100;

const oEmbedSchema = z.object({
	author_name: z.string().optional(),
	author_url: z.string().optional(),
	provider_name: z.string().optional(),
	provider_url: z.string().optional(),
});

export type OEmbedFields = {
	provider?: EmbedProvider;
	author?: EmbedAuthor;
	text?: string;
};

export type OEmbedFetchOptions = {
	timeoutMs?: number;
	dispatcher?: Dispatcher;
	resolveHost?: HostResolver;
};

const httpUrl = (raw: string | undefined, base?: URL): string | undefined => {
	if (!raw) return undefined;
	try {
		const url = new URL(raw.trim(), base);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
};

export function findOEmbedUrl(links: readonly LinkTag[], base: URL): string | undefined {
	const link = links.find((entry) => entry.rel.includes("alternate") && entry.type === OEMBED_TYPE);
	return httpUrl(link?.href, base);
}

const looksLikeText = (value: string): boolean =>
	value.includes("\n") || value.length > AUTHOR_NAME_MAX;

export function oEmbedFields(json: unknown): OEmbedFields | undefined {
	const parsed = oEmbedSchema.safeParse(json);
	if (!parsed.success) return undefined;
	const data = parsed.data;

	const providerName = data.provider_name?.trim();
	const providerUrl = httpUrl(data.provider_url);
	const authorName = data.author_name?.trim();
	const authorUrl = httpUrl(data.author_url);

	const fields: OEmbedFields = {};
	if (providerName) {
		fields.provider = { name: providerName, ...(providerUrl ? { url: providerUrl } : {}) };
	}
	if (authorName) {
		if (looksLikeText(authorName)) fields.text = authorName;
		else fields.author = { name: authorName, ...(authorUrl ? { url: authorUrl } : {}) };
	}
	return fields;
}

const parseJson = (result: GuardedFetchResult): unknown => {
	if (result.statusCode < 200 || result.statusCode >= 300 || result.truncated) return undefined;
	try {
		return JSON.parse(result.body.toString("utf8"));
	} catch {
		return undefined;
	}
};

export async function fetchOEmbed(
	url: string,
	options: OEmbedFetchOptions = {},
): Promise<OEmbedFields | undefined> {
	let result: GuardedFetchResult;
	try {
		result = await guardedFetch(url, {
			headers: { accept: "application/json" },
			timeoutMs: options.timeoutMs,
			maxResponseBytes: OEMBED_MAX_BYTES,
			dispatcher: options.dispatcher,
			resolveHost: options.resolveHost,
		});
	} catch {
		return undefined;
	}
	return oEmbedFields(parseJson(result));
}
