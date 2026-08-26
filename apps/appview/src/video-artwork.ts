import { guardedFetch } from "@colibri-social/embeds";
import type { ArtworkLog, ArtworkQuery, VideoArtworkClient } from "./activity-artwork.js";

const THUMBNAIL_VARIANTS = ["maxresdefault", "hq720", "hqdefault"] as const;
const HEAD_TIMEOUT_MS = 5_000;
const MAX_CANDIDATES = 5;
const DASH = /\s+[-–—]\s+/;
const CHANNEL_SUFFIX = /\s*(?:vevo|topic|official(?:\s+channel)?|music)$/;
const BRACKETED = /[([]([^)\]]*)[)\]]/g;
const DIGITS = /^\d+$/;
const DECORATION_WORDS = new Set([
	"official",
	"video",
	"audio",
	"music",
	"lyric",
	"lyrics",
	"visualizer",
	"visualiser",
	"mv",
	"hd",
	"hq",
	"uhd",
	"4k",
	"8k",
	"remaster",
	"remastered",
	"explicit",
	"clean",
	"full",
]);

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

const words = (value: string): string[] => normalize(value).split(" ").filter(Boolean);

const decorative = (group: string): boolean => {
	const parts = words(group);
	if (parts.length === 0) return false;
	if (!parts.some((part) => DECORATION_WORDS.has(part))) return false;
	return parts.every((part) => DECORATION_WORDS.has(part) || DIGITS.test(part));
};

const undecorated = (value: string): string =>
	value.replace(BRACKETED, (group, inner: string) => (decorative(inner) ? " " : group));

const trimDecorated = (value: string): string => {
	const parts = value.split(" ");
	while (parts.length > 1 && DECORATION_WORDS.has(parts[parts.length - 1] as string)) parts.pop();
	return parts.join(" ");
};

const canon = (value: string): string => trimDecorated(normalize(undecorated(value)));

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const artistVariants = (artist: string | undefined): string[] => {
	if (!artist) return [];
	const parts = [artist, ...artist.split(",")].map(canon).filter((part) => part.length > 0);
	return [...new Set(parts)];
};

const splitDash = (title: string, from: "first" | "last"): [string, string] | undefined => {
	const parts = title.split(DASH);
	if (parts.length < 2) return undefined;
	if (from === "first") return [parts[0] as string, parts.slice(1).join(" - ")];
	return [parts.slice(0, -1).join(" - "), parts[parts.length - 1] as string];
};

export const titleMatches = (title: string, track: string, artists: string[]): boolean => {
	const wanted = canon(track);
	if (wanted.length === 0) return false;
	if (canon(title) === wanted) return true;
	if (artists.length === 0) return false;

	const leading = splitDash(title, "first");
	if (leading && artists.includes(canon(leading[0])) && canon(leading[1]) === wanted) return true;

	const trailing = splitDash(title, "last");
	return (
		trailing !== undefined && artists.includes(canon(trailing[1])) && canon(trailing[0]) === wanted
	);
};

export const channelMatches = (author: string | undefined, artists: string[]): boolean => {
	if (!author) return false;
	let name = canon(author);
	for (let pass = 0; pass < 2; pass += 1) {
		if (artists.includes(name)) return true;
		const stripped = name.replace(CHANNEL_SUFFIX, "").trim();
		if (stripped === name) return false;
		name = stripped;
	}
	return artists.includes(name);
};

export const searchTerm = (query: ArtworkQuery): string =>
	[query.artist, query.track].filter((part) => part && part.length > 0).join(" ");

export const thumbnailCandidates = (id: string): string[] =>
	THUMBNAIL_VARIANTS.map((variant) => `https://i.ytimg.com/vi/${id}/${variant}.jpg`);

export const pickVideo = (hits: VideoHit[], query: ArtworkQuery): VideoHit | undefined => {
	const artists = artistVariants(query.artist);
	return hits
		.slice(0, MAX_CANDIDATES)
		.find(
			(hit) =>
				titleMatches(hit.title, query.track, artists) &&
				(artists.length === 0 || channelMatches(hit.author, artists)),
		);
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
