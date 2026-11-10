import { describe, expect, it } from "vitest";
import { missingForProvisioning, needsPostgres, provisionVars } from "./provisioning.js";

const config = {
	DATABASE_URL: "postgres://colibri:p%40ss@postgres:5432/colibri",
	CLUSTER_PORT: 3100,
	SFU_RTC_PORT: 40000,
	DRAIN_GRACE_MINUTES: 120,
	NODE_IMAGE: "ghcr.io/colibri-social/api:stable",
	TAILSCALE_AUTH_KEY: "tskey-auth-x",
	POSTGRES_REPLICATION_PASSWORD: "repl",
	REGISTRY_USER: undefined,
	REGISTRY_TOKEN: undefined,
};

describe("provisionVars", () => {
	it("describes the node and points it at the main node's database over the tailnet", () => {
		expect(
			provisionVars(
				config,
				{ tailnetUrl: "http://hel-1:3100" },
				{
					node: "eu-2",
					region: "eu",
					roles: ["api", "live", "voice"],
					publicUrl: "https://eu-2.nodes.colibri.social",
					joinToken: "token",
				},
			),
		).toEqual({
			node_id: "eu-2",
			node_region: "eu",
			node_roles: ["api", "live", "voice"],
			public_url: "https://eu-2.nodes.colibri.social",
			public_host: "eu-2.nodes.colibri.social",
			image: "ghcr.io/colibri-social/api:stable",
			main_tailnet_url: "http://hel-1:3100",
			cluster_port: 3100,
			rtc_port: 40000,
			rtc_workers: 4,
			drain_minutes: 120,
			postgres: true,
			primary_host: "hel-1",
			replication_password: "repl",
			tailscale_auth_key: "tskey-auth-x",
			db_user: "colibri",
			db_password: "p@ss",
			db_name: "colibri",
			join_token: "token",
		});
	});
});

describe("needsPostgres", () => {
	it("gives sub nodes and the failover node a replica and voice nodes none", () => {
		expect(needsPostgres(["api"])).toBe(true);
		expect(needsPostgres(["failover", "voice"])).toBe(true);
		expect(needsPostgres(["voice"])).toBe(false);
	});
});

describe("missingForProvisioning", () => {
	it("names what the main node lacks", () => {
		expect(
			missingForProvisioning(
				{
					DATABASE_URL: "file:./x.db",
					TAILSCALE_AUTH_KEY: undefined,
					POSTGRES_REPLICATION_PASSWORD: undefined,
				},
				["api"],
			),
		).toEqual(["TAILSCALE_AUTH_KEY", "POSTGRES_REPLICATION_PASSWORD", "DATABASE_URL (Postgres)"]);
		expect(missingForProvisioning(config, ["voice"])).toEqual([]);
	});
});
