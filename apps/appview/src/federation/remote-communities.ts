import type { social } from "@colibri-social/lexicons";
import type { Forwarder } from "./forward.js";
import type { SpaceHostResolver } from "./resolve-host.js";

type CommunityView = social.colibri.beta.community.defs.CommunityView;

export const REMOTE_COMMUNITY_TIMEOUT_MS = 3_000;
export const REMOTE_COMMUNITY_CACHE_MS = 30_000;
export const REMOTE_COMMUNITY_CACHE_SIZE = 10_000;

const GET_COMMUNITY = "social.colibri.beta.community.getCommunity";

export type RemoteSpaceRow = { community: string; managingApp: string };

export type RemoteCommunity =
	| { kind: "view"; view: CommunityView }
	| { kind: "unavailable"; did: string; managingApp: string }
	| { kind: "gone" };

export type RemoteCommunityDeps = {
	enabled: boolean;
	hosts: Pick<SpaceHostResolver, "resolve" | "forget">;
	forward: Forwarder;
	timeoutMs?: number;
	cacheMs?: number;
	now?: () => number;
};

const errorOf = (body: Buffer): string | undefined => {
	try {
		const parsed = JSON.parse(body.toString("utf8")) as { error?: unknown };

		return typeof parsed.error === "string" ? parsed.error : undefined;
	} catch {
		return undefined;
	}
};

const viewOf = (body: Buffer): CommunityView | undefined => {
	try {
		const parsed = JSON.parse(body.toString("utf8")) as { community?: CommunityView };

		return parsed.community?.did ? parsed.community : undefined;
	} catch {
		return undefined;
	}
};

export const createRemoteCommunities = (deps: RemoteCommunityDeps) => {
	const now = deps.now ?? Date.now;
	const cacheMs = deps.cacheMs ?? REMOTE_COMMUNITY_CACHE_MS;
	const cache = new Map<string, { view: CommunityView; at: number }>();

	const cached = (key: string): CommunityView | undefined => {
		const entry = cache.get(key);

		if (!entry) return undefined;

		if (now() - entry.at < cacheMs) return entry.view;

		cache.delete(key);

		return undefined;
	};

	const remember = (key: string, view: CommunityView) => {
		cache.delete(key);
		cache.set(key, { view, at: now() });

		if (cache.size <= REMOTE_COMMUNITY_CACHE_SIZE) return;

		const oldest = cache.keys().next().value;

		if (oldest !== undefined) cache.delete(oldest);
	};

	const fetchOne = async (callerDid: string, row: RemoteSpaceRow): Promise<RemoteCommunity> => {
		const unavailable = (managingApp: string): RemoteCommunity => {
			return { kind: "unavailable", did: row.community, managingApp };
		};

		if (!deps.enabled) return unavailable(row.managingApp);

		const key = `${callerDid} ${row.community}`;
		const hit = cached(key);

		if (hit) return { kind: "view", view: hit };

		let host: Awaited<ReturnType<SpaceHostResolver["resolve"]>>;

		try {
			host = await deps.hosts.resolve(row.community);
		} catch {
			return unavailable(row.managingApp);
		}

		if (!host) return unavailable(row.managingApp);

		if (host.local) return { kind: "gone" };

		try {
			const answer = await deps.forward(host, {
				method: "GET",
				path: `/xrpc/${GET_COMMUNITY}?community=${encodeURIComponent(row.community)}`,
				nsid: GET_COMMUNITY,
				headers: { accept: "application/json" },
				body: undefined,
				actingFor: callerDid,
				timeoutMs: deps.timeoutMs ?? REMOTE_COMMUNITY_TIMEOUT_MS,
			});

			if (answer.status === 200) {
				const view = viewOf(answer.body);

				if (!view) return unavailable(host.managingApp);

				remember(key, view);

				return { kind: "view", view };
			}

			cache.delete(key);

			const error = errorOf(answer.body);

			if (error === "CommunityNotFound") return { kind: "gone" };

			if (error === "NotManagingApp") await deps.hosts.forget(row.community);

			return unavailable(host.managingApp);
		} catch {
			return unavailable(host.managingApp);
		}
	};

	return {
		fetch: (callerDid: string, rows: readonly RemoteSpaceRow[]) => {
			return Promise.all(rows.map((row) => fetchOne(callerDid, row)));
		},
	};
};

export type RemoteCommunities = ReturnType<typeof createRemoteCommunities>;
