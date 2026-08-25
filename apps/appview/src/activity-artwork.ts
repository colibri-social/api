import { guardedFetch, type TtlCache } from "@colibri-social/embeds";

const COVER_ART_BASE = "https://coverartarchive.org/release";
const ITUNES_SEARCH = "https://itunes.apple.com/search";
const MBID_PREFIX = "mbid:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THUMBNAIL_SEGMENT = /\/\d+x\d+bb\.(?:jpg|png)$/;
const ARTWORK_SEGMENT = "/512x512bb.jpg";
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_SEARCH_BYTES = 512 * 1024;

export const ARTWORK_CACHE_MAX_ENTRIES = 2_000;
export const ARTWORK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type ArtworkEntry = { url: string | null };

export type ArtworkQuery = {
	track: string;
	artist?: string | undefined;
	release?: string | undefined;
	releaseMbId?: string | undefined;
};

export type ArtworkLog = {
	debug: (detail: Record<string, unknown>, event: string) => void;
};

export type ArtworkDeps = {
	cache: TtlCache<ArtworkEntry>;
	log: ArtworkLog;
	fetch?: typeof guardedFetch;
};

type ItunesResult = {
	artistName?: unknown;
	trackName?: unknown;
	collectionName?: unknown;
	artworkUrl100?: unknown;
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

export const releaseUuid = (raw: string | undefined): string | undefined => {
	if (!raw) return undefined;
	const value = raw.startsWith(MBID_PREFIX) ? raw.slice(MBID_PREFIX.length) : raw;
	return UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
};

export const artworkCacheKey = (query: ArtworkQuery): string => {
	const uuid = releaseUuid(query.releaseMbId);
	if (uuid) return `release:${uuid}`;
	return `search:${normalize(query.artist ?? "")}|${normalize(query.release ?? query.track)}`;
};

export const coverArtUrl = (uuid: string): string => `${COVER_ART_BASE}/${uuid}/front-500`;

const upsized = (artworkUrl: string): string =>
	THUMBNAIL_SEGMENT.test(artworkUrl)
		? artworkUrl.replace(THUMBNAIL_SEGMENT, ARTWORK_SEGMENT)
		: artworkUrl;

const fromCoverArtArchive = async (
	deps: ArtworkDeps,
	query: ArtworkQuery,
): Promise<string | undefined> => {
	const uuid = releaseUuid(query.releaseMbId);
	if (!uuid) return undefined;

	const url = coverArtUrl(uuid);
	const fetcher = deps.fetch ?? guardedFetch;
	try {
		const response = await fetcher(url, {
			method: "HEAD",
			timeoutMs: LOOKUP_TIMEOUT_MS,
			maxResponseBytes: 1,
		});
		if (response.statusCode === 200) return url;
		deps.log.debug({ release: uuid, status: response.statusCode }, "activity.artwork.noCoverArt");
	} catch (error) {
		deps.log.debug({ release: uuid, err: error }, "activity.artwork.coverArtFailed");
	}
	return undefined;
};

const itunesSearchUrl = (query: ArtworkQuery): string | undefined => {
	const artist = query.artist?.trim();
	if (!artist) return undefined;

	const album = query.release?.trim();
	const params = new URLSearchParams({
		term: `${artist} ${album ?? query.track}`,
		entity: album ? "album" : "musicTrack",
		media: "music",
		limit: "5",
	});
	return `${ITUNES_SEARCH}?${params}`;
};

const matches = (result: ItunesResult, query: ArtworkQuery): boolean => {
	const artistName = typeof result.artistName === "string" ? result.artistName : undefined;
	if (!alike(artistName, query.artist)) return false;

	const collectionName =
		typeof result.collectionName === "string" ? result.collectionName : undefined;
	const trackName = typeof result.trackName === "string" ? result.trackName : undefined;
	return alike(collectionName, query.release) || alike(trackName, query.track);
};

const fromItunes = async (deps: ArtworkDeps, query: ArtworkQuery): Promise<string | undefined> => {
	const url = itunesSearchUrl(query);
	if (!url) return undefined;

	const fetcher = deps.fetch ?? guardedFetch;
	try {
		const response = await fetcher(url, {
			headers: { accept: "application/json" },
			timeoutMs: LOOKUP_TIMEOUT_MS,
			maxResponseBytes: MAX_SEARCH_BYTES,
		});
		if (response.statusCode !== 200) {
			deps.log.debug({ status: response.statusCode }, "activity.artwork.searchRefused");
			return undefined;
		}

		const payload = JSON.parse(response.body.toString("utf8")) as { results?: ItunesResult[] };
		const hit = (payload.results ?? []).find((result) => matches(result, query));
		const artwork = typeof hit?.artworkUrl100 === "string" ? hit.artworkUrl100 : undefined;
		return artwork ? upsized(artwork) : undefined;
	} catch (error) {
		deps.log.debug({ err: error }, "activity.artwork.searchFailed");
		return undefined;
	}
};

export const resolveArtwork = async (
	deps: ArtworkDeps,
	query: ArtworkQuery,
): Promise<string | undefined> => {
	const key = artworkCacheKey(query);
	const cached = deps.cache.get(key);
	if (cached) return cached.url ?? undefined;

	const found = (await fromCoverArtArchive(deps, query)) ?? (await fromItunes(deps, query));
	deps.cache.set(key, { url: found ?? null });
	return found;
};
