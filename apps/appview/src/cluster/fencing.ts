import {
	formatPostgresUrl,
	type HostProbe,
	hostUrls,
	parsePostgresUrl,
	pickPrimary,
	probeHost,
} from "@colibri-social/appview-db";
import type { Logger } from "../logger.js";
import { fenceHost } from "./failover.js";
import type { NodeRow } from "./registry.js";

export const FENCE_CHECK_MS = 15_000;

export const REJOIN_COOLDOWN_MS = 30 * 60_000;

export type FencingDeps = {
	nodeId: string;
	localUrl: string;
	databaseUrl: string;
	ownTailnetHost: string;
	isMain: () => boolean;
	nodes: () => Promise<NodeRow[]>;
	rejoin?: (node: NodeRow | null, primaryHosts: string[]) => Promise<boolean>;
	probe?: (url: string) => Promise<HostProbe>;
	fence?: (url: string) => Promise<void>;
	log: Pick<Logger, "info" | "warn" | "error">;
	now?: () => number;
};

export type FenceOutcome = "healthy" | "fenced" | "rejoining" | "waiting";

export const hostOf = (url: string): string => {
	return parsePostgresUrl(url).hosts[0]?.host ?? "";
};

export const stale = (local: HostProbe, primary: HostProbe | null): boolean => {
	return local.reachable && !local.recovery && primary !== null && primary.epoch > local.epoch;
};

export const nodeDatabaseUrl = (databaseUrl: string, node: NodeRow): string => {
	const parts = parsePostgresUrl(databaseUrl);

	return formatPostgresUrl({
		...parts,
		hosts: [{ host: new URL(node.tailnetUrl).hostname, port: 5432 }],
	});
};

export const createFencing = (deps: FencingDeps) => {
	const now = deps.now ?? Date.now;
	const probe = deps.probe ?? probeHost;
	const fence = deps.fence ?? fenceHost;
	const rejoinedAt = new Map<string, number>();
	const localHost = hostOf(deps.localUrl);
	const remoteHosts = parsePostgresUrl(deps.databaseUrl)
		.hosts.map((entry) => entry.host)
		.filter((host) => host !== localHost);

	const due = (key: string): boolean => {
		const last = rejoinedAt.get(key);

		return last === undefined || now() - last >= REJOIN_COOLDOWN_MS;
	};

	const primaryOf = async (): Promise<HostProbe | null> => {
		return pickPrimary(await Promise.all(hostUrls(deps.databaseUrl).map((url) => probe(url))));
	};

	const checkSelf = async (primary: HostProbe | null): Promise<FenceOutcome> => {
		const local = await probe(deps.localUrl);

		if (!stale(local, primary)) {
			return "healthy";
		}

		if (!local.readOnly) {
			await fence(deps.localUrl);
			deps.log.warn({ localEpoch: local.epoch, primaryEpoch: primary?.epoch }, "failover.fenced");
		}

		if (!deps.rejoin || !due(deps.nodeId)) {
			return "fenced";
		}

		rejoinedAt.set(deps.nodeId, now());
		deps.log.warn({ primaryHosts: remoteHosts }, "failover.rejoiningSelf");

		return (await deps.rejoin(null, remoteHosts)) ? "rejoining" : "fenced";
	};

	const sweep = async (primary: HostProbe | null): Promise<void> => {
		if (!deps.isMain() || !deps.rejoin || !primary) {
			return;
		}

		const capable = (await deps.nodes()).filter(
			(node) =>
				node.id !== deps.nodeId &&
				node.state !== "retired" &&
				(node.roles.includes("main") || node.roles.includes("failover")),
		);

		for (const node of capable) {
			const url = nodeDatabaseUrl(deps.databaseUrl, node);
			const remote = await probe(url);

			if (!stale(remote, primary) || !due(node.id)) continue;

			if (!remote.readOnly) await fence(url).catch(() => undefined);

			rejoinedAt.set(node.id, now());
			deps.log.warn({ node: node.id }, "failover.rejoiningNode");

			const hosts = parsePostgresUrl(deps.databaseUrl).hosts.map((entry) =>
				entry.host === localHost ? deps.ownTailnetHost : entry.host,
			);

			await deps.rejoin(
				node,
				hosts.filter((host) => host !== new URL(node.tailnetUrl).hostname),
			);
		}
	};

	return {
		tick: async (): Promise<FenceOutcome> => {
			const primary = await primaryOf();
			const outcome = await checkSelf(primary);

			await sweep(primary).catch((error: unknown) => {
				deps.log.warn({ err: error }, "failover.sweepFailed");
			});

			return primary ? outcome : "waiting";
		},
	};
};
