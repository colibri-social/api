import type { AddressInfo } from "node:net";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./client.js";

let server: Server | null = null;
const sockets: Socket[] = [];

const silentServer = async (): Promise<number> => {
	server = createServer((socket) => sockets.push(socket));

	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));

	return (server.address() as AddressInfo).port;
};

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();

	await new Promise((resolve) => server?.close(resolve));
	server = null;
});

describe("pool wait", () => {
	it("fails a query instead of waiting forever for a connection", async () => {
		const port = await silentServer();

		const database = openDatabase({
			url: `postgres://user:secret@127.0.0.1:${port}/colibri`,
			maxConnections: 1,
			poolWaitMs: 200,
		});

		const started = Date.now();

		await expect(database.ping()).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(2_000);

		await database.close();
	});

	it("fails a query queued behind a stuck connection", async () => {
		const port = await silentServer();

		const database = openDatabase({
			url: `postgres://user:secret@127.0.0.1:${port}/colibri`,
			maxConnections: 1,
			poolWaitMs: 200,
		});

		const results = await Promise.allSettled([database.ping(), database.ping()]);

		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);

		await database.close();
	});
});
