import { guardedFetch } from "@colibri-social/embeds";
import type { ArtworkLog, ArtworkQuery, VideoArtworkClient } from "./activity-artwork.js";

const THUMBNAIL_VARIANTS = ["maxresdefault", "hq720", "hqdefault"] as const;
const HEAD_TIMEOUT_MS = 5_000;
const MAX_CANDIDATES = 5;

export type VideoHit = {
	id: string;
	title: string;
	author?: string | undefined;
};

export type VideoSearch = (term: string) => Promise<VideoHit[]>;

export type VideoArtworkOptions = {
	log: ArtworkLog;
	search?: VideoSearch;
	exists?: (url: string) => Promise<boolean>;
};

type YoutubeClient = {
	search: (term: string, options: { type: "video" }) => Promise<unknown>;
};

type SearchResult = {
	id?: unknown;
	video_id?: unknown;
	title?: { text?: unknown } | string;
	author?: { name?: unknown } | null;
};

const normalize = (value: string): string =>
	value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

const alike = (left: string | undefined, right: string | undefined): boolean => {
	if (!left || !right) return false;
	const a = normalize(left);
	const b = normalize(right);
	if (a.length === 0 || b.length === 0) return false;
	return a === b || a.includes(b) || b.includes(a);
};

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const searchTerm = (query: ArtworkQuery): string =>
	[query.artist, query.track].filter((part) => part && part.length > 0).join(" ");

export const thumbnailCandidates = (id: string): string[] =>
	THUMBNAIL_VARIANTS.map((variant) => `https://i.ytimg.com/vi/${id}/${variant}.jpg`);

export const pickVideo = (hits: VideoHit[], query: ArtworkQuery): VideoHit | undefined => {
	const titled = hits.slice(0, MAX_CANDIDATES).filter((hit) => alike(hit.title, query.track));
	if (!query.artist) return titled[0];
	return titled.find((hit) => alike(hit.author, query.artist)) ?? titled[0];
};

const titleOf = (result: SearchResult): string | undefined => {
	const title = result.title;
	return typeof title === "string" ? text(title) : text(title?.text);
};

const toHit = (result: SearchResult): VideoHit | undefined => {
	const id = text(result.id) ?? text(result.video_id);
	const title = titleOf(result);
	if (!id || !title) return undefined;
	return { id, title, author: text(result.author?.name) };
};

const youtubeSearch = (): VideoSearch => {
	let pending: Promise<YoutubeClient> | undefined;

	const client = (): Promise<YoutubeClient> => {
		pending ??= import("youtubei.js").then(({ Innertube }) =>
			Innertube.create({ retrieve_player: false }),
		);
		return pending;
	};

	return async (term) => {
		try {
			const search = (await (await client()).search(term, { type: "video" })) as {
				results?: SearchResult[];
			};
			return (search.results ?? [])
				.slice(0, MAX_CANDIDATES)
				.map(toHit)
				.filter((hit): hit is VideoHit => hit !== undefined);
		} catch (error) {
			pending = undefined;
			throw error;
		}
	};
};

const reachable = async (url: string): Promise<boolean> => {
	try {
		const response = await guardedFetch(url, {
			method: "HEAD",
			timeoutMs: HEAD_TIMEOUT_MS,
			maxResponseBytes: 1,
		});
		return response.statusCode === 200;
	} catch {
		return false;
	}
};

export const createVideoArtworkClient = (options: VideoArtworkOptions): VideoArtworkClient => {
	const search = options.search ?? youtubeSearch();
	const exists = options.exists ?? reachable;

	return {
		thumbnail: async (query) => {
			if (query.track.trim().length === 0) return undefined;

			const term = searchTerm(query);
			const hit = pickVideo(await search(term), query);
			if (!hit) {
				options.log.debug({ term }, "activity.artwork.videoNoMatch");
				return undefined;
			}

			for (const candidate of thumbnailCandidates(hit.id)) {
				if (await exists(candidate)) return candidate;
			}

			options.log.debug({ term, video: hit.id }, "activity.artwork.videoNoThumbnail");
			return undefined;
		},
	};
};
