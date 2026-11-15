import { describe, expect, it, vi } from "vitest";
import { NodeDirectory } from "./nodes.js";

const listing = {
	nodes: [
		{
			id: "stl-1",
			region: "us-central",
			roles: ["api", "live", "voice"],
			endpoint: "https://stl-1.nodes.colibri.test/",
			probeUrl: "https://stl-1.nodes.colibri.test/health",
		},
		{
			id: "hel-1",
			region: "eu",
			roles: ["main", "api", "live", "voice"],
			endpoint: "https://hel-1.nodes.colibri.test",
			probeUrl: "https://hel-1.nodes.colibri.test/health",
		},
		{
			id: "lau-1",
			region: "eu",
			roles: ["failover", "api", "live", "voice"],
			endpoint: "https://lau-1.nodes.colibri.test",
			probeUrl: "https://lau-1.nodes.colibri.test/health",
		},
		{ id: "broken", roles: ["live"] },
	],
};

const network = (latency: Record<string, number | "down">) => {
	let clock = 0;

	const fetcher = vi.fn(async (input: URL | string) => {
		const url = new URL(String(input));

		if (url.pathname === "/xrpc/social.colibri.beta.server.listNodes") {
			return Response.json(listing);
		}

		const host = url.hostname.split(".")[0] ?? "";
		const rtt = latency[host];

		if (rtt === undefined || rtt === "down") {
			return new Response(null, { status: 503 });
		}

		clock += rtt;

		return new Response("ok");
	});

	return { fetcher, now: () => clock };
};

describe("NodeDirectory", () => {
	it("orders reachable nodes by round trip and skips ones that fail their probe", async () => {
		const { fetcher, now } = network({ "stl-1": 120, "hel-1": 30, "lau-1": "down" });
		const directory = new NodeDirectory({
			appviewUrl: "https://spaces-api.colibri.test",
			fetch: fetcher as typeof fetch,
			now,
		});

		await directory.refresh();

		expect(directory.nodes.map((node) => node.id)).toEqual(["hel-1", "stl-1"]);
		expect(directory.endpointFor("live")).toBe("https://hel-1.nodes.colibri.test");
		expect(directory.endpointFor("live", new Set(["https://hel-1.nodes.colibri.test"]))).toBe(
			"https://stl-1.nodes.colibri.test",
		);
		expect(directory.endpointFor("main", new Set(["https://hel-1.nodes.colibri.test"]))).toBeNull();
	});

	it("lists nothing when the AppView can't list its nodes", async () => {
		const directory = new NodeDirectory({
			appviewUrl: "https://spaces-api.colibri.test",
			fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
		});

		await directory.refresh();

		expect(directory.endpointFor("live")).toBeNull();
	});

	it("refreshes only once the list is stale", async () => {
		const { fetcher } = network({ "hel-1": 10 });
		let time = 0;
		const directory = new NodeDirectory({
			appviewUrl: "https://spaces-api.colibri.test",
			fetch: fetcher as typeof fetch,
			now: () => time,
			refreshMs: 1_000,
		});

		await directory.refreshIfStale();
		await directory.refreshIfStale();

		const listed = () =>
			fetcher.mock.calls.filter(([input]) => String(input).includes("listNodes")).length;

		expect(listed()).toBe(1);

		time = 1_000;
		await directory.refreshIfStale();

		expect(listed()).toBe(2);
	});
});
