import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WriteMode } from "@colibri-social/appview-db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bufferBody } from "../federation/router.js";
import { NODE_ID_HEADER, NODE_SECRET_HEADER } from "./protocol.js";
import {
	MAX_WRITE_BYTES,
	PING_PATH,
	RESPONSE_TIMEOUT_MS,
	responseTimeoutFor,
	WriteProxy,
	type WriteProxyDeps,
} from "./write-proxy.js";

type Seen = { url: string; headers: IncomingMessage["headers"]; body: string };

const servers: Server[] = [];

const startMain = async (
	handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
	port = 0,
) => {
	const seen: Seen[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];

		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");

			if (request.url !== PING_PATH) {
				seen.push({ url: request.url ?? "", headers: request.headers, body });
			}

			handler(request, response, body);
		});
	});

	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	servers.push(server);

	return { server, seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

const ok = (_request: IncomingMessage, response: ServerResponse, body: string) => {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ echoed: body }));
};

const freePort = async (): Promise<number> => {
	const probe = createServer();

	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));

	const port = (probe.address() as AddressInfo).port;

	await new Promise<void>((resolve) => probe.close(() => resolve()));

	return port;
};

const proxies: WriteProxy[] = [];

const startSub = async (
	mainUrl: string,
	windowMs = 2_000,
	extra: Pick<WriteProxyDeps, "bodyLimits" | "queueMaxBytes"> = {},
) => {
	const modes: WriteMode[] = [];
	const proxy = new WriteProxy({
		nodeId: "eu-2",
		secret: "s3cret",
		windowMs,
		mainUrl: async () => mainUrl,
		log: { info: vi.fn(), warn: vi.fn() },
		onMode: (mode) => modes.push(mode),
		retryMs: 20,
		probeMs: 20,
		...extra,
	});
	const sub = createServer((request, response) => {
		void proxy.handle(request, response);
	});

	await new Promise<void>((resolve) => sub.listen(0, "127.0.0.1", resolve));
	servers.push(sub);
	proxies.push(proxy);

	const write = async (nsid: string, body: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${(sub.address() as AddressInfo).port}/xrpc/${nsid}`,
			{
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer user-jwt" },
				body: JSON.stringify(body),
			},
		);

		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	};

	const upload = async (nsid: string, bytes: number) => {
		const response = await fetch(
			`http://127.0.0.1:${(sub.address() as AddressInfo).port}/xrpc/${nsid}`,
			{
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: new Uint8Array(bytes),
			},
		);

		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	};

	return { proxy, modes, write, upload };
};

afterEach(async () => {
	for (const proxy of proxies.splice(0)) proxy.stop();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});

describe("WriteProxy", () => {
	it("forwards a write to the main node with the caller's auth and the node's identity", async () => {
		const main = await startMain(ok);
		const { write } = await startSub(main.url);

		const answer = await write("social.colibri.beta.channel.postMessage", { text: "hi" });

		expect(answer).toEqual({ status: 200, body: { echoed: '{"text":"hi"}' } });
		expect(main.seen[0]?.url).toBe("/xrpc/social.colibri.beta.channel.postMessage");
		expect(main.seen[0]?.headers).toMatchObject({
			authorization: "Bearer user-jwt",
			[NODE_ID_HEADER]: "eu-2",
			[NODE_SECRET_HEADER]: "s3cret",
		});
	});

	it("forwards a body the federation router already read", async () => {
		const main = await startMain(ok);
		const proxy = new WriteProxy({
			nodeId: "eu-2",
			secret: "s3cret",
			windowMs: 2_000,
			mainUrl: async () => main.url,
			log: { info: vi.fn(), warn: vi.fn() },
			onMode: () => {},
		});
		const sub = createServer((request, response) => {
			void bufferBody(request, 1_000).then(() => proxy.handle(request, response));
		});

		await new Promise<void>((resolve) => sub.listen(0, "127.0.0.1", resolve));
		servers.push(sub);
		proxies.push(proxy);

		const response = await fetch(
			`http://127.0.0.1:${(sub.address() as AddressInfo).port}/xrpc/social.colibri.beta.community.join`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ community: "did:plc:x" }),
			},
		);

		expect(await response.json()).toEqual({ echoed: '{"community":"did:plc:x"}' });
	});

	it("passes the main node's errors through unchanged", async () => {
		const main = await startMain((_request, response) => {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "InvalidRequest", message: "nope" }));
		});
		const { write } = await startSub(main.url);

		expect(await write("x.y.z", {})).toEqual({
			status: 400,
			body: { error: "InvalidRequest", message: "nope" },
		});
	});

	it("holds writes while the main node is away and sends them in order once it is back", async () => {
		const port = await freePort();
		const { write, modes, proxy } = await startSub(`http://127.0.0.1:${port}`);

		const first = write("a.b.first", { n: 1 });
		const second = write("a.b.second", { n: 2 });

		await vi.waitFor(() => expect(proxy.waiting).toBe(2));
		expect(modes).toEqual(["queued"]);

		const main = await startMain(ok, port);

		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
		expect(main.seen.map((entry) => entry.url)).toEqual(["/xrpc/a.b.first", "/xrpc/a.b.second"]);
		expect(modes).toEqual(["queued", "normal"]);
	});

	it("turns read-only after the window and back once the main node answers", async () => {
		const port = await freePort();
		const { write, modes, proxy } = await startSub(`http://127.0.0.1:${port}`, 100);

		expect(await write("a.b.c", {})).toMatchObject({ status: 503, body: { error: "ReadOnly" } });
		expect(proxy.mode).toBe("readOnly");
		expect((await write("a.b.d", {})).body.error).toBe("ReadOnly");

		await startMain(ok, port);

		await vi.waitFor(() => expect(proxy.mode).toBe("normal"));
		expect(modes).toEqual(["queued", "readOnly", "normal"]);
		expect((await write("a.b.e", {})).status).toBe(200);
	});

	it("follows a former main node to the current one", async () => {
		const main = await startMain(ok);
		const former = await startMain((_request, response) => {
			response.writeHead(503, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "NotMain", main: main.url }));
		});
		const { write } = await startSub(former.url);

		expect((await write("a.b.c", { n: 1 })).status).toBe(200);
		expect(main.seen).toHaveLength(1);
	});

	it("holds writes while the main node's database is down", async () => {
		let databaseDown = true;

		const main = await startMain((request, response, body) => {
			if (!databaseDown) {
				ok(request, response, body);

				return;
			}

			response.writeHead(503, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "DatabaseUnavailable" }));
		});

		const { write, modes, proxy } = await startSub(main.url);
		const held = write("a.b.c", { n: 1 });

		await vi.waitFor(() => expect(proxy.waiting).toBe(1));
		expect(modes).toEqual(["queued"]);

		databaseDown = false;

		expect((await held).status).toBe(200);
		expect(modes).toEqual(["queued", "normal"]);
	});

	it("never repeats a write the main node may already have applied", async () => {
		const main = await startMain((request) => request.socket.destroy());
		const { write } = await startSub(main.url);

		expect(await write("a.b.c", {})).toMatchObject({
			status: 502,
			body: { error: "UpstreamFailure" },
		});
		expect(main.seen).toHaveLength(1);
	});

	it("turns away bodies over the default limit before reading them", async () => {
		const main = await startMain(ok);
		const { upload } = await startSub(main.url);

		expect(await upload("a.b.c", MAX_WRITE_BYTES + 1)).toMatchObject({
			status: 413,
			body: { error: "PayloadTooLarge" },
		});
		expect(main.seen).toHaveLength(0);
	});

	it("forwards bodies up to a route's own limit", async () => {
		const bytes = MAX_WRITE_BYTES + 1024 * 1024;
		const main = await startMain((_request, response, body) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ size: Buffer.byteLength(body, "utf8") }));
		});
		const { upload } = await startSub(main.url, 2_000, {
			bodyLimits: { "x.y.uploadBlob": bytes },
		});

		expect(await upload("x.y.uploadBlob", bytes)).toEqual({ status: 200, body: { size: bytes } });
		expect(await upload("x.y.uploadBlob", bytes + 1)).toMatchObject({ status: 413 });
	});

	it("answers read-only when a held write would overflow the queue", async () => {
		const port = await freePort();
		const { upload, proxy } = await startSub(`http://127.0.0.1:${port}`, 2_000, {
			queueMaxBytes: 1024,
		});

		const first = upload("a.b.c", 512);

		await vi.waitFor(() => expect(proxy.waiting).toBe(1));

		expect(await upload("a.b.c", 1024)).toMatchObject({
			status: 503,
			body: { error: "ReadOnly" },
		});

		await startMain(ok, port);

		expect((await first).status).toBe(200);
	});

	it("gives larger bodies more time to reach the main node", () => {
		expect(responseTimeoutFor(0)).toBe(RESPONSE_TIMEOUT_MS);
		expect(responseTimeoutFor(75 * 1024 * 1024)).toBe(RESPONSE_TIMEOUT_MS + 75_000);
	});
});
