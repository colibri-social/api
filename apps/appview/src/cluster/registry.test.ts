import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRegistry, JOIN_TOKEN_TTL_MS, type Registry } from "./registry.js";

const ADDRESS = {
	publicUrl: "https://eu-2.nodes.colibri.social",
	tailnetUrl: "http://eu-2:3100",
	version: "1.0.0",
};

let database: TestDatabase;
let clock: Date;
let registry: Registry;

const register = (id: string, roles: ("main" | "api" | "live" | "voice")[] = ["api", "live"]) => {
	return registry.register(
		{ id, region: "eu", roles },
		{ ...ADDRESS, publicUrl: `https://${id}.test` },
	);
};

beforeEach(async () => {
	database = await openTestDatabase();
	clock = new Date("2026-11-09T12:00:00Z");
	registry = createRegistry(database, () => clock);
});

afterEach(async () => {
	await database.destroy();
});

describe("join tokens", () => {
	it("hands out a node secret once, for the identity the token was made for", async () => {
		const token = await registry.createJoinToken({ id: "eu-2", region: "eu", roles: ["api"] });
		const joined = await registry.redeem(token, ADDRESS);

		expect(joined?.id).toBe("eu-2");
		expect(await registry.redeem(token, ADDRESS)).toBeNull();
		expect(await registry.node("eu-2")).toMatchObject({
			region: "eu",
			roles: ["api"],
			state: "joining",
			tailnetUrl: "http://eu-2:3100",
		});
		expect(await registry.verify("eu-2", joined?.secret ?? "")).toBe(true);
		expect(await registry.verify("eu-2", "guess")).toBe(false);
	});

	it("refuses a token after an hour", async () => {
		const token = await registry.createJoinToken({ id: "eu-2", region: "eu", roles: ["api"] });

		clock = new Date(clock.getTime() + JOIN_TOKEN_TTL_MS + 1);

		expect(await registry.redeem(token, ADDRESS)).toBeNull();
	});

	it("stops trusting a retired node's secret", async () => {
		const token = await registry.createJoinToken({ id: "eu-2", region: "eu", roles: ["api"] });
		const joined = await registry.redeem(token, ADDRESS);

		await registry.setState("eu-2", "retired");

		expect(await registry.verify("eu-2", joined?.secret ?? "")).toBe(false);
	});
});

describe("registration", () => {
	it("comes up active, or stays parked after maintenance", async () => {
		expect(await register("eu-2")).toBe("active");

		await registry.setState("eu-2", "maintenance");

		expect(await register("eu-2")).toBe("maintenance");
	});

	it("lists nodes that accept clients", async () => {
		await register("eu-1", ["main"]);
		await register("eu-2");
		await register("eu-3");
		await registry.setState("eu-3", "draining");

		expect((await registry.accepting()).map((node) => node.id)).toEqual(["eu-2"]);

		clock = new Date(clock.getTime() + 5 * 60_000);

		expect(await registry.accepting()).toEqual([]);
	});

	it("remembers which node is main", async () => {
		await register("eu-1", ["main"]);
		await registry.claimMain("eu-1");

		expect((await registry.mainNode())?.id).toBe("eu-1");
	});
});

describe("mayLeave", () => {
	it("lets one of three nodes leave, but not a second", async () => {
		await register("eu-1");
		await register("eu-2");
		await register("eu-3");

		expect(await registry.mayLeave("eu-3")).toEqual({ allowed: true });

		await registry.setState("eu-3", "draining");

		expect(await registry.mayLeave("eu-2")).toMatchObject({ allowed: false });
	});

	it("leaves nodes in maintenance out of the count", async () => {
		await register("eu-1");
		await register("eu-2");
		await register("eu-3");
		await registry.setState("eu-3", "maintenance");

		expect(await registry.mayLeave("eu-2")).toEqual({ allowed: true });
	});

	it("never lets a lone node leave", async () => {
		await register("eu-1");

		expect(await registry.mayLeave("eu-1")).toMatchObject({ allowed: false });
	});
});

describe("rollout pause", () => {
	it("starts unpaused and stays paused once paused", async () => {
		expect(await registry.rolloutPaused()).toBe(false);

		await registry.pauseRollout();
		await registry.claimMain("eu-1");

		expect(await registry.rolloutPaused()).toBe(true);
	});
});
