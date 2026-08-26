import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { createTtlCache, type TtlCache } from "@colibri-social/embeds";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyActivityRecord,
	backfillActivity,
	clearActivity,
	setActivitySharing,
	sweepLapsedActivities,
} from "./activity.js";
import { type ArtworkEntry, artworkCacheKey } from "./activity-artwork.js";
import {
	ATRADIO_STATUS_COLLECTION,
	ROCKSKY_STATUS_COLLECTION,
	readAtradioStatus,
	readRockskyStatus,
	readTealStatus,
	TEAL_ALPHA_STATUS_COLLECTION,
	TEAL_STATUS_COLLECTION,
} from "./activity-providers.js";
import type { AppContext } from "./context.js";
import { loadActivity } from "./views/activity.js";
import type { ServerFrame } from "./ws/events.js";

const published = new Map<string, unknown>();

vi.mock("@colibri-social/space", async (importOriginal) => ({
	...(await importOriginal<object>()),
	PdsClient: class {
		async getPublicRecord(_did: string, collection: string) {
			const value = published.get(collection);
			if (!value) throw new Error(`no ${collection} record`);
			return { value };
		}
	},
}));

const ACTOR = "did:plc:listeneraaaaaaaaaaaaaaaaaa";
const COMMUNITY = "did:plc:communityaaaaaaaaaaaaaaaaaa";
const NOW = Date.parse("2026-08-25T13:20:00.000Z");

const PLAY = {
	trackName: "Sick Like You",
	artists: [{ artistName: "Jaira Burns", artistMbId: "mbid:a6bf06a6-756f-4639-b8c0-0960a8d6cc0a" }],
	releaseName: "Hard To Love",
	releaseMbId: "mbid:fcdb5202-27a2-4500-90c6-5264a2cd2756",
	originUri: "https://www.last.fm/music/Jaira+Burns/_/Sick+Like+You",
	playedTime: "2026-08-25T13:18:51Z",
	duration: 140,
} as const;

const TRACK = {
	name: "The Diary of Jane (Single Version)",
	artist: "Breaking Benjamin",
	album: "Phobia (Explicit Version)",
	albumCoverUrl: "https://i.scdn.co/image/ab67616d0000b273742e415e7f4bc3ee0c8ad600",
	durationMs: 200597,
	source: "Rocksky (Desktop)",
	trackNumber: 2,
} as const;

const STATION = {
	stationId: "rb:960594a6-0601-11e8-ae97-52543be04c81",
	name: "Rock Antenne",
	streamUrl: "http://mp3channels.webradio.rockantenne.de/rockantenne",
	source: "radio-browser",
	genre: "rock",
	homepage: "http://www.rockantenne.de/",
	logo: "http://www.rockantenne.de/logos/rock-antenne/apple-touch-icon.png",
	country: "Germany",
	language: "german",
	bitrate: 128,
	codec: "MP3",
	tags: ["rock"],
} as const;

const status = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	$type: "fm.teal.actor.status",
	item,
	time: "2026-08-25T13:19:00Z",
	...extra,
});

const rockskyStatus = (extra: Record<string, unknown> = {}) => ({
	$type: "app.rocksky.actor.status",
	track: TRACK,
	startedAt: "2026-08-25T13:18:51.000Z",
	...extra,
});

const atradioStatus = (
	station: Record<string, unknown> = STATION,
	playedAt = "2026-08-25T13:15:00.000Z",
) => ({ $type: "fm.atradio.actor.status", station, playedAt });

let database: TestDatabase;
let artwork: TtlCache<ArtworkEntry>;
let announced: Array<{ to: string; frame: ServerFrame }>;
let ctx: AppContext;

const seedArtwork = (url: string | null) => {
	artwork.set(
		artworkCacheKey({
			track: PLAY.trackName,
			artist: PLAY.artists[0].artistName,
			release: PLAY.releaseName,
			releaseMbId: PLAY.releaseMbId,
		}),
		{ url },
	);
};

const seedStationArtwork = (url: string) => {
	artwork.set(artworkCacheKey({ track: STATION.name }), { url });
};

const sharing = async (shareActivity: boolean) => {
	await database.db
		.insert(database.tables.actorSettings)
		.values({ did: ACTOR, shareActivity })
		.onConflictDoUpdate({ target: database.tables.actorSettings.did, set: { shareActivity } });
};

const storedRow = async () => {
	const [row] = await database.db
		.select()
		.from(database.tables.actorActivity)
		.where(eq(database.tables.actorActivity.did, ACTOR))
		.limit(1);
	return row;
};

const activities = () =>
	announced.map(
		(entry) => (entry.frame.presence as { activity?: { title: string } } | undefined)?.activity,
	);

const applyTeal = (record: unknown) =>
	applyActivityRecord(ctx, ACTOR, TEAL_STATUS_COLLECTION, record);

beforeEach(async () => {
	database = await openTestDatabase();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	artwork = createTtlCache<ArtworkEntry>();
	announced = [];
	published.clear();
	ctx = {
		announce: {
			toUser: (did: string, frame: ServerFrame) => announced.push({ to: did, frame }),
			toCommunity: (community: string, frame: ServerFrame) =>
				announced.push({ to: community, frame }),
		},
		config: { PUBLIC_URL: "https://appview.test", SIGNING_KEY: "abcdef0123456789" },
		database,
		artwork,
		identity: { resolveDid: async () => ({ pds: "https://pds.test" }) },
		voice: null,
		log: { warn: () => undefined, debug: () => undefined },
	} as unknown as AppContext;

	await database.db
		.insert(database.tables.members)
		.values({ did: ACTOR, community: COMMUNITY, roles: [], joinedAt: "2026-08-01T00:00:00.000Z" });
});

afterEach(async () => {
	vi.useRealTimers();
	await database.destroy();
});

describe("readTealStatus", () => {
	it("reads a play into an activity", () => {
		expect(readTealStatus(status(PLAY), NOW)).toEqual({
			kind: "listening",
			title: "Sick Like You",
			subtitle: "Jaira Burns",
			detail: "Hard To Love",
			imageUrl: null,
			linkUri: "https://www.last.fm/music/Jaira+Burns/_/Sick+Like+You",
			startedAt: "2026-08-25T13:18:51.000Z",
			endsAt: "2026-08-25T13:21:11.000Z",
			source: "teal.fm",
			releaseMbId: "mbid:fcdb5202-27a2-4500-90c6-5264a2cd2756",
			searchArtwork: true,
		});
	});

	it("joins every artist named on the play", () => {
		const many = readTealStatus(
			status({ ...PLAY, artists: [{ artistName: "One" }, { artistName: "Two" }] }),
			NOW,
		);
		expect(many?.subtitle).toBe("One, Two");
	});

	it("reads nothing from the empty status teal.fm writes when playback stops", () => {
		expect(
			readTealStatus(
				status({ trackName: "", artists: [] }, { expiry: "2026-08-25T13:19:00Z" }),
				NOW,
			),
		).toBeNull();
	});

	it("reads nothing from a status that has already lapsed", () => {
		expect(readTealStatus(status(PLAY, { expiry: "2026-08-25T13:19:59Z" }), NOW)).toBeNull();
	});

	it("prefers the expiry the record names over the track length", () => {
		const draft = readTealStatus(status(PLAY, { expiry: "2026-08-25T13:25:00Z" }), NOW);
		expect(draft?.endsAt).toBe("2026-08-25T13:25:00.000Z");
	});

	it("falls back to ten minutes when neither an expiry nor a length is given", () => {
		const draft = readTealStatus(
			status({ trackName: "Untitled", artists: [] }, { time: "2026-08-25T13:19:00Z" }),
			NOW,
		);
		expect(draft?.endsAt).toBe("2026-08-25T13:29:00.000Z");
		expect(draft?.subtitle).toBeNull();
	});

	it("drops a link that is not http", () => {
		const draft = readTealStatus(status({ ...PLAY, originUri: "javascript:alert(1)" }), NOW);
		expect(draft?.linkUri).toBeNull();
	});

	it("reads the epoch seconds the alpha collection writes", () => {
		const draft = readTealStatus(
			status({ trackName: "Untitled", artists: [] }, { time: "1766667540", expiry: "1766668140" }),
			Date.parse("2025-12-25T12:00:00.000Z"),
		);
		expect(draft?.endsAt).toBe("2025-12-25T13:09:00.000Z");
	});
});

describe("readRockskyStatus", () => {
	it("reads a track into an activity", () => {
		expect(readRockskyStatus(rockskyStatus(), NOW)).toEqual({
			kind: "listening",
			title: "The Diary of Jane (Single Version)",
			subtitle: "Breaking Benjamin",
			detail: "Phobia (Explicit Version)",
			imageUrl: "https://i.scdn.co/image/ab67616d0000b273742e415e7f4bc3ee0c8ad600",
			linkUri: null,
			startedAt: "2026-08-25T13:18:51.000Z",
			endsAt: "2026-08-25T13:22:11.597Z",
			source: "rocksky.app",
			releaseMbId: null,
			searchArtwork: true,
		});
	});

	it("prefers the expiry the record names over the track length", () => {
		const draft = readRockskyStatus(rockskyStatus({ expiresAt: "2026-08-25T13:25:00.000Z" }), NOW);
		expect(draft?.endsAt).toBe("2026-08-25T13:25:00.000Z");
	});

	it("falls back to ten minutes when neither an expiry nor a length is given", () => {
		const draft = readRockskyStatus(
			{ track: { name: "Untitled", artist: "Nobody" }, startedAt: "2026-08-25T13:19:00.000Z" },
			NOW,
		);
		expect(draft?.endsAt).toBe("2026-08-25T13:29:00.000Z");
	});

	it("reads nothing from a track that has already lapsed", () => {
		const draft = readRockskyStatus(rockskyStatus({ expiresAt: "2026-08-25T13:19:59Z" }), NOW);
		expect(draft).toBeNull();
	});

	it("reads nothing from a record with no track name", () => {
		expect(readRockskyStatus({ track: { artist: "Breaking Benjamin" } }, NOW)).toBeNull();
	});
});

describe("readAtradioStatus", () => {
	it("reads a station into an activity", () => {
		expect(readAtradioStatus(atradioStatus(), NOW)).toEqual({
			kind: "listening",
			title: "Rock Antenne",
			subtitle: "rock",
			detail: null,
			imageUrl: "http://www.rockantenne.de/logos/rock-antenne/apple-touch-icon.png",
			linkUri: "http://www.rockantenne.de/",
			startedAt: "2026-08-25T13:15:00.000Z",
			endsAt: "2026-08-25T19:15:00.000Z",
			source: "atradio.fm",
			releaseMbId: null,
			searchArtwork: false,
		});
	});

	it("falls back to the description when the station names no genre", () => {
		const draft = readAtradioStatus(
			atradioStatus({ name: "88.8 JM FM", description: "88.8 JM FM - Estamos Juntos!" }),
			NOW,
		);
		expect(draft?.subtitle).toBe("88.8 JM FM - Estamos Juntos!");
	});

	it("leaves the subtitle out when the station names neither", () => {
		expect(readAtradioStatus(atradioStatus({ name: "Radio Silence" }), NOW)?.subtitle).toBeNull();
	});

	it("drops a homepage that is not http", () => {
		const draft = readAtradioStatus(
			atradioStatus({ ...STATION, homepage: "javascript:alert(1)" }),
			NOW,
		);
		expect(draft?.linkUri).toBeNull();
	});

	it("never links the stream itself", () => {
		const draft = readAtradioStatus(atradioStatus({ ...STATION, homepage: undefined }), NOW);
		expect(draft?.linkUri).toBeNull();
	});

	it("reads nothing from a station played more than six hours ago", () => {
		expect(readAtradioStatus(atradioStatus(STATION, "2026-07-15T08:57:41.543Z"), NOW)).toBeNull();
	});

	it("keeps a station played within the last six hours", () => {
		const draft = readAtradioStatus(atradioStatus(STATION, "2026-08-25T08:00:00.000Z"), NOW);
		expect(draft?.endsAt).toBe("2026-08-25T14:00:00.000Z");
	});
});

describe("applyActivityRecord", () => {
	it("ignores a status from someone who does not share their listening", async () => {
		await sharing(false);
		await applyTeal(status(PLAY));

		expect(await storedRow()).toBeUndefined();
		expect(announced).toHaveLength(0);
	});

	it("stores the track and tells the actor's communities", async () => {
		await sharing(true);
		seedArtwork("https://coverartarchive.org/release/fcdb5202/front-500");
		await applyTeal(status(PLAY));

		expect((await storedRow())?.title).toBe("Sick Like You");
		expect(announced.map((entry) => entry.to)).toEqual([ACTOR, COMMUNITY]);
		expect(activities()[0]?.title).toBe("Sick Like You");
	});

	it("serves the artwork through this appview rather than the origin", async () => {
		await sharing(true);
		seedArtwork("https://coverartarchive.org/release/fcdb5202/front-500");
		await applyTeal(status(PLAY));

		const activity = await loadActivity(ctx, ACTOR);
		expect(activity?.imageUri).toContain(
			"https://appview.test/xrpc/social.colibri.beta.embed.getImage",
		);
		expect(activity?.imageUri).toContain("sig=");
	});

	it("leaves the artwork out when none could be found", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTeal(status(PLAY));

		expect((await storedRow())?.imageUrl).toBeNull();
		expect((await loadActivity(ctx, ACTOR))?.imageUri).toBeUndefined();
	});

	it("looks the artwork up again for a track stored without any", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTeal(status(PLAY));
		expect((await storedRow())?.imageUrl).toBeNull();

		seedArtwork("https://i.ytimg.com/vi/abc/maxresdefault.jpg");
		await applyTeal(status(PLAY, { expiry: "2026-08-25T13:40:00Z" }));

		expect((await storedRow())?.imageUrl).toBe("https://i.ytimg.com/vi/abc/maxresdefault.jpg");
	});

	it("keeps the artwork it already has for the same track", async () => {
		await sharing(true);
		seedArtwork("https://coverartarchive.org/release/fcdb5202/front-500");
		await applyTeal(status(PLAY));

		seedArtwork(null);
		await applyTeal(status(PLAY, { expiry: "2026-08-25T13:40:00Z" }));

		expect((await storedRow())?.imageUrl).toBe(
			"https://coverartarchive.org/release/fcdb5202/front-500",
		);
	});

	it("says nothing when the same track is written again", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTeal(status(PLAY));
		announced = [];
		await applyTeal(status(PLAY));

		expect(announced).toHaveLength(0);
	});

	it("clears the activity when playback stops", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTeal(status(PLAY));
		announced = [];

		await applyTeal(status({ trackName: "", artists: [] }, { expiry: "2026-08-25T13:19:00Z" }));

		expect(await storedRow()).toBeUndefined();
		expect(activities()[0]).toBeUndefined();
		expect(announced).toHaveLength(2);
	});

	it("reads the alpha collection with the same parser", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyActivityRecord(ctx, ACTOR, TEAL_ALPHA_STATUS_COLLECTION, status(PLAY));

		expect((await storedRow())?.source).toBe("teal.fm");
	});

	it("ignores a collection no provider claims", async () => {
		await sharing(true);
		await applyActivityRecord(ctx, ACTOR, "app.bsky.feed.post", { text: "hello" });

		expect(await storedRow()).toBeUndefined();
	});

	it("stores a rocksky track with the cover the record carries", async () => {
		await sharing(true);
		await applyActivityRecord(ctx, ACTOR, ROCKSKY_STATUS_COLLECTION, rockskyStatus());

		const row = await storedRow();
		expect(row?.source).toBe("rocksky.app");
		expect(row?.imageUrl).toBe("https://i.scdn.co/image/ab67616d0000b273742e415e7f4bc3ee0c8ad600");
	});

	it("stores a station with its logo and never searches for cover art", async () => {
		await sharing(true);
		seedStationArtwork("https://coverartarchive.org/release/wrong/front-500");
		await applyActivityRecord(
			ctx,
			ACTOR,
			ATRADIO_STATUS_COLLECTION,
			atradioStatus({ ...STATION, logo: undefined }),
		);

		const row = await storedRow();
		expect(row?.title).toBe("Rock Antenne");
		expect(row?.imageUrl).toBeNull();
	});

	it("lets the service that wrote last take the row", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTeal(status(PLAY));
		await applyActivityRecord(ctx, ACTOR, ROCKSKY_STATUS_COLLECTION, rockskyStatus());

		const row = await storedRow();
		expect(row?.source).toBe("rocksky.app");
		expect(row?.title).toBe("The Diary of Jane (Single Version)");
	});

	it("says nothing when a second service reports the track already showing", async () => {
		await sharing(true);
		await applyActivityRecord(ctx, ACTOR, ROCKSKY_STATUS_COLLECTION, rockskyStatus());
		announced = [];

		await applyTeal(
			status({
				trackName: TRACK.name,
				artists: [{ artistName: TRACK.artist }],
				releaseName: TRACK.album,
				playedTime: "2026-08-25T13:18:51.000Z",
				duration: 200,
			}),
		);

		expect(announced).toHaveLength(0);
		expect((await storedRow())?.source).toBe("rocksky.app");
	});

	it("extends the window a second service reports for the same track", async () => {
		await sharing(true);
		await applyActivityRecord(ctx, ACTOR, ROCKSKY_STATUS_COLLECTION, rockskyStatus());

		await applyTeal(
			status(
				{
					trackName: TRACK.name,
					artists: [{ artistName: TRACK.artist }],
					releaseName: TRACK.album,
					playedTime: "2026-08-25T13:18:51.000Z",
				},
				{ expiry: "2026-08-25T13:40:00.000Z" },
			),
		);

		const row = await storedRow();
		expect(row?.endsAt).toBe("2026-08-25T13:40:00.000Z");
		expect(row?.source).toBe("rocksky.app");
	});

	it("falls back to a service still playing when another stops", async () => {
		await sharing(true);
		published.set(ATRADIO_STATUS_COLLECTION, atradioStatus());
		await applyActivityRecord(ctx, ACTOR, ROCKSKY_STATUS_COLLECTION, rockskyStatus());

		await applyActivityRecord(ctx, ACTOR, ROCKSKY_STATUS_COLLECTION, {
			track: { name: "" },
			startedAt: "2026-08-25T13:19:00.000Z",
		});

		const row = await storedRow();
		expect(row?.source).toBe("atradio.fm");
		expect(row?.title).toBe("Rock Antenne");
	});
});

describe("backfillActivity", () => {
	it("picks up a record written before sharing was turned on", async () => {
		await sharing(true);
		published.set(ROCKSKY_STATUS_COLLECTION, rockskyStatus());

		await backfillActivity(ctx, ACTOR);

		expect((await storedRow())?.source).toBe("rocksky.app");
	});

	it("prefers the service whose track started most recently", async () => {
		await sharing(true);
		seedArtwork(null);
		published.set(TEAL_STATUS_COLLECTION, status(PLAY));
		published.set(ATRADIO_STATUS_COLLECTION, atradioStatus());

		await backfillActivity(ctx, ACTOR);

		expect((await storedRow())?.source).toBe("teal.fm");
	});

	it("ignores every stale record it finds", async () => {
		await sharing(true);
		published.set(ATRADIO_STATUS_COLLECTION, atradioStatus(STATION, "2026-07-15T08:57:41.543Z"));

		await backfillActivity(ctx, ACTOR);

		expect(await storedRow()).toBeUndefined();
		expect(announced).toHaveLength(0);
	});

	it("reads nothing for someone who does not share their listening", async () => {
		await sharing(false);
		published.set(ROCKSKY_STATUS_COLLECTION, rockskyStatus());

		await backfillActivity(ctx, ACTOR);

		expect(await storedRow()).toBeUndefined();
	});
});

describe("loadActivity", () => {
	it("hides an activity from someone who stopped sharing", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTeal(status(PLAY));
		await sharing(false);

		expect(await loadActivity(ctx, ACTOR)).toBeUndefined();
	});

	it("hides an activity that has lapsed", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTeal(status(PLAY, { expiry: "2026-08-25T13:25:00Z" }));

		await database.db
			.update(database.tables.actorActivity)
			.set({ endsAt: "2020-01-01T00:00:00.000Z" })
			.where(eq(database.tables.actorActivity.did, ACTOR));

		expect(await loadActivity(ctx, ACTOR)).toBeUndefined();
	});
});

describe("clearing", () => {
	it("says nothing when there was nothing to clear", async () => {
		await clearActivity(ctx, ACTOR);
		expect(announced).toHaveLength(0);
	});

	it("drops the activity of someone who turns sharing off", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTeal(status(PLAY));

		await setActivitySharing(ctx, ACTOR, false);
		expect(await storedRow()).toBeUndefined();
	});

	it("sweeps up an activity that lapsed while nothing was written", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTeal(status(PLAY));
		await database.db
			.update(database.tables.actorActivity)
			.set({ endsAt: "2020-01-01T00:00:00.000Z" })
			.where(eq(database.tables.actorActivity.did, ACTOR));

		expect(await sweepLapsedActivities(ctx)).toBe(1);
		expect(await storedRow()).toBeUndefined();
	});
});
