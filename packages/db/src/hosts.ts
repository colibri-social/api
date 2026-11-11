import pg from "pg";

export const PROBE_TIMEOUT_MS = 3_000;

export type PostgresHost = {
	host: string;
	port: number;
};

export type PostgresUrl = {
	user: string;
	password: string;
	database: string;
	hosts: PostgresHost[];
	query: string;
};

export type HostProbe = {
	url: string;
	reachable: boolean;
	recovery: boolean;
	readOnly: boolean;
	epoch: number;
};

const URL_PATTERN =
	/^(postgres(?:ql)?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?]*)(?:\/([^?]*))?(\?.*)?$/;

export const parsePostgresUrl = (url: string): PostgresUrl => {
	const match = URL_PATTERN.exec(url);

	if (!match) {
		throw new Error("DATABASE_URL isn't a postgres:// URL");
	}

	const [, , user = "", password = "", hostList = "", database = "", query = ""] = match;
	const hosts = hostList
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")
		.map((entry) => {
			const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);

			if (bracketed) {
				return { host: bracketed[1] ?? "", port: Number(bracketed[2] ?? 5432) };
			}

			const [host = "", port] = entry.split(":");

			return { host, port: Number(port ?? 5432) };
		});

	if (hosts.length === 0) {
		throw new Error("DATABASE_URL names no host");
	}

	return {
		user: decodeURIComponent(user),
		password: decodeURIComponent(password),
		database: decodeURIComponent(database) || "postgres",
		hosts,
		query,
	};
};

export const formatPostgresUrl = (parts: PostgresUrl): string => {
	const auth = parts.user
		? `${encodeURIComponent(parts.user)}${parts.password ? `:${encodeURIComponent(parts.password)}` : ""}@`
		: "";
	const hosts = parts.hosts
		.map((entry) => `${entry.host.includes(":") ? `[${entry.host}]` : entry.host}:${entry.port}`)
		.join(",");

	return `postgres://${auth}${hosts}/${encodeURIComponent(parts.database)}${parts.query}`;
};

export const hostUrls = (url: string): string[] => {
	const parts = parsePostgresUrl(url);

	return parts.hosts.map((entry) => formatPostgresUrl({ ...parts, hosts: [entry] }));
};

export const isMultiHost = (url: string): boolean => {
	return /^postgres(ql)?:\/\//.test(url) && parsePostgresUrl(url).hosts.length > 1;
};

export const probeHost = async (url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<HostProbe> => {
	const client = new pg.Client({
		connectionString: url,
		connectionTimeoutMillis: timeoutMs,
		query_timeout: timeoutMs,
	});

	client.on("error", () => {});

	try {
		await client.connect();

		const status = await client.query<{ recovery: boolean; read_only: string }>(
			"select pg_is_in_recovery() as recovery, current_setting('default_transaction_read_only') as read_only",
		);
		const epoch = await client
			.query<{ epoch: number }>("select epoch from cluster_state where id = 'cluster'")
			.then((result) => Number(result.rows[0]?.epoch ?? 0))
			.catch(() => 0);
		const row = status.rows[0];

		return {
			url,
			reachable: true,
			recovery: row?.recovery ?? true,
			readOnly: row?.read_only === "on",
			epoch,
		};
	} catch {
		return { url, reachable: false, recovery: false, readOnly: false, epoch: 0 };
	} finally {
		await client.end().catch(() => {});
	}
};

export const writable = (probe: HostProbe): boolean => {
	return probe.reachable && !probe.recovery && !probe.readOnly;
};

export const pickPrimary = (probes: readonly HostProbe[]): HostProbe | null => {
	const candidates = probes.filter(writable);

	if (candidates.length === 0) {
		return null;
	}

	return candidates.reduce((best, probe) => (probe.epoch > best.epoch ? probe : best));
};

export const resolvePrimaryUrl = async (
	url: string,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string> => {
	if (!isMultiHost(url)) {
		return url;
	}

	const primary = pickPrimary(
		await Promise.all(hostUrls(url).map((one) => probeHost(one, timeoutMs))),
	);

	if (!primary) {
		throw new Error("no host in DATABASE_URL accepts writes");
	}

	return primary.url;
};
