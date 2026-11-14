import { createConfigStore, createRegistry, type Registry } from "@colibri-social/appview/cluster";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { SecretBox } from "@colibri-social/community";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Admin,
	configImport,
	configUnset,
	dbBackup,
	dbStatus,
	dbSwitchover,
	formatTable,
	monitoringDeploy,
	nodeAdd,
	nodeList,
	nodeLocation,
	nodeRecover,
	nodeRemove,
	nodeShutdown,
	parseGrace,
	parseRoles,
	RefusedError,
	rolloutNow,
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
		confirm: vi.fn(async () => {}),
		databaseStatus: vi.fn(async () => ({ nodes: [], primary: null })),
		sleep: vi.fn(async () => {}),
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

		expect(printed[0]).toMatch(/^NODE\s+REGION\s+LOCATION\s+ROLES\s+STATE\s+HEARTBEAT/);
		expect(printed.some((line) => /^hel-1 \*\s+eu\s+-\s+main\s+active\s+30s ago/.test(line))).toBe(
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

	it("sets and clears a node's location", async () => {
		await register("hel-1", ["main"]);
		await nodeLocation(admin, "hel-1", "Helsinki, Finland");

		expect((await registry.node("hel-1"))?.location).toBe("Helsinki, Finland");

		await nodeLocation(admin, "hel-1", undefined);

		expect((await registry.node("hel-1"))?.location).toBeNull();
		await expect(nodeLocation(admin, "nope-1", "Nowhere")).rejects.toThrow(RefusedError);
	});

	it("refuses to add a node that is already registered", async () => {
		await register("eu-2");

		await expect(nodeAdd(admin, { id: "eu-2", region: "eu", roles: "api" })).rejects.toThrow(
			RefusedError,
		);
	});

	it("sends a shutdown order and reports the main node's answer", async () => {
		await register("eu-2");
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

	it("runs a full backup unless told otherwise and refuses unknown types", async () => {
		await dbBackup(admin, undefined);
		await dbBackup(admin, "incr");

		expect(admin.sendOrder).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ kind: "backup", type: "full" }),
		);
		expect(admin.sendOrder).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ kind: "backup", type: "incr" }),
		);
		await expect(dbBackup(admin, "weekly")).rejects.toBeInstanceOf(UsageError);
	});

	it("starts a rollout now with a 2 minute grace unless told otherwise", async () => {
		await rolloutNow(admin, undefined);
		await rolloutNow(admin, "90s");

		expect(admin.sendOrder).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ kind: "rolloutNow", graceMinutes: 2 }),
		);
		expect(admin.sendOrder).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ kind: "rolloutNow", graceMinutes: 1.5 }),
		);
	});

	it("turns a refused order into a refusal", async () => {
		await register("eu-2");
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
		await register("eu-2");
		await nodeRemove(admin, { id: "eu-2", force: true });

		expect(admin.confirm).toHaveBeenCalledWith(
			expect.objectContaining({ risk: "irreversible", token: "eu-2" }),
		);
		expect(admin.sendOrder).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "deprovision", node: "eu-2", force: true }),
		);
	});

	it("refuses an unknown node before asking", async () => {
		await expect(nodeRemove(admin, { id: "nope-1", force: false })).rejects.toThrow(RefusedError);
		expect(admin.confirm).not.toHaveBeenCalled();
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

describe("confirmation", () => {
	beforeEach(async () => {
		await register("eu-2");
	});

	it("asks before a shutdown and labels it by risk", async () => {
		await nodeShutdown(admin, { id: "eu-2", maintenance: true, retire: false, force: false });
		await nodeShutdown(admin, { id: "eu-2", maintenance: false, retire: true, force: true });

		expect(vi.mocked(admin.confirm).mock.calls.map(([request]) => request.risk)).toEqual([
			"disruptive",
			"irreversible",
		]);
		expect(vi.mocked(admin.confirm).mock.calls[1]?.[0]).toMatchObject({ token: "eu-2" });
	});

	it("sends nothing when the confirmation is declined", async () => {
		vi.mocked(admin.confirm).mockRejectedValue(new RefusedError("Cancelled. Nothing changed."));

		await expect(
			nodeShutdown(admin, { id: "eu-2", maintenance: true, retire: false, force: false }),
		).rejects.toThrow(/Cancelled/);
		await expect(nodeRecover(admin, "eu-2")).rejects.toThrow(/Cancelled/);
		await expect(rolloutNow(admin, undefined)).rejects.toThrow(/Cancelled/);
		expect(admin.sendOrder).not.toHaveBeenCalled();
	});

	it("asks before removing a stored setting only", async () => {
		await configUnset(admin, "PDS_URL");

		expect(admin.confirm).not.toHaveBeenCalled();

		await admin.config.set("PDS_URL", "https://pds.test");
		await configUnset(admin, "PDS_URL");

		expect(admin.confirm).toHaveBeenCalledWith(expect.objectContaining({ risk: "disruptive" }));
	});

	it("asks before an import replaces stored values", async () => {
		vi.mocked(admin.readFile).mockResolvedValue("PDS_URL=https://pds.test\n");
		await configImport(admin, { file: ".env", dryRun: false });

		expect(admin.confirm).not.toHaveBeenCalled();

		vi.mocked(admin.readFile).mockResolvedValue("PDS_URL=https://other.test\n");
		await configImport(admin, { file: ".env", dryRun: false });

		expect(admin.confirm).toHaveBeenCalledWith(
			expect.objectContaining({ title: "replace 1 shared settings" }),
		);
	});
});

describe("database switching", () => {
	const checked = (lines: string[]) => {
		return vi.fn(async (order: { id: string; kind: string }) =>
			order.kind === "switchoverCheck"
				? {
						id: order.id,
						ok: !lines.some((line) => !line.startsWith("ok")),
						message: ["fsn-1", ...lines].join("\n"),
					}
				: { id: order.id, ok: true, message: "fsn-1 is the primary now" },
		);
	};

	it("checks, asks, switches over and waits for the old primary to stream", async () => {
		admin.sendOrder = checked(["ok   fsn-1 can hold the main role"]);
		vi.mocked(admin.databaseStatus)
			.mockResolvedValueOnce({ primary: "hel-1", nodes: [] })
			.mockResolvedValueOnce({
				primary: "fsn-1",
				nodes: [
					{
						id: "hel-1",
						postgres: "fenced",
						epoch: 2,
						streaming: false,
						lagBytes: null,
						replayedAt: null,
					},
				],
			})
			.mockResolvedValueOnce({
				primary: "fsn-1",
				nodes: [
					{
						id: "hel-1",
						postgres: "replica",
						epoch: 3,
						streaming: true,
						lagBytes: 0,
						replayedAt: null,
					},
				],
			});

		await dbSwitchover(admin, { node: "fsn-1", force: false, wait: true });

		expect(admin.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				risk: "disruptive",
				title: "move the Postgres primary from hel-1 to fsn-1",
			}),
		);
		expect(admin.sendOrder).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: "failback", node: "fsn-1" }),
		);
		expect(printed).toContain("hel-1: fenced");
		expect(printed).toContain("hel-1 is a streaming replica again. The switchover is complete.");
	});

	it("stops on a failed check and on a warning without --force", async () => {
		admin.sendOrder = checked(["FAIL fsn-1's Postgres streams from the primary"]);

		await expect(dbSwitchover(admin, { node: "fsn-1", force: true, wait: false })).rejects.toThrow(
			/FAIL/,
		);

		admin.sendOrder = checked(["WARN fsn-1 is less than 16.0 MB behind"]);

		await expect(dbSwitchover(admin, { node: "fsn-1", force: false, wait: false })).rejects.toThrow(
			/WARN/,
		);
		expect(admin.confirm).not.toHaveBeenCalled();
	});

	it("asks for the node ID when --force skips warnings", async () => {
		admin.sendOrder = checked(["WARN fsn-1 is less than 16.0 MB behind"]);

		await dbSwitchover(admin, { node: "fsn-1", force: true, wait: false });

		expect(admin.confirm).toHaveBeenCalledWith(
			expect.objectContaining({ risk: "irreversible", token: "fsn-1" }),
		);
		expect(admin.sendOrder).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: "failback", node: "fsn-1", force: true }),
		);
	});

	describe("shutting down the main node", () => {
		const shutdownOptions = { id: "hel-1", maintenance: true, retire: false, force: false };

		beforeEach(async () => {
			await registry.register(
				{ id: "hel-1", region: "eu", roles: ["main"] },
				{ publicUrl: "https://hel-1.test", tailnetUrl: "http://hel-1:3100", version: "2.36.0" },
			);
			await registry.register(
				{ id: "fsn-1", region: "eu", roles: ["failover"] },
				{ publicUrl: "https://fsn-1.test", tailnetUrl: "http://fsn-1:3100", version: "2.36.0" },
			);
			await registry.claimMain("hel-1");
			vi.mocked(admin.databaseStatus).mockResolvedValue({ primary: "hel-1", nodes: [] });
		});

		const handingOver = (lines: string[], takesMain = true) => {
			const check = checked(lines);

			return vi.fn(async (order: { id: string; kind: string }) => {
				if (order.kind === "failback" && takesMain) {
					await registry.claimMain("fsn-1");
				}

				return order.kind === "shutdown"
					? { id: order.id, ok: true, message: "hel-1 is draining" }
					: check(order);
			});
		};

		it("switches over first, then drains the old main", async () => {
			admin.sendOrder = handingOver(["ok   fsn-1 can hold the main role"]);

			await nodeShutdown(admin, shutdownOptions);

			expect(vi.mocked(admin.sendOrder).mock.calls.map(([order]) => order.kind)).toEqual([
				"switchoverCheck",
				"failback",
				"shutdown",
			]);
			expect(admin.confirm).toHaveBeenCalledTimes(1);
			expect(admin.confirm).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "move the main role to fsn-1, then put hel-1 into maintenance",
					token: "hel-1",
				}),
			);
			expect(printed).toContain("hel-1 is draining");
		});

		it("stops on a failed check and on a warning even with --force", async () => {
			admin.sendOrder = handingOver(["FAIL fsn-1's Postgres streams from the primary"]);

			await expect(nodeShutdown(admin, shutdownOptions)).rejects.toThrow(/FAIL/);

			admin.sendOrder = handingOver(["WARN fsn-1 is less than 16.0 MB behind"]);

			await expect(nodeShutdown(admin, { ...shutdownOptions, force: true })).rejects.toThrow(
				/db switchover --force/,
			);
			expect(admin.confirm).not.toHaveBeenCalled();
		});

		it("doesn't drain when the new primary never takes the main role", async () => {
			let clock = new Date("2026-11-09T12:00:30Z").getTime();

			admin.now = () => new Date(clock);
			admin.sleep = vi.fn(async (ms: number) => {
				clock += ms;
			});
			admin.sendOrder = handingOver(["ok   fsn-1 can hold the main role"], false);

			await expect(nodeShutdown(admin, shutdownOptions)).rejects.toThrow(
				/hasn't taken the main role yet/,
			);
			expect(admin.sendOrder).not.toHaveBeenCalledWith(
				expect.objectContaining({ kind: "shutdown" }),
			);
		});
	});

	it("shows the database layout and who is ready to take over", async () => {
		await register("eu-2");
		await registry.register(
			{ id: "hel-1", region: "eu", roles: ["main"] },
			{ publicUrl: "https://hel-1.test", tailnetUrl: "http://hel-1:3100", version: "2.36.0" },
		);
		await registry.register(
			{ id: "fsn-1", region: "eu", roles: ["failover"] },
			{ publicUrl: "https://fsn-1.test", tailnetUrl: "http://fsn-1:3100", version: "2.36.0" },
		);
		await registry.claimMain("hel-1");
		await registry.heartbeat("hel-1", {
			connections: 0,
			activeCalls: 0,
			version: "2.36.0",
			databaseHosts: ["fsn-1", "postgres"],
		});
		await registry.heartbeat("fsn-1", {
			connections: 0,
			activeCalls: 0,
			version: "2.36.0",
			databaseHosts: ["hel-1", "postgres"],
		});
		await registry.heartbeat("eu-2", {
			connections: 0,
			activeCalls: 0,
			version: "2.36.0",
			databaseHosts: ["hel-1"],
		});
		vi.mocked(admin.databaseStatus).mockResolvedValue({
			primary: "hel-1",
			nodes: [
				{
					id: "hel-1",
					postgres: "primary",
					epoch: 2,
					streaming: false,
					lagBytes: null,
					replayedAt: null,
				},
				{
					id: "fsn-1",
					postgres: "replica",
					epoch: 2,
					streaming: true,
					lagBytes: 2048,
					replayedAt: null,
				},
			],
		});

		await dbStatus(admin);

		expect(printed[0]).toMatch(/^NODE\s+ROLES\s+POSTGRES\s+EPOCH\s+STREAMING\s+LAG/);
		expect(
			printed.some((line) => /^fsn-1\s+failover\s+replica\s+2\s+yes\s+2 KB\s+no/.test(line)),
		).toBe(true);
		expect(
			printed.some(
				(line) =>
					line.startsWith("fsn-1 isn't ready:") && line.includes("eu-2's DATABASE_URL lists hel-1"),
			),
		).toBe(true);
	});
});
