import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlClient } from "./control-client.js";
import { ControlServer } from "./control-server.js";
import { joinCluster } from "./node-secret.js";
import type { MainFrame } from "./protocol.js";
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

const link = (secret: string) => {
	const frames: MainFrame[] = [];
	const client = new ControlClient({
		nodeId: "eu-2",
		secret,
		log,
		mainUrl: async () => mainUrl,
		onFrame: (frame) => frames.push(frame),
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

		await vi.waitFor(() => expect(server.linked).toEqual(["eu-2"]), { timeout: 5_000 });
		expect(frames.filter((frame) => frame.t === "welcome")).toHaveLength(2);
	});
});
