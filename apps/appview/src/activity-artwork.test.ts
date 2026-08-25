import { createTtlCache, type TtlCache } from "@colibri-social/embeds";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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

		const found = await resolveArtwork(
			{ cache, log: silentLog, fetch },
			{ ...QUERY, releaseMbId: `mbid:${RELEASE}` },
		);

		expect(found).toBe(coverArtUrl(RELEASE));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "HEAD" });
	});

	it("searches for the album when the release has no art", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(response(404))
			.mockResolvedValueOnce(
				itunes([
					{
						artistName: "Jaira Burns",
						collectionName: "Hard to Love",
						artworkUrl100: "https://is1.test/image/thumb/abc/100x100bb.jpg",
					},
				]),
			);

		const found = await resolveArtwork(
			{ cache, log: silentLog, fetch },
			{ ...QUERY, releaseMbId: `mbid:${RELEASE}` },
		);

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

		expect(await resolveArtwork({ cache, log: silentLog, fetch }, QUERY)).toBeUndefined();
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

		expect(await resolveArtwork({ cache, log: silentLog, fetch }, QUERY)).toBe(
			"https://is1.test/image/thumb/abc/512x512bb.jpg",
		);
	});

	it("looks nothing up when there is no artist to search on", async () => {
		const fetch = vi.fn();

		expect(
			await resolveArtwork({ cache, log: silentLog, fetch }, { track: "Sick Like You" }),
		).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("remembers that a track has no art, so a repeat play looks nothing up", async () => {
		const fetch = vi.fn().mockResolvedValue(itunes([]));

		await resolveArtwork({ cache, log: silentLog, fetch }, QUERY);
		await resolveArtwork({ cache, log: silentLog, fetch }, QUERY);

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("serves a second play of the same album from the cache", async () => {
		const fetch = vi.fn().mockResolvedValue(response(200));
		const query = { ...QUERY, releaseMbId: `mbid:${RELEASE}` };

		await resolveArtwork({ cache, log: silentLog, fetch }, query);
		const again = await resolveArtwork({ cache, log: silentLog, fetch }, query);

		expect(again).toBe(coverArtUrl(RELEASE));
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("gives up quietly when the lookup throws", async () => {
		const fetch = vi.fn().mockRejectedValue(new Error("dns lookup failed"));

		expect(
			await resolveArtwork(
				{ cache, log: silentLog, fetch },
				{ ...QUERY, releaseMbId: `mbid:${RELEASE}` },
			),
		).toBeUndefined();
	});
});
