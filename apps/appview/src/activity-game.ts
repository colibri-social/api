import { AtUri } from "@atproto/syntax";
import type { TtlCache } from "@colibri-social/embeds";
import { blobCid } from "@colibri-social/lexicons";
import { PdsClient } from "@colibri-social/space";
import { text } from "./activity-providers.js";

export const GAME_CACHE_MAX_ENTRIES = 1_000;
export const GAME_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const COVER = "cover";

export type GameEntry = { title: string | null; imageUrl: string | null };

type GameMedia = { blob?: unknown; mediaType?: unknown };

type GameRecord = { name?: unknown; media?: unknown };

export type GameLog = {
	debug: (detail: Record<string, unknown>, event: string) => void;
};

export type GameIdentity = {
	resolveDid: (did: string) => Promise<{ pds: string | null }>;
};

export type GameDeps = {
	cache: TtlCache<GameEntry>;
	identity: GameIdentity;
	log: GameLog;
};

const NOTHING: GameEntry = { title: null, imageUrl: null };

const recordRef = (atUri: string): AtUri | null => {
	try {
		const uri = new AtUri(atUri);
		return uri.host && uri.collection && uri.rkey ? uri : null;
	} catch {
		return null;
	}
};

const coverUrl = (pds: string, repo: string, media: unknown): string | null => {
	if (!Array.isArray(media) || media.length === 0) return null;

	const items = media as GameMedia[];
	const cid = blobCid(items.find((item) => item.mediaType === COVER)?.blob ?? items[0]?.blob);
	if (!cid) return null;

	const url = new URL("/xrpc/com.atproto.sync.getBlob", pds);
	url.searchParams.set("did", repo);
	url.searchParams.set("cid", cid);
	return url.toString();
};

export const resolveGame = async (deps: GameDeps, atUri: string): Promise<GameEntry> => {
	const cached = deps.cache.get(atUri);
	if (cached) return cached;

	const ref = recordRef(atUri);
	if (!ref) return NOTHING;

	const pds = (await deps.identity.resolveDid(ref.host).catch(() => null))?.pds;
	if (!pds) {
		deps.log.debug({ atUri }, "activity.gameRepoUnresolved");
		return NOTHING;
	}

	const record = await new PdsClient({ service: pds })
		.getPublicRecord<{ value: unknown }>(ref.host, ref.collection, ref.rkey)
		.then((found) => found.value as GameRecord)
		.catch(() => null);
	if (!record) {
		deps.log.debug({ atUri }, "activity.gameRecordMissing");
		return NOTHING;
	}

	const entry: GameEntry = {
		title: text(record.name) ?? null,
		imageUrl: coverUrl(pds, ref.host, record.media),
	};
	deps.cache.set(atUri, entry);
	return entry;
};
