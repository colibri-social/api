import type { Dispatcher } from "undici";
import { z } from "zod";
import { type GuardedFetchResult, guardedFetch, type HostResolver } from "./fetch.js";
import type {
	EmbedAuthor,
	EmbedMedia,
	EmbedProvider,
	EmbedQuote,
	EmbedStats,
	LinkEmbed,
	RichBlock,
	RichSpan,
} from "./types.js";
import { playableVideoType } from "./video.js";

const API_ORIGIN = "https://api.fxtwitter.com";
const STATUS_MAX_BYTES = 512 * 1024;
const MAX_MEDIA = 4;
const STATUS_ID = /^\d{1,25}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const LANGUAGE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const MEDIA_SEGMENTS = new Set(["photo", "photos", "video", "videos"]);

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);

type FixerHost = { domain: string; provider: EmbedProvider; themeColor: string };

const FXEMBED_COLOR = "#6363ff";
const X_COLOR = "#1d9bf0";

const FIXER_HOSTS: FixerHost[] = [
	{
		domain: "fixupx.com",
		provider: {
			name: "FixupX",
			url: "https://fixupx.com",
			icon: "https://assets.fxembed.com/logos/fixupx64.png",
		},
		themeColor: FXEMBED_COLOR,
	},
	{
		domain: "fxtwitter.com",
		provider: {
			name: "FxTwitter",
			url: "https://fxtwitter.com",
			icon: "https://assets.fxembed.com/logos/fxtwitter64.png",
		},
		themeColor: FXEMBED_COLOR,
	},
	{
		domain: "twittpr.com",
		provider: {
			name: "FxTwitter",
			url: "https://fxtwitter.com",
			icon: "https://assets.fxembed.com/logos/fxtwitter64.png",
		},
		themeColor: FXEMBED_COLOR,
	},
	{ domain: "vxtwitter.com", provider: { name: "vxTwitter" }, themeColor: X_COLOR },
	{ domain: "fixvx.com", provider: { name: "vxTwitter" }, themeColor: X_COLOR },
];

const X_PROVIDER: EmbedProvider = { name: "X", url: "https://x.com" };

export type XStatusLink = {
	id: string;
	handle?: string;
	language?: string;
	provider: EmbedProvider;
	themeColor: string;
};

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");

const hostInfo = (host: string): Pick<XStatusLink, "provider" | "themeColor"> | undefined => {
	const bare = stripWww(host);
	if (X_HOSTS.has(bare)) return { provider: X_PROVIDER, themeColor: X_COLOR };
	const fixer = FIXER_HOSTS.find(
		(entry) => bare === entry.domain || bare.endsWith(`.${entry.domain}`),
	);
	return fixer ? { provider: fixer.provider, themeColor: fixer.themeColor } : undefined;
};

export function parseXStatusUrl(rawUrl: string): XStatusLink | undefined {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const info = hostInfo(url.hostname);
	if (!info) return undefined;

	const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
	const statusIndex = segments.findIndex(
		(segment) => segment === "status" || segment === "statuses",
	);
	if (statusIndex < 1) return undefined;
	const id = segments[statusIndex + 1];
	if (!id || !STATUS_ID.test(id)) return undefined;

	const owner = segments[statusIndex - 1];
	const handle = owner && owner !== "i" && HANDLE.test(owner) ? owner : undefined;

	let rest = segments.slice(statusIndex + 2);
	if (rest[0] && MEDIA_SEGMENTS.has(rest[0])) rest = rest.slice(2);
	const language = rest.length === 1 && LANGUAGE.test(rest[0] ?? "") ? rest[0] : undefined;

	return {
		id,
		...(handle ? { handle } : {}),
		...(language ? { language: language.toLowerCase() } : {}),
		...info,
	};
}

const facetSchema = z
	.object({
		type: z.string(),
		indices: z.tuple([z.number(), z.number()]),
		original: z.string().nullish(),
		replacement: z.string().nullish(),
		display: z.string().nullish(),
	})
	.passthrough();

const rawTextSchema = z
	.object({
		text: z.string(),
		display_text_range: z.tuple([z.number(), z.number()]).nullish(),
		facets: z.array(facetSchema).nullish(),
	})
	.passthrough();

const translationSchema = z
	.object({ text: z.string(), source_lang: z.string().nullish() })
	.passthrough();

const authorSchema = z
	.object({
		name: z.string().nullish(),
		screen_name: z.string(),
		url: z.string().nullish(),
		avatar_url: z.string().nullish(),
	})
	.passthrough();

const mediaSchema = z
	.object({
		type: z.string(),
		url: z.string(),
		thumbnail_url: z.string().nullish(),
		width: z.number().nullish(),
		height: z.number().nullish(),
		format: z.string().nullish(),
		altText: z.string().nullish(),
	})
	.passthrough();

const baseStatusSchema = z
	.object({
		url: z.string(),
		text: z.string().nullish(),
		raw_text: rawTextSchema.nullish(),
		translation: translationSchema.nullish(),
		author: authorSchema,
		created_timestamp: z.number().nullish(),
		possibly_sensitive: z.boolean().nullish(),
		replies: z.number().nullish(),
		reposts: z.number().nullish(),
		retweets: z.number().nullish(),
		likes: z.number().nullish(),
		views: z.number().nullish(),
		media: z
			.object({ all: z.array(mediaSchema).nullish() })
			.passthrough()
			.nullish(),
	})
	.passthrough();

const statusSchema = baseStatusSchema.extend({ quote: baseStatusSchema.nullish() });

const responseSchema = z.object({ status: statusSchema }).passthrough();

type ApiStatus = z.infer<typeof baseStatusSchema>;

const httpUrl = (raw: string | null | undefined): string | undefined => {
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
};

const count = (value: number | null | undefined): number | undefined =>
	value !== null && value !== undefined && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined;

const positive = (value: number | null | undefined): number | undefined => {
	const rounded = count(value);
	return rounded !== undefined && rounded > 0 ? rounded : undefined;
};

const facetHref = (facet: z.infer<typeof facetSchema>, text: string): string | undefined => {
	switch (facet.type) {
		case "url":
			return httpUrl(facet.replacement) ?? httpUrl(facet.original);
		case "mention":
			return `https://x.com/${encodeURIComponent(text.replace(/^@/, ""))}`;
		case "hashtag":
			return `https://x.com/hashtag/${encodeURIComponent(text.replace(/^#/, ""))}`;
		default:
			return undefined;
	}
};

export function rawTextToBlocks(raw: z.infer<typeof rawTextSchema>): RichBlock[] {
	const [start, end] = raw.display_text_range ?? [0, raw.text.length];
	const facets = [...(raw.facets ?? [])]
		.filter((facet) => facet.indices[0] >= start && facet.indices[1] <= end)
		.sort((a, b) => a.indices[0] - b.indices[0]);

	const spans: RichSpan[] = [];
	let cursor = start;
	for (const facet of facets) {
		const [from, to] = facet.indices;
		if (from < cursor) continue;
		if (from > cursor) spans.push({ text: raw.text.slice(cursor, from) });
		const original = raw.text.slice(from, to);
		cursor = to;
		if (facet.type === "media") continue;
		if (facet.type === "bold") {
			spans.push({ text: original, bold: true });
			continue;
		}
		const text = facet.type === "url" ? (facet.display ?? original) : original;
		const href = facetHref(facet, original);
		spans.push(href ? { text, href } : { text });
	}
	if (cursor < end) spans.push({ text: raw.text.slice(cursor, end) });
	return textBlocks(spans);
}

const textBlocks = (spans: RichSpan[]): RichBlock[] => {
	const trimmed = spans.filter((span) => span.text.length > 0);
	const first = trimmed[0];
	if (first) first.text = first.text.replace(/^\s+/, "");
	const last = trimmed[trimmed.length - 1];
	if (last) last.text = last.text.replace(/\s+$/, "");
	const kept = trimmed.filter((span) => span.text.length > 0);
	return kept.length > 0 ? [{ kind: "paragraph", spans: kept }] : [];
};

const bodyOf = (status: ApiStatus): { body: RichBlock[]; translatedFrom?: string } => {
	if (status.translation?.text) {
		const source = status.translation.source_lang?.trim();
		return {
			body: textBlocks([{ text: status.translation.text }]),
			...(source ? { translatedFrom: source } : {}),
		};
	}
	if (status.raw_text) return { body: rawTextToBlocks(status.raw_text) };
	return { body: textBlocks([{ text: status.text ?? "" }]) };
};

const authorOf = (status: ApiStatus): EmbedAuthor => {
	const avatar = httpUrl(status.author.avatar_url);
	const profile = httpUrl(status.author.url);
	return {
		name: status.author.name?.trim() || status.author.screen_name,
		handle: status.author.screen_name,
		...(profile ? { url: profile } : {}),
		...(avatar ? { avatar } : {}),
	};
};

const mediaOf = (status: ApiStatus): EmbedMedia[] => {
	const out: EmbedMedia[] = [];
	for (const item of status.media?.all ?? []) {
		const url = httpUrl(item.url);
		if (!url) continue;
		const width = positive(item.width);
		const height = positive(item.height);
		const alt = item.altText?.trim();
		const sized = {
			...(width !== undefined ? { width } : {}),
			...(height !== undefined ? { height } : {}),
			...(alt ? { alt } : {}),
		};
		if (item.type === "photo") {
			out.push({ kind: "image", url, ...sized });
			continue;
		}
		if (item.type !== "video" && item.type !== "gif") continue;
		const previewUrl = httpUrl(item.thumbnail_url);
		out.push({
			kind: item.type === "gif" ? "gifv" : "video",
			url,
			mimeType: playableVideoType(item.format ?? "") ?? "video/mp4",
			...(previewUrl ? { previewUrl } : {}),
			...sized,
		});
	}
	return out.slice(0, MAX_MEDIA);
};

const publishedAtOf = (status: ApiStatus): string | undefined => {
	const seconds = count(status.created_timestamp);
	return seconds ? new Date(seconds * 1000).toISOString() : undefined;
};

const statsOf = (status: ApiStatus): EmbedStats | undefined => {
	const stats: EmbedStats = {};
	const replies = count(status.replies);
	const reposts = count(status.reposts ?? status.retweets);
	const likes = count(status.likes);
	const views = count(status.views);
	if (replies !== undefined) stats.replies = replies;
	if (reposts !== undefined) stats.reposts = reposts;
	if (likes !== undefined) stats.likes = likes;
	if (views !== undefined) stats.views = views;
	return Object.keys(stats).length > 0 ? stats : undefined;
};

const quoteOf = (status: ApiStatus): EmbedQuote | undefined => {
	const uri = httpUrl(status.url);
	if (!uri) return undefined;
	const { body, translatedFrom } = bodyOf(status);
	const media = mediaOf(status);
	const publishedAt = publishedAtOf(status);
	return {
		uri,
		author: authorOf(status),
		body,
		...(media.length > 0 ? { media } : {}),
		...(publishedAt ? { publishedAt } : {}),
		...(translatedFrom ? { translatedFrom } : {}),
	};
};

export function xStatusToEmbed(
	rawUrl: string,
	link: XStatusLink,
	json: unknown,
): LinkEmbed | undefined {
	const parsed = responseSchema.safeParse(json);
	if (!parsed.success) return undefined;
	const status = parsed.data.status;
	const author = authorOf(status);
	const { body, translatedFrom } = bodyOf(status);
	const media = mediaOf(status);
	const stats = statsOf(status);
	const quote = status.quote ? quoteOf(status.quote) : undefined;
	const publishedAt = publishedAtOf(status);

	return {
		uri: rawUrl,
		title: `${author.name} (@${author.handle})`,
		siteName: link.provider.name,
		themeColor: link.themeColor,
		provider: link.provider,
		author,
		...(publishedAt ? { publishedAt } : {}),
		...(media.length > 0 ? { media } : {}),
		post: {
			body,
			...(status.possibly_sensitive ? { sensitive: true } : {}),
			...(stats ? { stats } : {}),
			...(quote ? { quote } : {}),
			...(translatedFrom ? { translatedFrom } : {}),
		},
	};
}

export type XStatusOptions = {
	timeoutMs?: number;
	dispatcher?: Dispatcher;
	resolveHost?: HostResolver;
};

export function xStatusApiUrl(link: XStatusLink): string {
	const url = new URL(`/2/status/${link.id}`, API_ORIGIN);
	if (link.language) url.searchParams.set("lang", link.language);
	return url.href;
}

export async function fetchXStatusPreview(
	rawUrl: string,
	link: XStatusLink,
	options: XStatusOptions = {},
): Promise<LinkEmbed | undefined> {
	let result: GuardedFetchResult;
	try {
		result = await guardedFetch(xStatusApiUrl(link), {
			headers: { accept: "application/json" },
			timeoutMs: options.timeoutMs,
			maxResponseBytes: STATUS_MAX_BYTES,
			dispatcher: options.dispatcher,
			resolveHost: options.resolveHost,
		});
	} catch {
		return undefined;
	}
	if (result.statusCode < 200 || result.statusCode >= 300 || result.truncated) return undefined;
	let json: unknown;
	try {
		json = JSON.parse(result.body.toString("utf8"));
	} catch {
		return undefined;
	}
	return xStatusToEmbed(rawUrl, link, json);
}
