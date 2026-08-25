import { createTtlCache, type TtlCache } from "@colibri-social/embeds";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ArtworkDeps,
	type ArtworkEntry,
	artworkCacheKey,
	coverArtUrl,
	releaseUuid,
	resolveArtwork,
} from "./activity-artwork.js";

const RELEASE = "79215cdf-4764-4dee-b0b9-fec1643df7c5";

const QUERY = {
	track: "Sick Like You",
	artist: "Jaira Burns",
	release: "Hard To Love",
} as const;

const silentLog = { debug: () => undefined };

let cache: TtlCache<ArtworkEntry>;

beforeEach(() => {
	cache = createTtlCache<ArtworkEntry>();
});

const response = (statusCode: number, body: unknown = {}) => ({
	statusCode,
	headers: {},
	url: new URL("https://example.test"),
	body: Buffer.from(JSON.stringify(body)),
	truncated: false,
});

const itunes = (results: unknown[]) => response(200, { results });

const deezer = (data: unknown[]) => response(200, { data });

const musicbrainz = (payload: Record<string, unknown>) => response(200, payload);

const deps = (fetch: unknown) => ({
	cache,
	log: silentLog,
	fetch: fetch as ArtworkDeps["fetch"],
	musicbrainzGapMs: 0,
});

describe("releaseUuid", () => {
	it("strips the mbid prefix teal.fm writes", () => {
		expect(releaseUuid(`mbid:${RELEASE}`)).toBe(RELEASE);
	});

	it("takes a bare uuid", () => {
		expect(releaseUuid(RELEASE)).toBe(RELEASE);
	});

	it("refuses anything that is not a uuid", () => {
		expect(releaseUuid("mbid:not-an-id")).toBeUndefined();
		expect(releaseUuid(undefined)).toBeUndefined();
	});
});

describe("artworkCacheKey", () => {
	it("keys on the release when teal.fm names one", () => {
		expect(artworkCacheKey({ ...QUERY, releaseMbId: `mbid:${RELEASE}` })).toBe(
			`release:${RELEASE}`,
		);
	});

	it("keys two spellings of the same album together", () => {
		expect(artworkCacheKey({ track: "a", artist: "Jaira Burns", release: "Hard To Love" })).toBe(
			artworkCacheKey({ track: "b", artist: "jaira  burns!", release: "hard to love" }),
		);
	});
});

describe("resolveArtwork", () => {
	it("uses the cover art archive when the release has art", async () => {
		const fetch = vi.fn().mockResolvedValue(response(200));

		const found = await resolveArtwork(deps(fetch), { ...QUERY, releaseMbId: `mbid:${RELEASE}` });

		expect(found).toBe(coverArtUrl(RELEASE));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "HEAD" });
	});

	it("searches for the album when the release has no art", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(response(404))
			.mockResolvedValue(
				itunes([
					{
						artistName: "Jaira Burns",
						collectionName: "Hard to Love",
						artworkUrl100: "https://is1.test/image/thumb/abc/100x100bb.jpg",
					},
				]),
			);

		const found = await resolveArtwork(deps(fetch), { ...QUERY, releaseMbId: `mbid:${RELEASE}` });

		expect(found).toBe("https://is1.test/image/thumb/abc/512x512bb.jpg");
	});

	it("refuses a search hit for a different artist", async () => {
		const fetch = vi.fn().mockResolvedValue(
			itunes([
				{
					artistName: "Someone Else",
					collectionName: "Hard To Love",
					artworkUrl100: "https://is1.test/image/thumb/abc/100x100bb.jpg",
				},
			]),
		);

		expect(await resolveArtwork(deps(fetch), QUERY)).toBeUndefined();
	});

	it("takes a track match when the album name does not line up", async () => {
		const fetch = vi.fn().mockResolvedValue(
			itunes([
				{
					artistName: "Jaira Burns",
					collectionName: "Some Compilation",
					trackName: "Sick Like You",
					artworkUrl100: "https://is1.test/image/thumb/abc/100x100bb.jpg",
				},
			]),
		);

		expect(await resolveArtwork(deps(fetch), QUERY)).toBe(
			"https://is1.test/image/thumb/abc/512x512bb.jpg",
		);
	});

	it("looks nothing up when there is no artist to search on", async () => {
		const fetch = vi.fn();

		expect(await resolveArtwork(deps(fetch), { track: "Sick Like You" })).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("remembers that a track has no art, so a repeat play looks nothing up", async () => {
		const fetch = vi.fn().mockResolvedValue(itunes([]));

		await resolveArtwork(deps(fetch), QUERY);
		const afterFirst = fetch.mock.calls.length;
		await resolveArtwork(deps(fetch), QUERY);

		expect(afterFirst).toBeGreaterThan(0);
		expect(fetch).toHaveBeenCalledTimes(afterFirst);
	});

	it("prefers a deezer cover over the itunes thumbnail", async () => {
		const fetch = vi.fn().mockImplementation((url: string) =>
			Promise.resolve(
				url.startsWith("https://api.deezer.com")
					? deezer([
							{
								title: "Sick Like You",
								artist: { name: "Jaira Burns" },
								album: {
									title: "Hard To Love",
									cover_xl: "https://cdn.deezer.test/cover/abc/1000x1000.jpg",
								},
							},
						])
					: itunes([
							{
								artistName: "Jaira Burns",
								collectionName: "Hard To Love",
								artworkUrl100: "https://is1.test/image/thumb/abc/100x100bb.jpg",
							},
						]),
			),
		);

		expect(await resolveArtwork(deps(fetch), QUERY)).toBe(
			"https://cdn.deezer.test/cover/abc/1000x1000.jpg",
		);
	});

	it("refuses a deezer hit for a different artist", async () => {
		const fetch = vi.fn().mockImplementation((url: string) =>
			Promise.resolve(
				url.startsWith("https://api.deezer.com")
					? deezer([
							{
								title: "Sick Like You",
								artist: { name: "Someone Else" },
								album: { title: "Hard To Love", cover_xl: "https://cdn.deezer.test/x.jpg" },
							},
						])
					: itunes([]),
			),
		);

		expect(await resolveArtwork(deps(fetch), QUERY)).toBeUndefined();
	});

	it("finds the release on musicbrainz when teal.fm names no mbid", async () => {
		const fetch = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
			if (url.startsWith("https://musicbrainz.org")) {
				return Promise.resolve(
					musicbrainz({
						releases: [
							{
								id: RELEASE,
								score: 100,
								title: "Hard To Love",
								"artist-credit": [{ name: "Jaira Burns" }],
							},
						],
					}),
				);
			}
			if (init?.method === "HEAD") return Promise.resolve(response(200));
			return Promise.resolve(itunes([]));
		});

		expect(await resolveArtwork(deps(fetch), QUERY)).toBe(coverArtUrl(RELEASE));
	});

	it("falls back to a recording search when the album is unknown", async () => {
		const fetch = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
			if (url.startsWith("https://musicbrainz.org")) {
				return Promise.resolve(
					musicbrainz({
						recordings: [
							{
								score: 95,
								title: "Sick Like You",
								"artist-credit": [{ name: "Jaira Burns" }],
								releases: [{ id: RELEASE }],
							},
						],
					}),
				);
			}
			if (init?.method === "HEAD") return Promise.resolve(response(200));
			return Promise.resolve(itunes([]));
		});

		const found = await resolveArtwork(deps(fetch), {
			track: "Sick Like You",
			artist: "Jaira Burns",
		});

		expect(found).toBe(coverArtUrl(RELEASE));
	});

	it("ignores a low-scoring musicbrainz guess", async () => {
		const fetch = vi.fn().mockImplementation((url: string) =>
			Promise.resolve(
				url.startsWith("https://musicbrainz.org")
					? musicbrainz({
							releases: [
								{
									id: RELEASE,
									score: 40,
									title: "Hard To Love",
									"artist-credit": [{ name: "Jaira Burns" }],
								},
							],
						})
					: itunes([]),
			),
		);

		expect(await resolveArtwork(deps(fetch), QUERY)).toBeUndefined();
	});

	it("asks the video resolver only once every other provider has missed", async () => {
		const fetch = vi.fn().mockResolvedValue(itunes([]));
		const thumbnail = vi.fn().mockResolvedValue("https://i.ytimg.test/vi/abc/hq.jpg");

		const found = await resolveArtwork({ ...deps(fetch), video: { thumbnail } }, QUERY);

		expect(found).toBe("https://i.ytimg.test/vi/abc/hq.jpg");
		expect(thumbnail).toHaveBeenCalledWith(QUERY);
	});

	it("leaves the video resolver alone when a cover was found", async () => {
		const fetch = vi.fn().mockResolvedValue(
			itunes([
				{
					artistName: "Jaira Burns",
					collectionName: "Hard To Love",
					artworkUrl100: "https://is1.test/image/thumb/abc/100x100bb.jpg",
				},
			]),
		);
		const thumbnail = vi.fn();

		await resolveArtwork({ ...deps(fetch), video: { thumbnail } }, QUERY);

		expect(thumbnail).not.toHaveBeenCalled();
	});

	it("survives a video resolver that throws", async () => {
		const fetch = vi.fn().mockResolvedValue(itunes([]));
		const thumbnail = vi.fn().mockRejectedValue(new Error("resolver down"));

		expect(await resolveArtwork({ ...deps(fetch), video: { thumbnail } }, QUERY)).toBeUndefined();
	});

	it("serves a second play of the same album from the cache", async () => {
		const fetch = vi.fn().mockResolvedValue(response(200));
		const query = { ...QUERY, releaseMbId: `mbid:${RELEASE}` };

		await resolveArtwork(deps(fetch), query);
		const again = await resolveArtwork(deps(fetch), query);

		expect(again).toBe(coverArtUrl(RELEASE));
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("gives up quietly when the lookup throws", async () => {
		const fetch = vi.fn().mockRejectedValue(new Error("dns lookup failed"));

		expect(
			await resolveArtwork(deps(fetch), { ...QUERY, releaseMbId: `mbid:${RELEASE}` }),
		).toBeUndefined();
	});
});
