import { describe, expect, it, vi } from "vitest";
import {
	CLOUDFLARE_API,
	createCloudflare,
	desiredOrigins,
	MONITOR_DESCRIPTION,
	parseGeoRegions,
} from "./cloudflare.js";
import type { NodeRow } from "./registry.js";

type Stored = Record<string, unknown> & { id: string };

const node = (id: string, overrides: Partial<NodeRow> = {}): NodeRow => {
	return {
		id,
		region: "eu",
		roles: ["api"],
		publicUrl: `https://${id}.nodes.colibri.test`,
		tailnetUrl: `http://${id}:3100`,
		version: "1",
		state: "active",
		connections: 0,
		activeCalls: 0,
		heartbeatAt: null,
		drainDeadline: null,
		...overrides,
	};
};

const fakeCloudflare = () => {
	let next = 0;
	const records: Stored[] = [];
	const pools: Stored[] = [];
	const monitors: Stored[] = [];
	const balancer: Stored = {
		id: "lb1",
		name: "api.colibri.test",
		default_pools: ["manual"],
		fallback_pool: "manual",
		steering_policy: "off",
	};
	const calls: string[] = [];
	const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }));

	const request = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(new URL(CLOUDFLARE_API).pathname, "");
		const method = init?.method ?? "GET";
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

		calls.push(`${method} ${path}`);

		const collection = (list: Stored[], base: string) => {
			if (path === base && method === "GET") return ok(list);

			if (path === base && method === "POST") {
				next += 1;

				const item = { id: `id${next}`, ...body };

				list.push(item);

				return ok(item);
			}

			const id = path.slice(base.length + 1);
			const index = list.findIndex((item) => item.id === id);

			if (index === -1) return null;
			if (method === "DELETE") return ok(list.splice(index, 1)[0]);

			list[index] = { ...list[index], ...body, id };

			return ok(list[index]);
		};

		if (path.startsWith("/zones/z1/dns_records")) {
			if (method === "GET") {
				return ok(
					records.filter(
						(record) =>
							record.name === url.searchParams.get("name") &&
							record.type === url.searchParams.get("type"),
					),
				);
			}

			return collection(records, "/zones/z1/dns_records");
		}

		if (path === "/zones/z1/load_balancers/lb1") {
			if (method === "PATCH") Object.assign(balancer, body);

			return ok(balancer);
		}

		return (
			collection(pools, "/accounts/a1/load_balancers/pools") ??
			collection(monitors, "/accounts/a1/load_balancers/monitors") ??
			new Response(JSON.stringify({ success: false, errors: [{ message: "nope" }] }), {
				status: 404,
			})
		);
	}) as typeof fetch;

	return { request, records, pools, monitors, balancer, calls };
};

const client = (api: ReturnType<typeof fakeCloudflare>) => {
	return createCloudflare({
		token: "t",
		accountId: "a1",
		zoneId: "z1",
		loadBalancerId: "lb1",
		geo: parseGeoRegions("eu=WEU,EEU;us=ENAM,WNAM"),
		mainRegion: "eu",
		log: { info: vi.fn(), warn: vi.fn() },
		fetch: api.request,
	});
};

describe("parseGeoRegions", () => {
	it("maps regions to Cloudflare region codes", () => {
		expect(parseGeoRegions(" eu = weu, EEU ; us=ENAM;")).toEqual({
			eu: ["WEU", "EEU"],
			us: ["ENAM"],
		});
		expect(parseGeoRegions(undefined)).toEqual({});
	});

	it("rejects unknown codes and malformed entries", () => {
		expect(() => parseGeoRegions("eu=MARS")).toThrow(/not a Cloudflare region/);
		expect(() => parseGeoRegions("eu")).toThrow(/region=CODE/);
	});
});

describe("desiredOrigins", () => {
	it("keeps api nodes, disables ones that aren't active and leaves out the load balancer host", () => {
		const origins = desiredOrigins(
			[
				node("eu-2", { state: "draining" }),
				node("eu-1"),
				node("voice-1", { roles: ["voice"] }),
				node("old-1", { state: "retired" }),
				node("hel-1", { publicUrl: "https://api.colibri.test" }),
			],
			"api.colibri.test",
		);

		expect([...origins.keys()]).toEqual(["eu"]);
		expect(origins.get("eu")?.map((origin) => [origin.name, origin.enabled])).toEqual([
			["eu-1", true],
			["eu-2", false],
		]);
		expect(origins.get("eu")?.[0]?.header).toEqual({ Host: ["eu-1.nodes.colibri.test"] });
	});
});

describe("node records", () => {
	it("creates, updates and removes a node's A record", async () => {
		const api = fakeCloudflare();
		const cloudflare = client(api);

		await cloudflare.putNodeRecord("eu-1", "eu-1.nodes.colibri.test", "203.0.113.5");
		await cloudflare.putNodeRecord("eu-1", "eu-1.nodes.colibri.test", "203.0.113.6");

		expect(api.records).toEqual([
			expect.objectContaining({
				type: "A",
				name: "eu-1.nodes.colibri.test",
				content: "203.0.113.6",
				proxied: false,
				comment: "colibri node eu-1",
			}),
		]);

		expect(await cloudflare.removeNodeRecord("eu-1.nodes.colibri.test")).toBe(true);
		expect(api.records).toEqual([]);
	});

	it("points the status host at a node with a CNAME", async () => {
		const api = fakeCloudflare();
		const cloudflare = client(api);

		await cloudflare.putAlias("status.colibri.test", "eu-1.nodes.colibri.test");
		await cloudflare.putAlias("status.colibri.test", "fsn-1.nodes.colibri.test");

		expect(api.records).toEqual([
			expect.objectContaining({
				type: "CNAME",
				name: "status.colibri.test",
				content: "fsn-1.nodes.colibri.test",
				comment: "colibri status",
			}),
		]);
	});

	it("leaves records it doesn't manage alone", async () => {
		const api = fakeCloudflare();
		const cloudflare = client(api);

		api.records.push({ id: "r1", name: "www.colibri.test", type: "A", content: "1.1.1.1" });

		await expect(cloudflare.putNodeRecord("x", "www.colibri.test", "2.2.2.2")).rejects.toThrow(
			/doesn't manage/,
		);
		expect(await cloudflare.removeNodeRecord("www.colibri.test")).toBe(false);
		expect(api.records).toHaveLength(1);
	});
});

describe("syncPools", () => {
	it("creates a pool per region and steers each region to its pool", async () => {
		const api = fakeCloudflare();
		const cloudflare = client(api);

		await cloudflare.syncPools([node("eu-1"), node("us-1", { region: "us" })]);

		expect(api.monitors).toEqual([
			expect.objectContaining({ description: MONITOR_DESCRIPTION, path: "/health" }),
		]);
		expect(api.pools.map((pool) => pool.name)).toEqual(["colibri-eu", "colibri-us"]);

		const [eu, us] = api.pools.map((pool) => pool.id);

		expect(api.balancer).toMatchObject({
			default_pools: [eu, us],
			fallback_pool: eu,
			steering_policy: "geo",
			region_pools: { WEU: [eu], EEU: [eu], ENAM: [us], WNAM: [us] },
		});
	});

	it("changes nothing when the pools already match", async () => {
		const api = fakeCloudflare();
		const cloudflare = client(api);

		await cloudflare.syncPools([node("eu-1")]);
		api.calls.length = 0;
		await cloudflare.syncPools([node("eu-1")]);

		expect(api.calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
	});

	it("updates origins and drops the pool of a region with no api nodes left", async () => {
		const api = fakeCloudflare();
		const cloudflare = client(api);

		await cloudflare.syncPools([node("eu-1"), node("us-1", { region: "us" })]);
		await cloudflare.syncPools([node("eu-1", { state: "draining" }), node("eu-2")]);

		expect(api.pools.map((pool) => pool.name)).toEqual(["colibri-eu"]);
		const origins = (api.pools[0]?.origins ?? []) as { name: string; enabled: boolean }[];

		expect(origins.map((origin) => [origin.name, origin.enabled])).toEqual([
			["eu-1", false],
			["eu-2", true],
		]);
		const eu = api.pools[0]?.id;

		expect(api.balancer.region_pools).toEqual({ WEU: [eu], EEU: [eu] });
	});

	it("leaves the load balancer alone without any api nodes", async () => {
		const api = fakeCloudflare();

		await client(api).syncPools([node("voice-1", { roles: ["voice"] })]);

		expect(api.balancer.default_pools).toEqual(["manual"]);
		expect(api.pools).toEqual([]);
	});
});
