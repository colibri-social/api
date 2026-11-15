export const LIST_NODES_NSID = "social.colibri.beta.server.listNodes";

export const NODE_PROBE_TIMEOUT_MS = 3_000;

export const NODE_REFRESH_MS = 10 * 60_000;

const PROBE_ROUNDS = 2;

export type NodeRole = "main" | "failover" | "api" | "live" | "voice";

export type NetworkNode = {
	id: string;
	region: string;
	roles: string[];
	endpoint: string;
	rttMs: number;
};

export type NodeDirectoryOptions = {
	appviewUrl: string;
	fetch?: typeof fetch;
	now?: () => number;
	refreshMs?: number;
	probeTimeoutMs?: number;
};

type ListedNode = Omit<NetworkNode, "rttMs"> & { probeUrl: string };

const originOf = (url: string): string => {
	return new URL(url).origin;
};

const parseNodes = (body: unknown): ListedNode[] => {
	const list = (body as { nodes?: unknown } | null)?.nodes;

	if (!Array.isArray(list)) {
		return [];
	}

	return list.flatMap((entry) => {
		const node = entry as Record<string, unknown>;

		if (
			typeof node.id !== "string" ||
			typeof node.endpoint !== "string" ||
			typeof node.probeUrl !== "string" ||
			!Array.isArray(node.roles)
		) {
			return [];
		}

		try {
			return [
				{
					id: node.id,
					region: typeof node.region === "string" ? node.region : "",
					roles: node.roles.filter((role): role is string => typeof role === "string"),
					endpoint: originOf(node.endpoint),
					probeUrl: new URL(node.probeUrl).toString(),
				},
			];
		} catch {
			return [];
		}
	});
};

export class NodeDirectory {
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private known: NetworkNode[] = [];
	private refreshedAt = Number.NEGATIVE_INFINITY;
	private refreshing: Promise<void> | null = null;

	constructor(private readonly options: NodeDirectoryOptions) {
		this.fetcher = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
	}

	get nodes(): readonly NetworkNode[] {
		return this.known;
	}

	refresh(): Promise<void> {
		this.refreshing ??= this.load().finally(() => {
			this.refreshing = null;
		});

		return this.refreshing;
	}

	refreshIfStale(): Promise<void> {
		const stale = this.now() - this.refreshedAt >= (this.options.refreshMs ?? NODE_REFRESH_MS);

		return stale ? this.refresh() : Promise.resolve();
	}

	endpointFor(role: NodeRole, avoid?: ReadonlySet<string>): string | null {
		const pick = this.known.find((node) => node.roles.includes(role) && !avoid?.has(node.endpoint));

		return pick?.endpoint ?? null;
	}

	private async load(): Promise<void> {
		const timeoutMs = this.options.probeTimeoutMs ?? NODE_PROBE_TIMEOUT_MS;

		try {
			const response = await this.fetcher(
				new URL(`/xrpc/${LIST_NODES_NSID}`, this.options.appviewUrl),
				{ signal: AbortSignal.timeout(timeoutMs * 2) },
			);

			if (!response.ok) {
				this.known = [];

				return;
			}

			const listed = parseNodes(await response.json());
			const measured = await Promise.all(
				listed.map(async ({ probeUrl, ...node }) => ({
					...node,
					rttMs: await this.probe(probeUrl, timeoutMs),
				})),
			);

			this.known = measured
				.filter((node): node is NetworkNode => node.rttMs !== null)
				.sort((a, b) => a.rttMs - b.rttMs || a.id.localeCompare(b.id));
		} catch {
			this.known = [];
		} finally {
			this.refreshedAt = this.now();
		}
	}

	private async probe(url: string, timeoutMs: number): Promise<number | null> {
		let best: number | null = null;

		for (let round = 0; round < PROBE_ROUNDS; round += 1) {
			const started = this.now();

			try {
				const response = await this.fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });

				await response.body?.cancel();

				if (!response.ok) {
					return null;
				}
			} catch {
				return null;
			}

			const elapsed = this.now() - started;

			best = best === null ? elapsed : Math.min(best, elapsed);
		}

		return best;
	}
}
