import { guardedFetch, type TtlCache } from "@colibri-social/embeds";

const COVER_ART_BASE = "https://coverartarchive.org/release";
const ITUNES_SEARCH = "https://itunes.apple.com/search";
const DEEZER_SEARCH = "https://api.deezer.com/search";
const MUSICBRAINZ_BASE = "https://musicbrainz.org/ws/2";
const MBID_PREFIX = "mbid:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THUMBNAIL_SEGMENT = /\/\d+x\d+bb\.(?:jpg|png)$/;
const ARTWORK_SEGMENT = "/512x512bb.jpg";
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_SEARCH_BYTES = 512 * 1024;
const MIN_MUSICBRAINZ_SCORE = 90;
const MUSICBRAINZ_GAP_MS = 1_100;
const MUSICBRAINZ_MAX_QUEUE = 3;
const DEFAULT_USER_AGENT = "colibri-appview/1.0 ( https://colibri.social )";

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

export type VideoArtworkClient = {
	thumbnail: (query: ArtworkQuery) => Promise<string | undefined>;
};

export type ArtworkDeps = {
	cache: TtlCache<ArtworkEntry>;
	log: ArtworkLog;
	fetch?: typeof guardedFetch;
	video?: VideoArtworkClient | null;
	userAgent?: string;
	musicbrainzGapMs?: number;
};

type ItunesResult = {
	artistName?: unknown;
	trackName?: unknown;
	collectionName?: unknown;
	artworkUrl100?: unknown;
};

type DeezerResult = {
	title?: unknown;
	artist?: { name?: unknown } | null;
	album?: { title?: unknown; cover_xl?: unknown; cover_big?: unknown } | null;
};

type MusicbrainzCredit = { name?: unknown };

type MusicbrainzRelease = {
	id?: unknown;
	score?: unknown;
	title?: unknown;
	"artist-credit"?: unknown;
};

type MusicbrainzRecording = {
	score?: unknown;
	title?: unknown;
	releases?: unknown;
	"artist-credit"?: unknown;
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

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

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

const readJson = async (
	deps: ArtworkDeps,
	url: string,
	event: string,
	headers: Record<string, string> = {},
): Promise<unknown> => {
	const fetcher = deps.fetch ?? guardedFetch;
	try {
		const response = await fetcher(url, {
			headers: { accept: "application/json", ...headers },
			timeoutMs: LOOKUP_TIMEOUT_MS,
			maxResponseBytes: MAX_SEARCH_BYTES,
		});
		if (response.statusCode !== 200) {
			deps.log.debug({ status: response.statusCode }, `${event}Refused`);
			return undefined;
		}
		return JSON.parse(response.body.toString("utf8")) as unknown;
	} catch (error) {
		deps.log.debug({ err: error }, `${event}Failed`);
		return undefined;
	}
};

const artworkExists = async (deps: ArtworkDeps, url: string): Promise<boolean> => {
	const fetcher = deps.fetch ?? guardedFetch;
	try {
		const response = await fetcher(url, {
			method: "HEAD",
			timeoutMs: LOOKUP_TIMEOUT_MS,
			maxResponseBytes: 1,
		});
		if (response.statusCode === 200) return true;
		deps.log.debug({ status: response.statusCode }, "activity.artwork.noCoverArt");
	} catch (error) {
		deps.log.debug({ err: error }, "activity.artwork.coverArtFailed");
	}
	return false;
};

const fromCoverArtArchive = async (
	deps: ArtworkDeps,
	uuid: string | undefined,
): Promise<string | undefined> => {
	if (!uuid) return undefined;
	const url = coverArtUrl(uuid);
	return (await artworkExists(deps, url)) ? url : undefined;
};

const lucene = (value: string): string => value.replace(/(["\\])/g, "\\$1");

const creditName = (credit: unknown): string | undefined => {
	if (!Array.isArray(credit)) return undefined;
	return str((credit[0] as MusicbrainzCredit | undefined)?.name);
};

const scored = (value: unknown): number =>
	typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10) || 0;

let musicbrainzSlot = 0;

const claimMusicbrainzSlot = async (gapMs: number): Promise<boolean> => {
	if (gapMs <= 0) return true;

	const now = Date.now();
	const at = Math.max(now, musicbrainzSlot);
	if (at - now > gapMs * MUSICBRAINZ_MAX_QUEUE) return false;

	musicbrainzSlot = at + gapMs;
	if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
	return true;
};

const musicbrainzSearch = async (
	deps: ArtworkDeps,
	path: string,
	query: string,
): Promise<unknown> => {
	if (!(await claimMusicbrainzSlot(deps.musicbrainzGapMs ?? MUSICBRAINZ_GAP_MS))) {
		deps.log.debug({}, "activity.artwork.musicbrainzBusy");
		return undefined;
	}

	const params = new URLSearchParams({ query, fmt: "json", limit: "3" });
	return readJson(deps, `${MUSICBRAINZ_BASE}/${path}/?${params}`, "activity.artwork.musicbrainz", {
		"user-agent": deps.userAgent ?? DEFAULT_USER_AGENT,
	});
};

const releaseFromMusicbrainz = async (
	deps: ArtworkDeps,
	query: ArtworkQuery,
): Promise<string | undefined> => {
	const artist = query.artist?.trim();
	if (!artist) return undefined;

	if (query.release) {
		const payload = (await musicbrainzSearch(
			deps,
			"release",
			`release:"${lucene(query.release)}" AND artist:"${lucene(artist)}"`,
		)) as { releases?: MusicbrainzRelease[] } | undefined;

		const hit = (payload?.releases ?? []).find(
			(release) =>
				scored(release.score) >= MIN_MUSICBRAINZ_SCORE &&
				alike(creditName(release["artist-credit"]), artist) &&
				alike(str(release.title), query.release),
		);
		const uuid = releaseUuid(str(hit?.id));
		if (uuid) return uuid;
	}

	const payload = (await musicbrainzSearch(
		deps,
		"recording",
		`recording:"${lucene(query.track)}" AND artist:"${lucene(artist)}"`,
	)) as { recordings?: MusicbrainzRecording[] } | undefined;

	const hit = (payload?.recordings ?? []).find(
		(recording) =>
			scored(recording.score) >= MIN_MUSICBRAINZ_SCORE &&
			alike(creditName(recording["artist-credit"]), artist) &&
			alike(str(recording.title), query.track) &&
			Array.isArray(recording.releases),
	);
	const releases = (hit?.releases ?? []) as MusicbrainzRelease[];
	return releaseUuid(str(releases[0]?.id));
};

const searchTerm = (query: ArtworkQuery, artist: string): string =>
	`${artist} ${query.release ?? query.track}`;

const itunesMatches = (result: ItunesResult, query: ArtworkQuery): boolean => {
	if (!alike(str(result.artistName), query.artist)) return false;
	return (
		alike(str(result.collectionName), query.release) || alike(str(result.trackName), query.track)
	);
};

const fromItunes = async (deps: ArtworkDeps, query: ArtworkQuery): Promise<string | undefined> => {
	const artist = query.artist?.trim();
	if (!artist) return undefined;

	const params = new URLSearchParams({
		term: searchTerm(query, artist),
		entity: query.release ? "album" : "musicTrack",
		media: "music",
		limit: "5",
	});
	const payload = (await readJson(deps, `${ITUNES_SEARCH}?${params}`, "activity.artwork.itunes")) as
		| { results?: ItunesResult[] }
		| undefined;

	const hit = (payload?.results ?? []).find((result) => itunesMatches(result, query));
	const artwork = str(hit?.artworkUrl100);
	return artwork ? upsized(artwork) : undefined;
};

const deezerMatches = (result: DeezerResult, query: ArtworkQuery): boolean => {
	if (!alike(str(result.artist?.name), query.artist)) return false;
	return alike(str(result.album?.title), query.release) || alike(str(result.title), query.track);
};

const fromDeezer = async (deps: ArtworkDeps, query: ArtworkQuery): Promise<string | undefined> => {
	const artist = query.artist?.trim();
	if (!artist) return undefined;

	const params = new URLSearchParams({ q: searchTerm(query, artist), limit: "5" });
	const payload = (await readJson(deps, `${DEEZER_SEARCH}?${params}`, "activity.artwork.deezer")) as
		| { data?: DeezerResult[] }
		| undefined;

	const hit = (payload?.data ?? []).find((result) => deezerMatches(result, query));
	return str(hit?.album?.cover_xl) ?? str(hit?.album?.cover_big);
};

const fromVideo = async (deps: ArtworkDeps, query: ArtworkQuery): Promise<string | undefined> => {
	if (!deps.video) return undefined;
	try {
		return await deps.video.thumbnail(query);
	} catch (error) {
		deps.log.debug({ err: error }, "activity.artwork.videoFailed");
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

	const known = releaseUuid(query.releaseMbId);
	const found =
		(await fromCoverArtArchive(deps, known)) ??
		(known
			? undefined
			: await fromCoverArtArchive(deps, await releaseFromMusicbrainz(deps, query))) ??
		(await fromDeezer(deps, query)) ??
		(await fromItunes(deps, query)) ??
		(await fromVideo(deps, query));

	deps.cache.set(key, { url: found ?? null });
	return found;
};
