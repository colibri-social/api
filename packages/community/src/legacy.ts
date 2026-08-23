import { LEGACY_COLLECTIONS, SELF } from "@colibri-social/lexicons";
import type { PdsClient } from "@colibri-social/space";

export type LegacyDeps = {
	hostFor: (did: string) => Promise<string>;
	clientFor: (endpoint: string) => PdsClient;
};

export type LegacyCommunity = {
	did: string;
	name: string;
	description?: string;
	memberCount: number;
	channelCount: number;
	viewerIsAdmin: boolean;
	migratedTo?: string;
};

type PagedRecord<T> = { uri: string; value: T };

const repoFor = async (deps: LegacyDeps, did: string): Promise<PdsClient> =>
	deps.clientFor(await deps.hostFor(did));

const listAll = async <T>(
	pds: PdsClient,
	repo: string,
	collection: string,
): Promise<PagedRecord<T>[]> => {
	const out: PagedRecord<T>[] = [];
	let cursor: string | undefined;
	do {
		const page = await pds.xrpc.query<{ records: PagedRecord<T>[]; cursor?: string }>(
			"com.atproto.repo.listRecords",
			{ repo, collection, limit: 100, cursor },
		);
		out.push(...page.records);
		cursor = page.cursor;
	} while (cursor);
	return out;
};

const communityDidOf = (uri: string): string | null => {
	const authority = uri.replace("at://", "").split("/")[0];
	return authority?.startsWith("did:") ? authority : null;
};

export const legacyCandidates = async (deps: LegacyDeps, actor: string): Promise<string[]> => {
	const repo = await repoFor(deps, actor);

	const ordered = await repo
		.getPublicRecord<{ value: { communities?: string[] } }>(
			actor,
			LEGACY_COLLECTIONS.actorData,
			SELF,
		)
		.then((record) => record.value.communities ?? [])
		.catch(() => []);

	const joined = await listAll<{ community?: string }>(
		repo,
		actor,
		LEGACY_COLLECTIONS.membership,
	).catch(() => []);

	const dids: string[] = [];
	const seen = new Set<string>();
	const add = (did: string | null) => {
		if (!did || did === actor || seen.has(did)) return;
		seen.add(did);
		dids.push(did);
	};

	for (const did of ordered) add(did.startsWith("did:") ? did : null);
	for (const record of joined) {
		if (!record.value.community) continue;
		const did = communityDidOf(record.value.community);
		if (did) add(did);
	}

	return dids;
};

export const readLegacyCommunity = async (
	deps: LegacyDeps,
	community: string,
	actor: string,
): Promise<LegacyCommunity | null> => {
	const repo = await repoFor(deps, community);

	const profile = await repo
		.getPublicRecord<{
			value: { name?: string; description?: string; migratedTo?: string };
		}>(community, LEGACY_COLLECTIONS.community, SELF)
		.catch(() => null);
	if (!profile) return null;

	const [members, channels, roles] = await Promise.all([
		listAll<{ subject?: string; roles?: string[] }>(repo, community, LEGACY_COLLECTIONS.member),
		listAll<unknown>(repo, community, LEGACY_COLLECTIONS.channel),
		listAll<{ protected?: boolean }>(repo, community, LEGACY_COLLECTIONS.role),
	]);

	const protectedRoles = new Set(
		roles
			.filter((role) => role.value.protected === true)
			.map((role) => role.uri.split("/").pop() as string),
	);
	const membership = members.find((member) => member.value.subject === actor);
	const viewerIsAdmin =
		actor === community || (membership?.value.roles ?? []).some((role) => protectedRoles.has(role));

	return {
		did: community,
		name: profile.value.name ?? community,
		...(profile.value.description ? { description: profile.value.description } : {}),
		memberCount: members.length,
		channelCount: channels.length,
		viewerIsAdmin,
		...(profile.value.migratedTo ? { migratedTo: profile.value.migratedTo } : {}),
	};
};

export const legacyAdmin = async (
	deps: LegacyDeps,
	community: string,
	actor: string,
): Promise<boolean> => {
	const legacy = await readLegacyCommunity(deps, community, actor);
	return legacy?.viewerIsAdmin ?? false;
};
