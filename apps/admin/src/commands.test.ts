import { createConfigStore, createRegistry, type Registry } from "@colibri-social/appview/cluster";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { SecretBox } from "@colibri-social/community";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Admin,
	configImport,
	dbFailback,
	formatTable,
	monitoringDeploy,
	nodeAdd,
	nodeList,
	nodeRemove,
	nodeShutdown,
	parseGrace,
	parseRoles,
	RefusedError,
	statusDeploy,
	UsageError,
} from "./commands.js";

let database: TestDatabase;
let registry: Registry;
let printed: string[];
let admin: Admin;

const register = (id: string, roles: ("main" | "api")[] = ["api"]) => {
	return registry.register(
		{ id, region: "eu", roles },
		{ publicUrl: `https://${id}.test`, tailnetUrl: `http://${id}:3100`, version: "2.36.0" },
	);
};

beforeEach(async () => {
	database = await openTestDatabase();
	registry = createRegistry(database, () => new Date("2026-11-09T12:00:00Z"));
	printed = [];
	admin = {
		registry,
		config: createConfigStore(database, await SecretBox.fromBase64(SecretBox.generateKeyBase64())),
		sendOrder: vi.fn(async (order) => ({ id: order.id, ok: true, message: "eu-2 is draining" })),
		setRolloutPaused: vi.fn(async () => {}),
		readFile: vi.fn(async () => ""),
		now: () => new Date("2026-11-09T12:00:30Z"),
		print: (line) => printed.push(line),
	};
});

afterEach(async () => {
	await database.destroy();
});

describe("arguments", () => {
	it("reads durations as minutes", () => {
		expect([parseGrace("90s"), parseGrace("15m"), parseGrace("2h"), parseGrace("30")]).toEqual([
			1.5, 15, 120, 30,
		]);
		expect(() => parseGrace("soon")).toThrow(UsageError);
	});

	it("accepts known roles only", () => {
		expect(parseRoles("api, live,voice")).toEqual(["api", "live", "voice"]);
		expect(() => parseRoles("api,db")).toThrow(/unknown role db/);
	});

	it("pads table columns", () => {
		expect(
			formatTable([
				["A", "BB"],
				["CCC", "D"],
			]),
		).toEqual(["A    BB", "CCC  D"]);
	});
});

describe("node commands", () => {
	it("lists nodes and marks the main node", async () => {
		await register("hel-1", ["main"]);
		await register("eu-2");
		await registry.claimMain("hel-1");
		await nodeList(admin);

		expect(printed[0]).toMatch(/^NODE\s+REGION\s+ROLES\s+STATE\s+HEARTBEAT/);
		expect(printed.some((line) => /^hel-1 \*\s+eu\s+main\s+active\s+30s ago/.test(line))).toBe(
			true,
		);
	});

	it("prints a join token with the main node's tailnet URL", async () => {
		await register("hel-1", ["main"]);
		await registry.claimMain("hel-1");
		await nodeAdd(admin, { id: "eu-2", region: "eu", roles: "api,live" });

		expect(printed).toContain("MAIN_NODE_URL=http://hel-1:3100");

		const token = printed.find((line) => line.startsWith("CLUSTER_JOIN_TOKEN="))?.split("=")[1];

		expect(
			await registry.redeem(token ?? "", {
				publicUrl: "https://eu-2.test",
				tailnetUrl: "http://eu-2:3100",
				version: "1",
			}),
		).toMatchObject({ id: "eu-2" });
	});

	it("refuses to add a node that is already registered", async () => {
		await register("eu-2");

		await expect(nodeAdd(admin, { id: "eu-2", region: "eu", roles: "api" })).rejects.toThrow(
			RefusedError,
		);
	});

	it("sends a shutdown order and reports the main node's answer", async () => {
		await nodeShutdown(admin, {
			id: "eu-2",
			maintenance: true,
			retire: false,
			grace: "15m",
			force: false,
		});

		expect(admin.sendOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "shutdown",
				node: "eu-2",
				mode: "maintenance",
				graceMinutes: 15,
			}),
		);
		expect(printed).toEqual(["eu-2 is draining"]);
	});

	it("turns a refused order into a refusal", async () => {
		vi.mocked(admin.sendOrder).mockResolvedValue({ id: "x", ok: false, message: "below quorum" });

		await expect(
			nodeShutdown(admin, { id: "eu-2", maintenance: false, retire: true, force: false }),
		).rejects.toThrow(/below quorum/);
	});

	it("needs exactly one shutdown mode", async () => {
		await expect(
			nodeShutdown(admin, { id: "eu-2", maintenance: true, retire: true, force: false }),
		).rejects.toThrow(UsageError);
	});

	it("asks the main node to remove a node", async () => {
		await nodeRemove(admin, { id: "eu-2", force: true });

		expect(admin.sendOrder).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "deprovision", node: "eu-2", force: true }),
		);
	});

	it("asks the main node to fail back", async () => {
		await dbFailback(admin, "hel-1");

		expect(admin.sendOrder).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "failback", node: "hel-1" }),
		);
	});

	it("asks the main node to deploy monitoring", async () => {
		await monitoringDeploy(admin, "fsn-1");

		expect(admin.sendOrder).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "deployMonitoring", node: "fsn-1" }),
		);
	});

	it("asks the main node to deploy Uptime Kuma", async () => {
		await statusDeploy(admin, "fsn-1");

		expect(admin.sendOrder).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "deployStatus", node: "fsn-1" }),
		);
	});

	it("hands a new node to the main node for provisioning when given its address", async () => {
		await nodeAdd(admin, {
			id: "eu-2",
			region: "eu",
			roles: "api,live",
			publicUrl: "https://eu-2.nodes.colibri.social",
			ip: "203.0.113.7",
			workers: "8",
		});

		expect(admin.sendOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "provision",
				node: "eu-2",
				ip: "203.0.113.7",
				roles: ["api", "live"],
				workers: 8,
				joinToken: expect.any(String),
			}),
		);
	});

	it("needs a public URL to provision", async () => {
		await expect(
			nodeAdd(admin, { id: "eu-2", region: "eu", roles: "api", ip: "203.0.113.7" }),
		).rejects.toThrow(UsageError);
	});
});

describe("config import", () => {
	it("stores the shared settings of an env file and keeps node settings local", async () => {
		vi.mocked(admin.readFile).mockResolvedValue(
			'PDS_URL=https://pds.test\nNODE_ID=hel-1\nSIGNING_KEY="abc"\nEMPTY=\n',
		);

		await configImport(admin, { file: ".env", dryRun: false });

		expect(await admin.config.values()).toEqual({
			PDS_URL: "https://pds.test",
			SIGNING_KEY: "abc",
		});
		expect(printed).toEqual([
			"Stored 2 shared settings: PDS_URL, SIGNING_KEY",
			"Kept local to each node: NODE_ID",
		]);
	});

	it("changes nothing on a dry run", async () => {
		vi.mocked(admin.readFile).mockResolvedValue("PDS_URL=https://pds.test\n");

		await configImport(admin, { file: ".env", dryRun: true });

		expect(await admin.config.keys()).toEqual([]);
	});
});
