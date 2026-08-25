import { describe, expect, it, vi } from "vitest";
import {
	createVideoArtworkClient,
	pickVideo,
	searchTerm,
	thumbnailCandidates,
	type VideoHit,
} from "./video-artwork.js";

const silentLog = { debug: () => undefined };

const QUERY = {
	track: "DELTARUNE - Blood Crushers (Album Mix)",
	artist: "Vortex",
} as const;

const HIT: VideoHit = {
	id: "z0i3sjeL60M",
	title: "DELTARUNE - Blood Crushers (Album Mix)",
	author: "Vortex",
};

const reachable = (...urls: string[]) =>
	vi.fn().mockImplementation((url: string) => Promise.resolve(urls.includes(url)));

describe("searchTerm", () => {
	it("leads with the artist so the uploader ranks first", () => {
		expect(searchTerm(QUERY)).toBe("Vortex DELTARUNE - Blood Crushers (Album Mix)");
	});

	it("searches the track alone when nothing scrobbled an artist", () => {
		expect(searchTerm({ track: "forgotten story" })).toBe("forgotten story");
	});
});

describe("thumbnailCandidates", () => {
	it("asks for the largest still first", () => {
		expect(thumbnailCandidates("abc")).toEqual([
			"https://i.ytimg.com/vi/abc/maxresdefault.jpg",
			"https://i.ytimg.com/vi/abc/hq720.jpg",
			"https://i.ytimg.com/vi/abc/hqdefault.jpg",
		]);
	});
});

describe("pickVideo", () => {
	it("prefers the upload whose channel is the scrobbled artist", () => {
		const reupload: VideoHit = { ...HIT, id: "other", author: "Music Archive" };

		expect(pickVideo([reupload, HIT], QUERY)).toBe(HIT);
	});

	it("takes a title match when no channel lines up", () => {
		const reupload: VideoHit = { ...HIT, author: "Music Archive" };

		expect(pickVideo([reupload], QUERY)).toBe(reupload);
	});

	it("refuses a result that is about something else", () => {
		expect(
			pickVideo([{ id: "x", title: "Undertale OST", author: "Vortex" }], QUERY),
		).toBeUndefined();
	});

	it("looks no further than the first five results", () => {
		const filler = Array.from({ length: 5 }, (_, index) => ({
			id: `filler${index}`,
			title: "something else",
		}));

		expect(pickVideo([...filler, HIT], QUERY)).toBeUndefined();
	});
});

describe("createVideoArtworkClient", () => {
	it("returns the largest reachable still for a match", async () => {
		const search = vi.fn().mockResolvedValue([HIT]);
		const exists = reachable("https://i.ytimg.com/vi/z0i3sjeL60M/maxresdefault.jpg");

		const client = createVideoArtworkClient({ log: silentLog, search, exists });

		expect(await client.thumbnail(QUERY)).toBe(
			"https://i.ytimg.com/vi/z0i3sjeL60M/maxresdefault.jpg",
		);
		expect(search).toHaveBeenCalledWith("Vortex DELTARUNE - Blood Crushers (Album Mix)");
	});

	it("steps down to a smaller still when the big one is missing", async () => {
		const search = vi.fn().mockResolvedValue([HIT]);
		const exists = reachable("https://i.ytimg.com/vi/z0i3sjeL60M/hq720.jpg");

		const client = createVideoArtworkClient({ log: silentLog, search, exists });

		expect(await client.thumbnail(QUERY)).toBe("https://i.ytimg.com/vi/z0i3sjeL60M/hq720.jpg");
	});

	it("gives up when the video has no still at all", async () => {
		const search = vi.fn().mockResolvedValue([HIT]);
		const exists = reachable();

		const client = createVideoArtworkClient({ log: silentLog, search, exists });

		expect(await client.thumbnail(QUERY)).toBeUndefined();
	});

	it("gives up when nothing matches the track", async () => {
		const search = vi.fn().mockResolvedValue([{ id: "x", title: "Undertale OST" }]);
		const exists = reachable();

		const client = createVideoArtworkClient({ log: silentLog, search, exists });

		expect(await client.thumbnail(QUERY)).toBeUndefined();
		expect(exists).not.toHaveBeenCalled();
	});

	it("searches nothing for a blank track", async () => {
		const search = vi.fn();
		const client = createVideoArtworkClient({ log: silentLog, search, exists: reachable() });

		expect(await client.thumbnail({ track: "  " })).toBeUndefined();
		expect(search).not.toHaveBeenCalled();
	});

	it("lets a failed search through, so the caller decides", async () => {
		const search = vi.fn().mockRejectedValue(new Error("youtube said no"));
		const client = createVideoArtworkClient({ log: silentLog, search, exists: reachable() });

		await expect(client.thumbnail(QUERY)).rejects.toThrow("youtube said no");
	});
});
