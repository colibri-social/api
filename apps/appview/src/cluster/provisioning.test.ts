import { describe, expect, it } from "vitest";
import {
	databaseHostRuns,
	databaseHosts,
	databaseParts,
	missingForProvisioning,
	needsPostgres,
	provisionVars,
} from "./provisioning.js";
import type { NodeRow } from "./registry.js";

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
	POSTGRES_IMAGE: "ghcr.io/colibri-social/postgres:18",
	BACKUP_REPO_HOST: undefined,
	BACKUP_REPO_PORT: 23,
	BACKUP_REPO_USER: undefined,
	BACKUP_REPO_PATH: "/colibri",
	BACKUP_CIPHER_PASS: undefined,
};

describe("provisionVars", () => {
	it("gives only the failover node the backup settings and keys", () => {
		const withBackups = {
			...config,
			BACKUP_REPO_HOST: "u1.your-storagebox.de",
			BACKUP_REPO_USER: "u1",
			BACKUP_CIPHER_PASS: "secret",
		};
		const keys = { key: "PRIVATE", publicKey: "PUBLIC" };
		const target = (roles: ("failover" | "api" | "live")[]) => ({
			node: "fsn-1",
			region: "eu",
			roles,
			publicUrl: "https://fsn-1.nodes.colibri.social",
		});

		expect(
			provisionVars(
				withBackups,
				{ tailnetUrl: "http://hel-1:3100" },
				target(["failover", "api"]),
				keys,
			),
		).toMatchObject({
			backup_repo_host: "u1.your-storagebox.de",
			backup_repo_port: 23,
			backup_repo_user: "u1",
			backup_repo_path: "/colibri",
			backup_cipher_pass: "secret",
			backup_key: "PRIVATE",
			backup_public_key: "PUBLIC",
		});
		expect(
			provisionVars(
				withBackups,
				{ tailnetUrl: "http://hel-1:3100" },
				target(["api", "live"]),
				keys,
			),
		).not.toHaveProperty("backup_repo_host");
		expect(
			provisionVars(withBackups, { tailnetUrl: "http://hel-1:3100" }, target(["failover"]), null),
		).not.toHaveProperty("backup_repo_host");
	});

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
			postgres_image: "ghcr.io/colibri-social/postgres:18",
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
			db_hosts: ["hel-1"],
			primary_hosts: ["hel-1"],
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

describe("database hosts", () => {
	const row = (id: string, roles: NodeRow["roles"]): NodeRow => {
		return {
			id,
			region: "eu",
			roles,
			publicUrl: `https://${id}.test`,
			tailnetUrl: `http://${id}:3100`,
			version: "1",
			state: "active",
			connections: 0,
			activeCalls: 0,
			heartbeatAt: null,
			drainDeadline: null,
		};
	};

	it("lists every host that can be primary, with the failover node's own database last", () => {
		const main = { tailnetUrl: "http://hel-1:3100", standbyHosts: ["fsn-2"] };

		expect(databaseHosts(main, ["api"])).toEqual({
			dbHosts: ["hel-1", "fsn-2"],
			primaryHosts: ["hel-1", "fsn-2"],
		});
		expect(databaseHosts(main, ["failover", "api"])).toEqual({
			dbHosts: ["hel-1", "fsn-2", "postgres"],
			primaryHosts: ["hel-1", "fsn-2"],
		});
	});

	it("reads the credentials from a multi-host URL", () => {
		expect(databaseParts("postgres://col:p%40ss@hel-1:5432,fsn-1:5432/colibri")).toEqual({
			db_user: "col",
			db_password: "p@ss",
			db_name: "colibri",
		});
	});

	it("points every node at all primary hosts when a failover node joins", () => {
		const runs = databaseHostRuns(
			{
				DATABASE_URL: "postgres://col:pw@postgres:5432/colibri",
				POSTGRES_REPLICATION_PASSWORD: "repl",
				STACK_DIR: "/srv/colibri",
			},
			[
				row("hel-1", ["main", "api"]),
				row("fsn-1", ["failover", "api"]),
				row("eu-2", ["api"]),
				row("voice-1", ["voice"]),
			],
			"hel-1",
		);
		const byNode = Object.fromEntries(runs.map((run) => [run.node, run.vars]));

		expect(byNode["hel-1"]).toMatchObject({
			stack_dir: "/srv/colibri",
			postgres: true,
			database_url: "postgres://col:pw@fsn-1:5432,postgres:5432/colibri",
			primary_hosts: "fsn-1",
		});
		expect(byNode["fsn-1"]).toMatchObject({
			database_url: "postgres://col:pw@hel-1:5432,postgres:5432/colibri",
			primary_hosts: "hel-1",
		});
		expect(byNode["eu-2"]).toMatchObject({
			postgres: true,
			database_url: "postgres://col:pw@hel-1:5432,fsn-1:5432/colibri",
			primary_hosts: "hel-1,fsn-1",
			primary_conninfo:
				"host=hel-1,fsn-1 port=5432,5432 user=replicator password=repl target_session_attrs=read-write connect_timeout=5",
		});
		expect(byNode["voice-1"]).toMatchObject({ postgres: false });
	});
});
