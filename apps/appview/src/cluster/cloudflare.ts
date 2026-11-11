import type { Logger } from "../logger.js";
import type { NodeRow } from "./registry.js";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export const RECORD_COMMENT_PREFIX = "colibri node";

export const ALIAS_COMMENT_PREFIX = "colibri status";

export const POOL_PREFIX = "colibri-";

export const MONITOR_DESCRIPTION = "colibri /health";

// As of 11. Nov, 2026
export const CLOUDFLARE_REGIONS: ReadonlySet<string> = new Set([
	"WNAM",
	"ENAM",
	"WEU",
	"EEU",
	"NSAM",
	"SSAM",
	"OC",
	"ME",
	"NAF",
	"SAF",
	"SAS",
	"SEAS",
	"NEAS",
]);

export type GeoRegions = Record<string, string[]>;

export const DEFAULT_GEO_REGIONS: Readonly<GeoRegions> = {
	eu: ["WEU", "EEU", "NAF", "ME", "SAF"],
	europe: ["WEU", "EEU", "NAF", "ME", "SAF"],
	"eu-west": ["WEU", "NAF", "EEU", "ME", "SAF"],
	"eu-central": ["WEU", "EEU", "NAF", "ME", "SAF"],
	"eu-north": ["WEU", "EEU", "NAF", "ME"],
	"eu-east": ["EEU", "ME", "WEU", "NAF"],
	us: ["ENAM", "WNAM", "NSAM", "SSAM"],
	na: ["ENAM", "WNAM", "NSAM", "SSAM"],
	"us-east": ["ENAM", "WNAM", "NSAM", "SSAM"],
	"us-central": ["ENAM", "WNAM", "NSAM", "SSAM"],
	"us-west": ["WNAM", "ENAM", "NSAM", "SSAM"],
	ca: ["ENAM", "WNAM", "NSAM"],
	sa: ["NSAM", "SSAM"],
	latam: ["NSAM", "SSAM"],
	br: ["SSAM", "NSAM"],
	asia: ["NEAS", "SEAS", "SAS", "OC"],
	"asia-east": ["NEAS", "SEAS", "SAS", "OC"],
	"asia-northeast": ["NEAS", "SEAS", "SAS", "OC"],
	"asia-southeast": ["SEAS", "SAS", "OC", "NEAS"],
	"asia-south": ["SAS", "SEAS", "ME", "NEAS", "OC"],
	jp: ["NEAS", "SEAS", "SAS", "OC"],
	kr: ["NEAS", "SEAS", "SAS", "OC"],
	sg: ["SEAS", "SAS", "OC", "NEAS"],
	in: ["SAS", "SEAS", "ME", "NEAS", "OC"],
	oc: ["OC", "SEAS", "NEAS", "SAS"],
	oceania: ["OC", "SEAS", "NEAS", "SAS"],
	au: ["OC", "SEAS", "NEAS", "SAS"],
	me: ["ME", "EEU", "SAS"],
	af: ["SAF", "NAF"],
	africa: ["SAF", "NAF"],
};

export const geoCodes = (region: string, overrides: GeoRegions): string[] => {
	const custom = overrides[region];

	if (custom) {
		return custom;
	}

	const known = DEFAULT_GEO_REGIONS[region.toLowerCase()];

	if (known) {
		return known;
	}

	const code = region.toUpperCase();

	return CLOUDFLARE_REGIONS.has(code) ? [code] : [];
};

export const regionPoolsFor = (
	pools: ReadonlyMap<string, string>,
	overrides: GeoRegions,
	mainRegion: string,
): Record<string, string[]> => {
	const ranked = new Map<string, { id: string; rank: number; region: string }[]>();

	for (const [region, id] of pools) {
		geoCodes(region, overrides).forEach((code, rank) => {
			ranked.set(code, [...(ranked.get(code) ?? []), { id, rank, region }]);
		});
	}

	const result: Record<string, string[]> = {};

	for (const [code, entries] of ranked) {
		result[code] = entries
			.sort(
				(a, b) =>
					a.rank - b.rank ||
					Number(b.region === mainRegion) - Number(a.region === mainRegion) ||
					a.region.localeCompare(b.region),
			)
			.map((entry) => entry.id);
	}

	return result;
};

export type CloudflareOptions = {
	token: string;
	accountId?: string | undefined;
	zoneId: string;
	loadBalancerId?: string | undefined;
	geo: GeoRegions;
	mainRegion: string;
	log: Pick<Logger, "info" | "warn">;
	fetch?: typeof fetch;
};

export type Cloudflare = {
	readonly managesPools: boolean;
	putNodeRecord: (node: string, host: string, ip: string) => Promise<void>;
	removeNodeRecord: (host: string) => Promise<boolean>;
	putAlias: (host: string, target: string) => Promise<void>;
	syncPools: (nodes: readonly NodeRow[]) => Promise<void>;
};

type Envelope<T> = {
	success: boolean;
	errors?: { code?: number; message?: string }[];
	result: T;
};

type DnsRecord = {
	id: string;
	name: string;
	type: string;
	content: string;
	proxied?: boolean;
	comment?: string | null;
};

type Origin = {
	name: string;
	address: string;
	enabled: boolean;
	weight?: number;
	header?: { Host?: string[] };
};

type Pool = {
	id: string;
	name: string;
	origins: Origin[];
	monitor?: string | null;
};

type Monitor = {
	id: string;
	description?: string;
};

type LoadBalancer = {
	id: string;
	name: string;
	default_pools: string[];
	fallback_pool: string;
	region_pools?: Record<string, string[]>;
	steering_policy?: string;
};

export const parseGeoRegions = (value: string | undefined): GeoRegions => {
	const geo: GeoRegions = {};

	for (const entry of (value ?? "").split(";")) {
		const trimmed = entry.trim();

		if (trimmed === "") continue;

		const [region, codes] = trimmed.split("=");

		if (!region?.trim() || !codes) {
			throw new Error(`"${trimmed}" in CLOUDFLARE_GEO_REGIONS needs the form region=CODE,CODE`);
		}

		const list = codes
			.split(",")
			.map((code) => code.trim().toUpperCase())
			.filter((code) => code !== "");

		for (const code of list) {
			if (!CLOUDFLARE_REGIONS.has(code)) {
				throw new Error(`${code} in CLOUDFLARE_GEO_REGIONS is not a Cloudflare region`);
			}
		}

		geo[region.trim()] = list;
	}

	return geo;
};

export const poolName = (region: string): string => {
	return `${POOL_PREFIX}${region}`;
};

const hostOf = (url: string): string => {
	return new URL(url).hostname;
};

export const desiredOrigins = (
	nodes: readonly NodeRow[],
	loadBalancerHost: string,
): Map<string, Origin[]> => {
	const regions = new Map<string, Origin[]>();

	for (const node of nodes) {
		if (!node.roles.includes("api") || node.state === "retired") continue;

		const host = hostOf(node.publicUrl);

		if (host === loadBalancerHost) continue;

		const origins = regions.get(node.region) ?? [];

		origins.push({
			name: node.id,
			address: host,
			enabled: node.state === "active",
			weight: 1,
			header: { Host: [host] },
		});
		regions.set(node.region, origins);
	}

	for (const origins of regions.values()) {
		origins.sort((a, b) => a.name.localeCompare(b.name));
	}

	return regions;
};

const originKey = (origins: readonly Origin[]): string => {
	return JSON.stringify(
		[...origins]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((origin) => [origin.name, origin.address, origin.enabled, origin.header?.Host ?? []]),
	);
};

const sameList = (a: readonly string[] | undefined, b: readonly string[]): boolean => {
	return JSON.stringify(a ?? []) === JSON.stringify(b);
};

const sameRegionPools = (
	a: Record<string, string[]> | undefined,
	b: Record<string, string[]>,
): boolean => {
	const left = a ?? {};
	const keys = new Set([...Object.keys(left), ...Object.keys(b)]);

	for (const key of keys) {
		if (!sameList(left[key], b[key] ?? [])) return false;
	}

	return true;
};

export const createCloudflare = (options: CloudflareOptions): Cloudflare => {
	const request = options.fetch ?? fetch;
	const { accountId, loadBalancerId } = options;
	const unmapped = new Set<string>();

	const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		const response = await request(`${CLOUDFLARE_API}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${options.token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(15_000),
		});

		const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;

		if (!response.ok || !envelope?.success) {
			const detail = envelope?.errors?.map((error) => error.message).join(", ");

			throw new Error(
				`Cloudflare answered ${response.status} to ${method} ${path}${detail ? `: ${detail}` : ""}`,
			);
		}

		return envelope.result;
	};

	const records = (host: string, type = "A") => {
		return api<DnsRecord[]>(
			"GET",
			`/zones/${options.zoneId}/dns_records?type=${type}&name=${encodeURIComponent(host)}`,
		);
	};

	const ours = (record: DnsRecord): boolean => {
		return (record.comment ?? "").startsWith(RECORD_COMMENT_PREFIX);
	};

	const putRecord = async (
		host: string,
		body: Record<string, unknown>,
		managed: (record: DnsRecord) => boolean,
	): Promise<void> => {
		const existing = [...(await records(host, "A")), ...(await records(host, "CNAME"))];

		if (existing.some((record) => !managed(record))) {
			throw new Error(`${host} already has a DNS record that Colibri doesn't manage`);
		}

		const [current, ...extra] = existing.filter((record) => record.type === body.type);

		if (current) {
			await api<DnsRecord>("PATCH", `/zones/${options.zoneId}/dns_records/${current.id}`, body);
		} else {
			await api<DnsRecord>("POST", `/zones/${options.zoneId}/dns_records`, body);
		}

		for (const record of [...extra, ...existing.filter((record) => record.type !== body.type)]) {
			await api<unknown>("DELETE", `/zones/${options.zoneId}/dns_records/${record.id}`);
		}
	};

	const monitorId = async (): Promise<string> => {
		const monitors = await api<Monitor[]>("GET", `/accounts/${accountId}/load_balancers/monitors`);
		const existing = monitors.find((monitor) => monitor.description === MONITOR_DESCRIPTION);

		if (existing) {
			return existing.id;
		}

		const created = await api<Monitor>("POST", `/accounts/${accountId}/load_balancers/monitors`, {
			type: "https",
			method: "GET",
			path: "/health",
			expected_codes: "200",
			interval: 60,
			timeout: 5,
			retries: 2,
			follow_redirects: false,
			allow_insecure: false,
			description: MONITOR_DESCRIPTION,
		});

		options.log.info({ monitor: created.id }, "cloudflare.monitorCreated");

		return created.id;
	};

	const syncPools = async (nodes: readonly NodeRow[]): Promise<void> => {
		if (!accountId || !loadBalancerId) {
			return;
		}

		const lbPath = `/zones/${options.zoneId}/load_balancers/${loadBalancerId}`;
		const balancer = await api<LoadBalancer>("GET", lbPath);
		const wanted = desiredOrigins(nodes, balancer.name);

		if (wanted.size === 0) {
			options.log.warn({ loadBalancer: balancer.name }, "cloudflare.noApiNodes");

			return;
		}

		const pools = (await api<Pool[]>("GET", `/accounts/${accountId}/load_balancers/pools`)).filter(
			(pool) => pool.name.startsWith(POOL_PREFIX),
		);

		const monitor = await monitorId();
		const poolIds = new Map<string, string>();

		for (const [region, origins] of wanted) {
			const name = poolName(region);
			const existing = pools.find((pool) => pool.name === name);

			if (!existing) {
				const created = await api<Pool>("POST", `/accounts/${accountId}/load_balancers/pools`, {
					name,
					description: `Colibri nodes in ${region}`,
					enabled: true,
					monitor,
					origins,
				});

				options.log.info({ pool: name, origins: origins.length }, "cloudflare.poolCreated");
				poolIds.set(region, created.id);
				continue;
			}

			poolIds.set(region, existing.id);

			if (originKey(existing.origins) !== originKey(origins) || existing.monitor !== monitor) {
				await api<Pool>("PATCH", `/accounts/${accountId}/load_balancers/pools/${existing.id}`, {
					origins,
					monitor,
				});
				options.log.info({ pool: name, origins: origins.length }, "cloudflare.poolUpdated");
			}
		}

		const regions = [...poolIds.keys()].sort((a, b) =>
			a === options.mainRegion ? -1 : b === options.mainRegion ? 1 : a.localeCompare(b),
		);
		const defaultPools = regions.flatMap((region) => poolIds.get(region) ?? []);
		const fallback = defaultPools[0] ?? balancer.fallback_pool;
		const regionPools = regionPoolsFor(poolIds, options.geo, options.mainRegion);

		for (const region of regions) {
			if (geoCodes(region, options.geo).length === 0 && !unmapped.has(region)) {
				unmapped.add(region);
				options.log.warn({ region }, "cloudflare.regionUnmapped");
			}
		}

		if (
			!sameList(balancer.default_pools, defaultPools) ||
			balancer.fallback_pool !== fallback ||
			!sameRegionPools(balancer.region_pools, regionPools) ||
			balancer.steering_policy !== "geo"
		) {
			await api<LoadBalancer>("PATCH", lbPath, {
				default_pools: defaultPools,
				fallback_pool: fallback,
				region_pools: regionPools,
				steering_policy: "geo",
			});
			options.log.info(
				{ loadBalancer: balancer.name, pools: regions.map(poolName) },
				"cloudflare.loadBalancerUpdated",
			);
		}

		for (const pool of pools) {
			if (defaultPools.includes(pool.id)) continue;

			await api<unknown>("DELETE", `/accounts/${accountId}/load_balancers/pools/${pool.id}`);
			options.log.info({ pool: pool.name }, "cloudflare.poolRemoved");
		}
	};

	return {
		managesPools: Boolean(accountId && loadBalancerId),
		putNodeRecord: async (node, host, ip) => {
			await putRecord(
				host,
				{
					type: "A",
					name: host,
					content: ip,
					proxied: false,
					ttl: 60,
					comment: `${RECORD_COMMENT_PREFIX} ${node}`,
				},
				ours,
			);
			options.log.info({ node, host, ip }, "cloudflare.recordSet");
		},
		putAlias: async (host, target) => {
			await putRecord(
				host,
				{
					type: "CNAME",
					name: host,
					content: target,
					proxied: false,
					ttl: 60,
					comment: ALIAS_COMMENT_PREFIX,
				},
				(record) => (record.comment ?? "").startsWith(ALIAS_COMMENT_PREFIX),
			);
			options.log.info({ host, target }, "cloudflare.aliasSet");
		},
		removeNodeRecord: async (host) => {
			const existing = (await records(host)).filter(ours);

			for (const record of existing) {
				await api<unknown>("DELETE", `/zones/${options.zoneId}/dns_records/${record.id}`);
			}

			if (existing.length > 0) {
				options.log.info({ host }, "cloudflare.recordRemoved");
			}

			return existing.length > 0;
		},
		syncPools,
	};
};
