import { InvalidRequestError } from "@atproto/xrpc-server";
import {
	type LegacyCommunity,
	legacyCandidates,
	readLegacyCommunity,
} from "@colibri-social/community";
import {
	asDid,
	asHandleOrUndefined,
	asUriOrUndefined,
	blobCid,
	type social,
} from "@colibri-social/lexicons";
import { inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { type MigrationRow, migrationJobs, progressOf } from "../migrations.js";

type LegacyCommunityView = social.colibri.beta.community.defs.LegacyCommunityView;
type MigratableList = social.colibri.beta.community.listMigratable.$OutputBody;

export const legacyDeps = (ctx: AppContext) => ({
	hostFor: (did: string) => ctx.hosts.hostFor(did),
	clientFor: (endpoint: string) => ctx.credentials.clientFor(endpoint),
	log: (event: string, detail: Record<string, unknown>) => ctx.log.warn(detail, event),
});

const publicBlobUrl = (ctx: AppContext, did: string, blob: unknown): string | undefined => {
	const cid = blobCid(blob);
	if (!cid) return undefined;
	const url = new URL("/xrpc/social.colibri.beta.blob.get", ctx.config.PUBLIC_URL);
	url.searchParams.set("did", did);
	url.searchParams.set("cid", cid);
	return url.toString();
};

const handleOf = async (ctx: AppContext, did: string) =>
	asHandleOrUndefined(await ctx.identity.resolveVerifiedHandle(did).catch(() => null));

const blockedReasonOf = (legacy: LegacyCommunity): LegacyCommunityView["blockedReason"] => {
	if (legacy.ownerRepo) return "ownerRepo";
	if (!legacy.hasAdmin) return "noAdmin";
	return undefined;
};

export const legacyView = async (
	ctx: AppContext,
	legacy: LegacyCommunity,
	migration: MigrationRow | null,
): Promise<LegacyCommunityView> => {
	const blockedReason = blockedReasonOf(legacy);
	const migrating = migration?.state === "running";
	const state = blockedReason ? "blocked" : migrating ? "migrating" : "migratable";
	return {
		did: asDid(legacy.did),
		handle: legacy.ownerRepo ? undefined : await handleOf(ctx, legacy.did),
		name: legacy.name,
		description: legacy.description,
		picture: asUriOrUndefined(publicBlobUrl(ctx, legacy.did, legacy.picture)),
		memberCount: legacy.memberCount,
		channelCount: legacy.channelCount,
		viewerIsAdmin: legacy.viewerIsAdmin,
		owner: legacy.owner
			? { did: asDid(legacy.owner), handle: await handleOf(ctx, legacy.owner) }
			: undefined,
		state,
		blockedReason,
		progress: migration && migration.state !== "done" ? progressOf(migration) : undefined,
	};
};

const unreadableView = (did: string): LegacyCommunityView => ({
	did: asDid(did),
	name: did,
	viewerIsAdmin: false,
	state: "blocked",
	blockedReason: "unreadable",
});

export const handleListMigratable = async (
	ctx: AppContext,
	callerDid: string,
	includeUnadministered: boolean,
): Promise<MigratableList> => {
	const deps = legacyDeps(ctx);
	const candidates = await legacyCandidates(deps, callerDid).catch((cause) => {
		throw new InvalidRequestError(
			`could not read ${callerDid}'s repo: ${cause instanceof Error ? cause.message : String(cause)}`,
			"UpstreamFailure",
		);
	});
	if (candidates.length === 0) return { communities: [] };

	const jobs = migrationJobs(ctx);
	const migrations = await jobs.all(candidates);
	const indexed = new Set(
		(
			await ctx.database.db
				.select({ did: ctx.database.tables.communities.did })
				.from(ctx.database.tables.communities)
				.where(inArray(ctx.database.tables.communities.did, candidates))
		).map((row) => row.did),
	);

	const communities: LegacyCommunityView[] = [];
	for (const did of candidates) {
		const migration = migrations.get(did) ?? null;
		if (migration?.state === "done") continue;
		if (!migration && indexed.has(did)) continue;

		const legacy = await readLegacyCommunity(deps, did, callerDid).catch(() => null);
		if (!legacy) {
			if (includeUnadministered) communities.push(unreadableView(did));
			continue;
		}
		if (legacy.migratedTo && !migration) continue;
		if (!legacy.viewerIsAdmin && !includeUnadministered) continue;
		communities.push(await legacyView(ctx, legacy, migration));
	}

	return { communities };
};

const communityNotFound = () =>
	new InvalidRequestError("no community exists at that identifier", "CommunityNotFound");

export const handleMigrateCommunity = async (
	ctx: AppContext,
	callerDid: string,
	identifier: string,
): Promise<{ community: LegacyCommunityView }> => {
	const legacyDid = await ctx.identity
		.resolveAtIdentifier(identifier)
		.then((identity) => identity.did)
		.catch(() => null);
	if (!legacyDid) throw communityNotFound();

	const jobs = migrationJobs(ctx);
	const migration = await jobs.get(legacyDid);
	const alreadyMigrated = () =>
		new InvalidRequestError("this legacy community has already been migrated", "AlreadyExists");
	if (migration?.state === "done") throw alreadyMigrated();
	if (!migration && (await ctx.loader.community(legacyDid))) throw alreadyMigrated();

	const legacy = await readLegacyCommunity(legacyDeps(ctx), legacyDid, callerDid).catch(() => null);
	if (!legacy) throw communityNotFound();
	if (blockedReasonOf(legacy)) {
		throw new InvalidRequestError("this community cannot move onto spaces", "NotMigratable");
	}
	if (!legacy.viewerIsAdmin) {
		throw new InvalidRequestError(
			"only an administrator of the legacy community may migrate it",
			"Forbidden",
		);
	}

	const started = await jobs.start(legacyDid, callerDid);
	return { community: await legacyView(ctx, legacy, started) };
};
