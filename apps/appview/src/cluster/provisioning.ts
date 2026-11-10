import type { NodeRole } from "@colibri-social/appview-db";
import type { Config } from "../config.js";

export const DEFAULT_RTC_WORKERS = 4;

export type ProvisionTarget = {
	node: string;
	region: string;
	roles: NodeRole[];
	publicUrl: string;
	joinToken?: string;
	workers?: number;
};

export type MainAddress = {
	tailnetUrl: string;
};

export const hostOf = (url: string): string => {
	return new URL(url).hostname;
};

export const needsPostgres = (roles: readonly NodeRole[]): boolean => {
	return roles.includes("failover") || roles.includes("api") || roles.includes("live");
};

export const databaseParts = (url: string) => {
	const parsed = new URL(url);

	return {
		db_user: decodeURIComponent(parsed.username),
		db_password: decodeURIComponent(parsed.password),
		db_name: parsed.pathname.replace(/^\//, "") || "colibri",
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
	>,
	main: MainAddress,
	target: ProvisionTarget,
): Record<string, unknown> => {
	return {
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
