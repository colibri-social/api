import {
	asDid,
	asHandle,
	asUriOrUndefined,
	blobCid,
	COLLECTIONS,
	type social,
} from "@colibri-social/lexicons";
import { PdsClient } from "@colibri-social/space";
import { inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { presenceOf } from "../presence.js";
import { type ActivityView, loadActivities } from "./activity.js";

export type ProfileView = social.colibri.beta.actor.defs.ProfileView;
export type Presence = social.colibri.beta.actor.defs.Presence;

type ColibriProfile = social.colibri.beta.actor.profile.Main;
type BlueskyProfile = {
	displayName?: string;
	description?: string;
	avatar?: unknown;
	banner?: unknown;
};

const CACHE_TTL_MS = 15 * 60 * 1000;

export type HydrateOptions = { refresh?: ReadonlySet<string> };
const BSKY_PROFILE = "app.bsky.actor.profile";

const resolve = (colibri: ColibriProfile | null, bsky: BlueskyProfile | null) => {
	const synced = colibri?.syncBluesky ?? colibri === null;
	return {
		displayName: (synced ? bsky?.displayName : colibri?.displayName) ?? undefined,
		description: (synced ? bsky?.description : colibri?.description) ?? undefined,
		avatarCid: blobCid(synced ? bsky?.avatar : colibri?.avatar),
		bannerCid: blobCid(synced ? bsky?.banner : colibri?.banner),
		theme: colibri?.theme,
		preferredBadge: colibri?.preferredBadge,
		syncBluesky: Boolean(colibri?.syncBluesky),
	};
};

export class ActorViews {
	constructor(private readonly ctx: AppContext) {}

	private blobUrl(
		did: string,
		cid: string | null,
		variant: "avatar" | "banner",
	): string | undefined {
		if (!cid) return undefined;
		const url = new URL("/xrpc/social.colibri.beta.blob.get", this.ctx.config.PUBLIC_URL);
		url.searchParams.set("did", did);
		url.searchParams.set("cid", cid);
		url.searchParams.set("variant", variant);
		return url.toString();
	}

	private async cachedProfiles(dids: string[]) {
		if (dids.length === 0)
			return new Map<string, { colibri: unknown; bsky: unknown; fetchedAt: string }>();
		const rows = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.profileCache)
			.where(inArray(this.ctx.database.tables.profileCache.did, dids));
		return new Map(rows.map((row) => [row.did, row]));
	}

	private async fetchProfile(did: string): Promise<{ colibri: unknown; bsky: unknown }> {
		const pds = (await this.ctx.identity.resolveDid(did).catch(() => null))?.pds;
		if (!pds) return { colibri: null, bsky: null };
		const client = new PdsClient({ service: pds });
		const [colibri, bsky] = await Promise.all([
			client
				.getPublicRecord<{ value: unknown }>(did, COLLECTIONS.profile, "self")
				.then((record) => record.value)
				.catch(() => null),
			client
				.getPublicRecord<{ value: unknown }>(did, BSKY_PROFILE, "self")
				.then((record) => record.value)
				.catch(() => null),
		]);
		await this.ctx.database.db
			.insert(this.ctx.database.tables.profileCache)
			.values({
				did,
				colibri: (colibri as Record<string, unknown>) ?? null,
				bsky: (bsky as Record<string, unknown>) ?? null,
				fetchedAt: new Date().toISOString(),
			})
			.onConflictDoUpdate({
				target: this.ctx.database.tables.profileCache.did,
				set: {
					colibri: (colibri as Record<string, unknown>) ?? null,
					bsky: (bsky as Record<string, unknown>) ?? null,
					fetchedAt: new Date().toISOString(),
				},
			});
		return { colibri, bsky };
	}

	async hydrate(
		dids: readonly string[],
		options: HydrateOptions = {},
	): Promise<Map<string, ProfileView>> {
		const unique = [...new Set(dids)];
		const cached = await this.cachedProfiles(unique);
		const stale = unique.filter((did) => {
			if (options.refresh?.has(did)) return true;
			const row = cached.get(did);
			return !row || Date.now() - new Date(row.fetchedAt).getTime() > CACHE_TTL_MS;
		});

		const fetched = new Map(
			await Promise.all(stale.map(async (did) => [did, await this.fetchProfile(did)] as const)),
		);

		const activities = await loadActivities(this.ctx, unique);

		const out = new Map<string, ProfileView>();
		for (const did of unique) {
			const source = fetched.get(did) ?? cached.get(did) ?? { colibri: null, bsky: null };
			const resolved = resolve(
				(source.colibri as ColibriProfile) ?? null,
				(source.bsky as BlueskyProfile) ?? null,
			);
			const handle = await this.ctx.identity.resolveVerifiedHandle(did).catch(() => null);
			const presence = await this.presenceFor(did, activities.get(did));

			out.set(did, {
				did: asDid(did),
				handle: asHandle(handle ?? "handle.invalid"),
				displayName: resolved.displayName ?? handle ?? did,
				description: resolved.description,
				avatar: asUriOrUndefined(this.blobUrl(did, resolved.avatarCid, "avatar")),
				banner: asUriOrUndefined(this.blobUrl(did, resolved.bannerCid, "banner")),
				isBot: false,
				syncBluesky: resolved.syncBluesky,
				theme: resolved.theme,
				preferredBadge: resolved.preferredBadge,
				presence,
			});
		}
		return out;
	}

	async one(did: string, options: HydrateOptions = {}): Promise<ProfileView> {
		const map = await this.hydrate([did], options);
		return map.get(did) as ProfileView;
	}

	private async presenceFor(did: string, activity?: ActivityView): Promise<Presence | undefined> {
		const [row] = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.userPresence)
			.where(inArray(this.ctx.database.tables.userPresence.did, [did]))
			.limit(1);
		if (!row) return undefined;
		return presenceOf(this.ctx, did, row, activity);
	}
}
