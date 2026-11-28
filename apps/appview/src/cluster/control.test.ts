import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlClient, type ControlClientDeps } from "./control-client.js";
import { ControlServer } from "./control-server.js";
import { joinCluster } from "./node-secret.js";
import { CLOSE_MAIN_RELEASED, type MainFrame } from "./protocol.js";
import { createRegistry, type Registry } from "./registry.js";

const log = { info: vi.fn(), warn: vi.fn() };

const ADDRESS = {
	publicUrl: "https://eu-2.nodes.colibri.social",
	tailnetUrl: "http://eu-2:3100",
	version: "1.0.0",
};

let database: TestDatabase;
let registry: Registry;
let server: ControlServer;
let mainUrl: string;
let isMain: boolean;
let directory: string;
const clients: ControlClient[] = [];

beforeEach(async () => {
	vi.clearAllMocks();
	database = await openTestDatabase();
	registry = createRegistry(database);
	isMain = true;
	directory = mkdtempSync(join(tmpdir(), "colibri-node-"));
	server = new ControlServer({ registry, log, nodeId: "eu-1", isMain: () => isMain });

	const port = await server.listen(0, "127.0.0.1");

	mainUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
	for (const client of clients.splice(0)) client.stop();
	await server.close();
	await database.destroy();
	rmSync(directory, { recursive: true, force: true });
});

const join2 = async () => {
	const token = await registry.createJoinToken({ id: "eu-2", region: "eu", roles: ["api"] });
	const file = join(directory, "node-secret");
	const credentials = await joinCluster({ file, mainUrl, token, address: ADDRESS });

	return { secret: credentials?.secret ?? "", credentials, file, token };
};

const link = (secret: string, options: Partial<ControlClientDeps> = {}) => {
	const frames: MainFrame[] = [];
	const client = new ControlClient({
		nodeId: "eu-2",
		secret,
		log,
		mainUrl: async () => mainUrl,
		onFrame: (frame) => frames.push(frame),
		...options,
	});

	clients.push(client);
	client.start();

	return { client, frames };
};

describe("joining", () => {
	it("trades a join token for a secret it keeps on disk", async () => {
		const { credentials, file, token } = await join2();

		expect(credentials).toMatchObject({ id: "eu-2" });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(credentials);
		expect(await joinCluster({ file, mainUrl, token: "spent", address: ADDRESS })).toEqual(
			credentials,
		);
		expect(await registry.redeem(token, ADDRESS)).toBeNull();
	});

	it("fails on a token the main node does not know", async () => {
		await expect(
			joinCluster({ file: join(directory, "s"), mainUrl, token: "made-up", address: ADDRESS }),
		).rejects.toThrow(/401/);
	});

	it("reports each node that joins", async () => {
		const onJoined = vi.fn();

		await server.close();
		server = new ControlServer({ registry, log, nodeId: "eu-1", isMain: () => true, onJoined });
		mainUrl = `http://127.0.0.1:${await server.listen(0, "127.0.0.1")}`;

		await expect(
			joinCluster({ file: join(directory, "s"), mainUrl, token: "made-up", address: ADDRESS }),
		).rejects.toThrow(/401/);
		await join2();

		expect(onJoined.mock.calls).toEqual([["eu-2"]]);
	});

	it("refuses joins on a node that is not main", async () => {
		isMain = false;

		await expect(join2()).rejects.toThrow(/503/);
	});
});

describe("control link", () => {
	it("connects with the node secret and carries orders", async () => {
		const { secret } = await join2();
		const { frames } = link(secret);

		await vi.waitFor(() => expect(frames).toEqual([{ t: "welcome", mainNodeId: "eu-1" }]));
		expect(server.linked).toEqual(["eu-2"]);
		expect(server.send("eu-2", { t: "drain", mode: "maintenance" })).toBe(true);
		await vi.waitFor(() => expect(frames).toContainEqual({ t: "drain", mode: "maintenance" }));
	});

	it("refuses a wrong secret", async () => {
		await join2();
		link("wrong");

		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(server.linked).toEqual([]);
		expect(server.send("eu-2", { t: "resume" })).toBe(false);
	});

	it("reconnects after the link drops", async () => {
		const { secret } = await join2();
		const { frames } = link(secret);

		await vi.waitFor(() => expect(server.linked).toEqual(["eu-2"]));
		await server.close();

		server = new ControlServer({ registry, log, nodeId: "eu-1", isMain: () => true });
		await server.listen(Number(new URL(mainUrl).port), "127.0.0.1");

		await vi.waitFor(
			() => {
				expect(server.linked).toEqual(["eu-2"]);
				expect(frames.filter((frame) => frame.t === "welcome")).toHaveLength(2);
			},
			{ timeout: 5_000 },
		);
	});

	it("drops every link when the main role goes and takes them back once main again", async () => {
		const { secret } = await join2();
		const { frames } = link(secret);

		await vi.waitFor(() => expect(server.linked).toEqual(["eu-2"]));

		const linkedAt = server.linkHistory("eu-2").linkedAt;

		isMain = false;

		expect(server.dropLinks()).toEqual(["eu-2"]);
		expect(server.linked).toEqual([]);
		expect(server.linkHistory("eu-2")).toEqual({
			linkedAt,
			unlinkedAt: expect.any(Number),
		});
		expect(log.info).toHaveBeenCalledWith({ nodes: ["eu-2"] }, "cluster.linksDropped");

		await vi.waitFor(() =>
			expect(log.warn).toHaveBeenCalledWith(
				{ main: mainUrl, code: CLOSE_MAIN_RELEASED, reason: "main role released" },
				"cluster.linkClosed",
			),
		);
		await vi.waitFor(
			() =>
				expect(log.warn).toHaveBeenCalledWith(
					{ node: "eu-2", reason: "notMain" },
					"cluster.linkRejected",
				),
			{ timeout: 5_000 },
		);

		isMain = true;

		await vi.waitFor(
			() => {
				expect(server.linked).toEqual(["eu-2"]);
				expect(frames.filter((frame) => frame.t === "welcome")).toHaveLength(2);
			},
			{ timeout: 10_000 },
		);
	}, 15_000);

	it("terminates a link that stops hearing from the main node and dials again", async () => {
		const { secret } = await join2();
		const { frames } = link(secret, { idleMs: 200 });

		await vi.waitFor(
			() => {
				expect(log.warn).toHaveBeenCalledWith({ main: mainUrl, idleMs: 200 }, "cluster.linkIdle");
				expect(frames.filter((frame) => frame.t === "welcome").length).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 5_000 },
		);
		expect(log.info).toHaveBeenCalledWith(
			{ main: mainUrl, reason: "closed", delayMs: 1_000 },
			"cluster.linkRetry",
		);
	});

	it("logs waiting for a main node once while it keeps checking", async () => {
		vi.useFakeTimers();

		const mainUrlOf = vi.fn(async (): Promise<string | null> => null);

		try {
			link("secret", { mainUrl: mainUrlOf });

			for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
				await vi.advanceTimersByTimeAsync(delay);
			}

			expect(mainUrlOf.mock.calls.length).toBeGreaterThanOrEqual(5);
			expect(log.info.mock.calls.filter(([, message]) => message === "cluster.linkRetry")).toEqual([
				[{ main: null, reason: "noMain", delayMs: 1_000 }, "cluster.linkRetry"],
			]);
		} finally {
			for (const client of clients.splice(0)) client.stop();
			vi.useRealTimers();
		}
	});

	it("moves the link when the main node changes under an open socket", async () => {
		const { secret } = await join2();
		let current = mainUrl;

		link(secret, { mainUrl: async () => current, mainCheckMs: 100 });

		await vi.waitFor(() => expect(server.linked).toEqual(["eu-2"]));

		const next = new ControlServer({ registry, log, nodeId: "eu-3", isMain: () => true });
		const nextUrl = `http://127.0.0.1:${await next.listen(0, "127.0.0.1")}`;

		current = nextUrl;

		try {
			await vi.waitFor(
				() => {
					expect(next.linked).toEqual(["eu-2"]);
					expect(server.linked).toEqual([]);
				},
				{ timeout: 5_000 },
			);
			expect(log.warn).toHaveBeenCalledWith(
				{ connected: mainUrl, main: nextUrl },
				"cluster.linkStale",
			);
		} finally {
			for (const client of clients.splice(0)) client.stop();
			await next.close();
		}
	});
});

describe("write forwarding on the main node", () => {
	const startWithApp = async (primaryDownSince: () => number | null = () => null) => {
		const reached: Record<string, unknown>[] = [];
		const forwarding = new ControlServer({
			registry,
			log,
			nodeId: "eu-1",
			isMain: () => isMain,
			primaryDownSince,
			app: (request, response) => {
				reached.push({ ...request.headers });
				response.writeHead(200, { "content-type": "application/json" });
				response.end("{}");
			},
		});
		const port = await forwarding.listen(0, "127.0.0.1");

		return { forwarding, reached, url: `http://127.0.0.1:${port}` };
	};

	it("answers pings only while main", async () => {
		const { forwarding, url } = await startWithApp();

		try {
			expect((await fetch(`${url}/cluster/ping`)).status).toBe(200);

			isMain = false;

			expect(await (await fetch(`${url}/cluster/ping`)).json()).toMatchObject({
				error: "NotMain",
			});
		} finally {
			await forwarding.close();
		}
	});

	it("turns pings and writes away while its database is down", async () => {
		const { secret } = await join2();
		let downSince: number | null = Date.now();
		const { forwarding, reached, url } = await startWithApp(() => downSince);

		try {
			const write = () => {
				return fetch(`${url}/xrpc/social.colibri.beta.channel.postMessage`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-colibri-node": "eu-2",
						"x-colibri-node-secret": secret,
					},
					body: "{}",
				});
			};

			const ping = await fetch(`${url}/cluster/ping`);

			expect(ping.status).toBe(503);
			expect(await ping.json()).toEqual({ error: "DatabaseUnavailable" });
			expect(await (await write()).json()).toEqual({ error: "DatabaseUnavailable" });
			expect(reached).toHaveLength(0);

			downSince = null;

			expect((await fetch(`${url}/cluster/ping`)).status).toBe(200);
			expect((await write()).status).toBe(200);
		} finally {
			await forwarding.close();
		}
	});

	it("hands writes from known nodes to the app without their secret", async () => {
		const { secret } = await join2();
		const { forwarding, reached, url } = await startWithApp();

		try {
			const write = (headers: Record<string, string>) => {
				return fetch(`${url}/xrpc/social.colibri.beta.channel.postMessage`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: "{}",
				});
			};

			expect((await write({})).status).toBe(401);
			expect(
				(await write({ "x-colibri-node": "eu-2", "x-colibri-node-secret": "wrong" })).status,
			).toBe(401);
			expect(
				(await write({ "x-colibri-node": "eu-2", "x-colibri-node-secret": secret })).status,
			).toBe(200);
			expect(reached).toHaveLength(1);
			expect(reached[0]).toMatchObject({ "x-colibri-node": "eu-2" });
			expect(reached[0]).not.toHaveProperty("x-colibri-node-secret");
		} finally {
			await forwarding.close();
		}
	});
});
