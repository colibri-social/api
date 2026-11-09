import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClusterEnv } from "./boot.js";
import { ControlServer } from "./control-server.js";
import { createRegistry, type Registry } from "./registry.js";

const log = { info: vi.fn(), warn: vi.fn() };

let database: TestDatabase;
let registry: Registry;
let directory: string;
const servers: ControlServer[] = [];

const startServer = async (nodeId: string, isMain: boolean) => {
	const server = new ControlServer({
		registry,
		log,
		nodeId,
		isMain: () => isMain,
		config: async () => ({ PDS_URL: "https://pds.test", SIGNING_KEY: "shared" }),
	});
	const port = await server.listen(0, "127.0.0.1");

	servers.push(server);

	return `http://127.0.0.1:${port}`;
};

beforeEach(async () => {
	database = await openTestDatabase();
	registry = createRegistry(database);
	directory = mkdtempSync(join(tmpdir(), "colibri-boot-"));
});

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await database.destroy();
	rmSync(directory, { recursive: true, force: true });
});

describe("resolveClusterEnv", () => {
	it("leaves a node without MAIN_NODE_URL alone", async () => {
		const env = { PDS_URL: "https://local.test" };

		expect(await resolveClusterEnv(env)).toBe(env);
	});

	it("joins, then takes the shared settings and its identity from the main node", async () => {
		const mainUrl = await startServer("eu-1", true);
		const token = await registry.createJoinToken({
			id: "eu-2",
			region: "eu",
			roles: ["api", "live"],
		});

		const env = await resolveClusterEnv({
			MAIN_NODE_URL: mainUrl,
			CLUSTER_JOIN_TOKEN: token,
			NODE_PUBLIC_URL: "https://eu-2.nodes.colibri.social",
			NODE_SECRET_FILE: join(directory, "node-secret"),
			SIGNING_KEY: "local",
		});

		expect(env).toMatchObject({
			PDS_URL: "https://pds.test",
			SIGNING_KEY: "local",
			NODE_ID: "eu-2",
			NODE_REGION: "eu",
			ROLES: "api,live",
		});
	});

	it("follows a former main node to the current one", async () => {
		const mainUrl = await startServer("eu-1", true);
		const formerUrl = await startServer("hel-1", false);
		const token = await registry.createJoinToken({ id: "eu-2", region: "eu", roles: ["api"] });
		const file = join(directory, "node-secret");

		await resolveClusterEnv({
			MAIN_NODE_URL: mainUrl,
			CLUSTER_JOIN_TOKEN: token,
			NODE_PUBLIC_URL: "https://eu-2.test",
			NODE_SECRET_FILE: file,
		});
		await registry.register(
			{ id: "eu-1", region: "eu", roles: ["failover"] },
			{ publicUrl: "https://eu-1.test", tailnetUrl: mainUrl, version: "1" },
		);
		await registry.claimMain("eu-1");

		const env = await resolveClusterEnv({ MAIN_NODE_URL: formerUrl, NODE_SECRET_FILE: file });

		expect(env.NODE_ID).toBe("eu-2");
	});

	it("gives up after its attempts when the main node never answers", async () => {
		await expect(
			resolveClusterEnv(
				{
					MAIN_NODE_URL: "http://127.0.0.1:9",
					CLUSTER_JOIN_TOKEN: "token",
					NODE_PUBLIC_URL: "https://eu-2.test",
					NODE_SECRET_FILE: join(directory, "node-secret"),
				},
				{ attempts: 2, retryMs: 1 },
			),
		).rejects.toThrow();
	});
});
