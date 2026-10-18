import type { Dispatcher } from "undici";
import { z } from "zod";
import { type GuardedFetchResult, guardedFetch, type HostResolver } from "./fetch.js";
import type { LinkTag } from "./html.js";
import { htmlToRichBlocks } from "./richtext.js";
import type { EmbedAuthor, EmbedMedia, EmbedPost, EmbedStats } from "./types.js";
import { videoTypeFromExtension } from "./video.js";

const STATUS_MAX_BYTES = 256 * 1024;
const ACTIVITY_TYPE = "application/activity+json";
const STATUS_PATH = /\/(?:statuses|notes|objects)\/([A-Za-z0-9_-]+)\/?$/;
export const MAX_POST_MEDIA = 4;

const nullableString = z.string().nullish();

const dimensionsSchema = z
	.object({ width: z.number().nullish(), height: z.number().nullish() })
	.passthrough()
	.nullish();

const attachmentSchema = z
	.object({
		type: z.string(),
		url: nullableString,
		preview_url: nullableString,
		remote_url: nullableString,
		description: nullableString,
		meta: z.object({ original: dimensionsSchema, small: dimensionsSchema }).passthrough().nullish(),
	})
	.passthrough();

const accountSchema = z
	.object({
		username: z.string(),
		acct: nullableString,
		display_name: nullableString,
		url: nullableString,
		avatar: nullableString,
		avatar_static: nullableString,
	})
	.passthrough();

const baseStatusSchema = z
	.object({
		created_at: nullableString,
		content: z.string(),
		sensitive: z.boolean().nullish(),
		spoiler_text: nullableString,
		account: accountSchema,
		media_attachments: z.array(attachmentSchema).nullish(),
		replies_count: z.number().nullish(),
		reblogs_count: z.number().nullish(),
		favourites_count: z.number().nullish(),
	})
	.passthrough();

const statusSchema = baseStatusSchema.extend({ reblog: baseStatusSchema.nullish() });

export type ActivityPost = {
	author: EmbedAuthor;
	publishedAt?: string;
	post: EmbedPost;
	media: EmbedMedia[];
};

export type ActivityFetchOptions = {
	timeoutMs?: number;
	dispatcher?: Dispatcher;
	resolveHost?: HostResolver;
};

const httpUrl = (raw: string | null | undefined, base?: URL): string | undefined => {
	if (!raw) return undefined;
	try {
		const url = new URL(raw.trim(), base);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
};

const count = (value: number | null | undefined): number | undefined =>
	value !== null && value !== undefined && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined;

const positive = (value: number | null | undefined): number | undefined =>
	value !== null && value !== undefined && Number.isFinite(value) && value > 0
		? Math.round(value)
		: undefined;

export function findStatusApiUrl(links: readonly LinkTag[], base: URL): string | undefined {
	for (const link of links) {
		if (!link.rel.includes("alternate") || link.type !== ACTIVITY_TYPE) continue;
		const href = httpUrl(link.href, base);
		if (!href) continue;
		const url = new URL(href);
		const id = STATUS_PATH.exec(url.pathname)?.[1];
		if (id) return new URL(`/api/v1/statuses/${id}`, url.origin).href;
	}
	return undefined;
}

const toMedia = (attachment: z.infer<typeof attachmentSchema>): EmbedMedia | undefined => {
	const kind = attachment.type;
	if (kind !== "image" && kind !== "video" && kind !== "gifv") return undefined;
	const url = httpUrl(attachment.url) ?? httpUrl(attachment.remote_url);
	if (!url) return undefined;
	const original = attachment.meta?.original;
	const width = positive(original?.width);
	const height = positive(original?.height);
	const alt = attachment.description?.trim();
	const sized = {
		...(width !== undefined ? { width } : {}),
		...(height !== undefined ? { height } : {}),
		...(alt ? { alt } : {}),
	};
	if (kind === "image") return { kind, url, ...sized };
	const previewUrl = httpUrl(attachment.preview_url);
	return {
		kind,
		url,
		mimeType: videoTypeFromExtension(new URL(url)) ?? "video/mp4",
		...(previewUrl ? { previewUrl } : {}),
		...sized,
	};
};

const isoDate = (raw: string | null | undefined): string | undefined => {
	if (!raw) return undefined;
	const time = Date.parse(raw);
	return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};

const statsOf = (status: z.infer<typeof baseStatusSchema>): EmbedStats | undefined => {
	const replies = count(status.replies_count);
	const reposts = count(status.reblogs_count);
	const likes = count(status.favourites_count);
	if (replies === undefined && reposts === undefined && likes === undefined) return undefined;
	return {
		...(replies !== undefined ? { replies } : {}),
		...(reposts !== undefined ? { reposts } : {}),
		...(likes !== undefined ? { likes } : {}),
	};
};

export function statusToPost(json: unknown): ActivityPost | undefined {
	const parsed = statusSchema.safeParse(json);
	if (!parsed.success) return undefined;
	const status = parsed.data.reblog ?? parsed.data;
	const account = status.account;

	const avatar = httpUrl(account.avatar_static) ?? httpUrl(account.avatar);
	const profile = httpUrl(account.url);
	const acct = (account.acct ?? account.username).replace(/^@/, "");
	const handle = acct.includes("@") || !profile ? acct : `${acct}@${new URL(profile).hostname}`;
	const author: EmbedAuthor = {
		name: account.display_name?.trim() || account.username,
		...(handle ? { handle } : {}),
		...(profile ? { url: profile } : {}),
		...(avatar ? { avatar } : {}),
	};

	const contentWarning = status.spoiler_text?.trim();
	const stats = statsOf(status);
	const post: EmbedPost = {
		body: htmlToRichBlocks(status.content),
		...(stats ? { stats } : {}),
		...(status.sensitive ? { sensitive: true } : {}),
		...(contentWarning ? { contentWarning } : {}),
	};

	const media = (status.media_attachments ?? [])
		.map(toMedia)
		.filter((item): item is EmbedMedia => item !== undefined)
		.slice(0, MAX_POST_MEDIA);

	const publishedAt = isoDate(status.created_at);
	return { author, post, media, ...(publishedAt ? { publishedAt } : {}) };
}

const parseJson = (result: GuardedFetchResult): unknown => {
	if (result.statusCode < 200 || result.statusCode >= 300 || result.truncated) return undefined;
	try {
		return JSON.parse(result.body.toString("utf8"));
	} catch {
		return undefined;
	}
};

export async function fetchActivityPost(
	url: string,
	options: ActivityFetchOptions = {},
): Promise<ActivityPost | undefined> {
	let result: GuardedFetchResult;
	try {
		result = await guardedFetch(url, {
			headers: { accept: "application/json" },
			timeoutMs: options.timeoutMs,
			maxResponseBytes: STATUS_MAX_BYTES,
			dispatcher: options.dispatcher,
			resolveHost: options.resolveHost,
		});
	} catch {
		return undefined;
	}
	return statusToPost(parseJson(result));
}
