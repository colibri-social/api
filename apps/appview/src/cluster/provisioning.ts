import type { NodeRole } from "@colibri-social/appview-db";
import { formatPostgresUrl, parsePostgresUrl } from "@colibri-social/appview-db";
import type { Config } from "../config.js";
import type { NodeRow } from "./registry.js";

export const DEFAULT_RTC_WORKERS = 4;

export type ProvisionTarget = {
	node: string;
	region: string;
	roles: NodeRole[];
	publicUrl: string;
	joinToken?: string;
	workers?: number;
};

export type BackupKeys = {
	key: string;
	publicKey: string;
};

export type MainAddress = {
	tailnetUrl: string;
	standbyHosts?: string[];
};

export const hostOf = (url: string): string => {
	return new URL(url).hostname;
};

export const needsPostgres = (roles: readonly NodeRole[]): boolean => {
	return roles.includes("failover") || roles.includes("api") || roles.includes("live");
};

export const databaseParts = (url: string) => {
	const parsed = parsePostgresUrl(url);

	return {
		db_user: parsed.user,
		db_password: parsed.password,
		db_name: parsed.database || "colibri",
	};
};

export const databaseHosts = (
	main: MainAddress,
	roles: readonly NodeRole[],
): { dbHosts: string[]; primaryHosts: string[] } => {
	const primaryHosts = [hostOf(main.tailnetUrl), ...(main.standbyHosts ?? [])];

	return {
		primaryHosts,
		dbHosts: roles.includes("failover") ? [...primaryHosts, "postgres"] : primaryHosts,
	};
};

export const provisionVars = (
	config: Pick<
		Config,
		| "DATABASE_URL"
		| "CLUSTER_PORT"
		| "SFU_RTC_PORT"
		| "DRAIN_GRACE_MINUTES"
		| "NODE_IMAGE"
		| "TAILSCALE_AUTH_KEY"
		| "POSTGRES_REPLICATION_PASSWORD"
		| "REGISTRY_USER"
		| "REGISTRY_TOKEN"
		| "POSTGRES_IMAGE"
		| "BACKUP_REPO_HOST"
		| "BACKUP_REPO_PORT"
		| "BACKUP_REPO_USER"
		| "BACKUP_REPO_PATH"
		| "BACKUP_CIPHER_PASS"
	>,
	main: MainAddress,
	target: ProvisionTarget,
	backupKeys: BackupKeys | null = null,
): Record<string, unknown> => {
	const backups =
		target.roles.includes("failover") &&
		backupKeys !== null &&
		config.BACKUP_REPO_HOST &&
		config.BACKUP_REPO_USER &&
		config.BACKUP_CIPHER_PASS
			? {
					backup_repo_host: config.BACKUP_REPO_HOST,
					backup_repo_port: config.BACKUP_REPO_PORT,
					backup_repo_user: config.BACKUP_REPO_USER,
					backup_repo_path: config.BACKUP_REPO_PATH,
					backup_cipher_pass: config.BACKUP_CIPHER_PASS,
					backup_key: backupKeys.key,
					backup_public_key: backupKeys.publicKey,
				}
			: {};

	return {
		postgres_image: config.POSTGRES_IMAGE,
		...backups,
		node_id: target.node,
		node_region: target.region,
		node_roles: target.roles,
		public_url: target.publicUrl,
		public_host: hostOf(target.publicUrl),
		image: config.NODE_IMAGE,
		main_tailnet_url: main.tailnetUrl,
		cluster_port: config.CLUSTER_PORT,
		rtc_port: config.SFU_RTC_PORT,
		rtc_workers: target.workers ?? DEFAULT_RTC_WORKERS,
		drain_minutes: config.DRAIN_GRACE_MINUTES,
		postgres: needsPostgres(target.roles),
		primary_host: hostOf(main.tailnetUrl),
		db_hosts: databaseHosts(main, target.roles).dbHosts,
		primary_hosts: databaseHosts(main, target.roles).primaryHosts,
		replication_password: config.POSTGRES_REPLICATION_PASSWORD ?? "",
		tailscale_auth_key: config.TAILSCALE_AUTH_KEY ?? "",
		...databaseParts(config.DATABASE_URL),
		...(target.joinToken ? { join_token: target.joinToken } : {}),
		...(config.REGISTRY_TOKEN
			? { registry_user: config.REGISTRY_USER ?? "colibri", registry_token: config.REGISTRY_TOKEN }
			: {}),
	};
};

export const missingForProvisioning = (
	config: Pick<Config, "TAILSCALE_AUTH_KEY" | "POSTGRES_REPLICATION_PASSWORD" | "DATABASE_URL">,
	roles: readonly NodeRole[],
): string[] => {
	const missing: string[] = [];

	if (!config.TAILSCALE_AUTH_KEY) missing.push("TAILSCALE_AUTH_KEY");

	if (needsPostgres(roles) && !config.POSTGRES_REPLICATION_PASSWORD) {
		missing.push("POSTGRES_REPLICATION_PASSWORD");
	}

	if (!config.DATABASE_URL.startsWith("postgres")) missing.push("DATABASE_URL (Postgres)");

	return missing;
};

export type DatabaseHostRun = {
	node: string;
	host: string;
	vars: Record<string, unknown>;
};

export const databaseHostRuns = (
	config: Pick<Config, "DATABASE_URL" | "POSTGRES_REPLICATION_PASSWORD" | "STACK_DIR">,
	nodes: readonly NodeRow[],
	self: string,
): DatabaseHostRun[] => {
	const parts = parsePostgresUrl(config.DATABASE_URL);
	const capable = nodes.filter(
		(node) => node.roles.includes("main") || node.roles.includes("failover"),
	);
	const tailnetHost = (node: NodeRow) => new URL(node.tailnetUrl).hostname;

	return nodes.map((node) => {
		const own = tailnetHost(node);
		const isCapable = capable.some((other) => other.id === node.id);
		const local = node.id === self || isCapable || needsPostgres(node.roles);
		const primaryHosts = capable.map(tailnetHost).filter((host) => host !== own);
		const dbHosts = isCapable ? [...primaryHosts, "postgres"] : primaryHosts;
		const conninfo = [
			`host=${primaryHosts.join(",")}`,
			`port=${primaryHosts.map(() => "5432").join(",")}`,
			"user=replicator",
			`password=${config.POSTGRES_REPLICATION_PASSWORD ?? ""}`,
			"target_session_attrs=read-write",
			"connect_timeout=5",
		].join(" ");

		return {
			node: node.id,
			host: own,
			vars: {
				stack_dir: node.id === self ? config.STACK_DIR : "/opt/colibri",
				postgres: local,
				database_url: formatPostgresUrl({
					...parts,
					hosts: dbHosts.map((host) => ({ host, port: 5432 })),
				}),
				primary_hosts: primaryHosts.join(","),
				primary_conninfo: conninfo.replace(/'/g, "''"),
				db_user: parts.user,
				db_name: parts.database,
			},
		};
	});
};
