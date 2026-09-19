import type { BlobRef } from "@atproto/lex-schema";
import type { ActivityKind } from "@colibri-social/appview-db";
import { blobCid } from "@colibri-social/lexicons";

export const TEAL_STATUS_COLLECTION = "fm.teal.actor.status";
export const TEAL_ALPHA_STATUS_COLLECTION = "fm.teal.alpha.actor.status";
export const ROCKSKY_STATUS_COLLECTION = "app.rocksky.actor.status";
export const ATRADIO_STATUS_COLLECTION = "fm.atradio.actor.status";
export const GAMES_STATUS_COLLECTION = "games.atmosphere.status";

export const TEAL_SOURCE = "teal.fm";
export const ROCKSKY_SOURCE = "rocksky.app";
export const ATRADIO_SOURCE = "atradio.fm";
export const GAMES_SOURCE = "atmosphere.games";

const LISTENING = "listening" satisfies ActivityKind;
const PLAYING = "playing" satisfies ActivityKind;
const MAX_TEXT = 256;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const ATRADIO_WINDOW_MS = 6 * 60 * 60 * 1000;
const EPOCH_SECONDS_LIMIT = 1e11;

type TealArtist = { artistName?: unknown };

type TealPlay = {
  trackName?: unknown;
  artists?: unknown;
  releaseName?: unknown;
  releaseMbId?: unknown;
  originUri?: unknown;
  playedTime?: unknown;
  duration?: unknown;
};

type TealStatus = { item?: unknown; time?: unknown; expiry?: unknown };

type RockskyTrack = {
  name?: unknown;
  artist?: unknown;
  album?: unknown;
  albumCoverUrl?: unknown;
  durationMs?: unknown;
};

type RockskyStatus = {
  track?: unknown;
  startedAt?: unknown;
  expiresAt?: unknown;
};

type AtradioStation = {
  name?: unknown;
  genre?: unknown;
  description?: unknown;
  logo?: unknown;
  homepage?: unknown;
};

type AtradioStatus = { station?: unknown; playedAt?: unknown };

export type ActivityDraft = {
  kind: ActivityKind;
  title: string;
  subtitle: string | null;
  detail: string | null;
  imageUrl: string | null;
  linkUri: string | null;
  startedAt: string | null;
  endsAt: string | null;
  source: string;
  releaseMbId: string | null;
  searchArtwork: boolean;
};

type GameStatus = {
  game: string;
  platform?: {};
  state?: string;
  details?: {
    event?: string;
    startedAt: string;
    endsAt: string;
  };
  playing?: {
    id?: string;
    party?: {
      current: number;
      dids?: string[];
      max?: number;
    };
  };
  embed?: {
    external: {
      uri: string;
      thumb: BlobRef;
      title: string;
      description: string;
    };
  };
  createdAt: string;
  staleAt: string;
};

type GameMediaItem = {
  blob?: BlobRef;
  title?: string;
  width?: number;
  height?: number;
  locale?: string;
  mediaType:
    | "accoladesTrailer"
    | "announcementTrailer"
    | "artwork"
    | "cinematicTrailer"
    | "conceptArt"
    | "cover"
    | "coverAlt"
    | "coverHistorical"
    | "coverSquare"
    | "cutscene"
    | "devDiary"
    | "gameplayImage"
    | "gameplayTrailer"
    | "icon"
    | "infographic"
    | "intro"
    | "keyArt"
    | "keyArtLogo"
    | "launchTrailer"
    | "logoBlack"
    | "logoColor"
    | "logoWhite"
    | "releaseDateTrailer"
    | "screenshot"
    | "teaser"
    | "trailer";
  description: string;
};

type GameInfo = {
  name: string;
  media?: GameMediaItem[];
  parent?: string;
  engines?: string[];
  summary?: string;
  keywords?: string[];
  createdAt: string;
  storyline?: string;
  description?: string;
  publishedAt?: string;
  // TODO: Other types we don't care about yet are not mentioned here
};

export const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed;
};

export const httpUrl = (value: unknown): string | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

export const instant = (value: unknown): number | undefined => {
  const raw = text(value);
  if (!raw) return undefined;

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;

  const epoch = Number(raw);
  if (!Number.isFinite(epoch) || epoch <= 0) return undefined;
  return epoch < EPOCH_SECONDS_LIMIT ? epoch * 1000 : epoch;
};

const positiveNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

const artistNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => text((entry as TealArtist | null)?.artistName))
    .filter((name): name is string => name !== undefined);
};

export const readTealStatus = (
  record: unknown,
  nowMs: number,
): ActivityDraft | null => {
  const status = (record ?? {}) as TealStatus;
  const item = (status.item ?? {}) as TealPlay;

  const title = text(item.trackName);
  if (!title) return null;

  const wroteAt = instant(status.time) ?? nowMs;
  const startedAt = instant(item.playedTime) ?? wroteAt;
  const duration = positiveNumber(item.duration);
  const endsAt =
    instant(status.expiry) ??
    (duration ? startedAt + duration * 1000 : wroteAt + DEFAULT_WINDOW_MS);
  if (endsAt <= nowMs) return null;

  const artists = artistNames(item.artists);

  return {
    kind: LISTENING,
    title,
    subtitle: artists.length > 0 ? artists.join(", ").slice(0, MAX_TEXT) : null,
    detail: text(item.releaseName) ?? null,
    imageUrl: null,
    linkUri: httpUrl(item.originUri) ?? null,
    startedAt: new Date(startedAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    source: TEAL_SOURCE,
    releaseMbId: text(item.releaseMbId) ?? null,
    searchArtwork: true,
  };
};

export const readRockskyStatus = (
  record: unknown,
  nowMs: number,
): ActivityDraft | null => {
  const status = (record ?? {}) as RockskyStatus;
  const track = (status.track ?? {}) as RockskyTrack;

  const title = text(track.name);
  if (!title) return null;

  const startedAt = instant(status.startedAt) ?? nowMs;
  const durationMs = positiveNumber(track.durationMs);
  const endsAt =
    instant(status.expiresAt) ??
    (durationMs ? startedAt + durationMs : startedAt + DEFAULT_WINDOW_MS);
  if (endsAt <= nowMs) return null;

  return {
    kind: LISTENING,
    title,
    subtitle: text(track.artist) ?? null,
    detail: text(track.album) ?? null,
    imageUrl: httpUrl(track.albumCoverUrl) ?? null,
    linkUri: null,
    startedAt: new Date(startedAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    source: ROCKSKY_SOURCE,
    releaseMbId: null,
    searchArtwork: true,
  };
};

export const readAtradioStatus = (
  record: unknown,
  nowMs: number,
): ActivityDraft | null => {
  const status = (record ?? {}) as AtradioStatus;
  const station = (status.station ?? {}) as AtradioStation;

  const title = text(station.name);
  if (!title) return null;

  const startedAt = instant(status.playedAt) ?? nowMs;
  const endsAt = startedAt + ATRADIO_WINDOW_MS;
  if (endsAt <= nowMs) return null;

  return {
    kind: LISTENING,
    title,
    subtitle: text(station.genre) ?? text(station.description) ?? null,
    detail: null,
    imageUrl: httpUrl(station.logo) ?? null,
    linkUri: httpUrl(station.homepage) ?? null,
    startedAt: new Date(startedAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    source: ATRADIO_SOURCE,
    releaseMbId: null,
    searchArtwork: false,
  };
};

const fetchGameRecord = async (atUri: string): Promise<GameInfo> => {
  return {} as GameInfo;
};

export const readGamesStatus = async (
  record: unknown,
  nowMs: number,
): Promise<ActivityDraft | null> => {
  const status = (record ?? {}) as GameStatus;

  const game = await fetchGameRecord(status.game);

  const title = text(game.name);
  if (!title) return null;

  const wroteAt = instant(status.createdAt) ?? nowMs;
  const startedAt = instant(status.createdAt) ?? wroteAt;
  const staleAt = instant(status.staleAt) ?? nowMs;
  if (staleAt <= nowMs) return null;

  const mediaArray = game.media ?? [];
  const imageUrl =
    mediaArray.length === 0
      ? null
      : blobCid(
          mediaArray.find((x) => x.mediaType === "cover")?.blob ??
            mediaArray[0]?.blob,
        );

  return {
    kind: PLAYING,
    title,
    // TODO: Surface more info here
    subtitle: null,
    detail: null,
    imageUrl,
    linkUri: httpUrl(status.embed?.external.uri) ?? null,
    startedAt: new Date(startedAt).toISOString(),
    endsAt: new Date(staleAt).toISOString(),
    source: GAMES_SOURCE,
    releaseMbId: null,
    searchArtwork: false,
  };
};

export type ActivityProvider = {
  collection: string;
  source: string;
  read: (
    record: unknown,
    nowMs: number,
  ) => Promise<ActivityDraft | null> | ActivityDraft | null;
};

export const ACTIVITY_PROVIDERS: readonly ActivityProvider[] = [
  {
    collection: TEAL_STATUS_COLLECTION,
    source: TEAL_SOURCE,
    read: readTealStatus,
  },
  {
    collection: TEAL_ALPHA_STATUS_COLLECTION,
    source: TEAL_SOURCE,
    read: readTealStatus,
  },
  {
    collection: ROCKSKY_STATUS_COLLECTION,
    source: ROCKSKY_SOURCE,
    read: readRockskyStatus,
  },
  {
    collection: ATRADIO_STATUS_COLLECTION,
    source: ATRADIO_SOURCE,
    read: readAtradioStatus,
  },
  {
    collection: GAMES_STATUS_COLLECTION,
    source: GAMES_SOURCE,
    read: readGamesStatus,
  },
];

export const ACTIVITY_COLLECTIONS = ACTIVITY_PROVIDERS.map(
  (provider) => provider.collection,
);

const byCollection = new Map(
  ACTIVITY_PROVIDERS.map((provider) => [provider.collection, provider]),
);

export const activityProviderFor = (
  collection: string,
): ActivityProvider | undefined => byCollection.get(collection);
