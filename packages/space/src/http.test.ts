import { describe, expect, it } from "vitest";
import { XrpcClient } from "./http.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const encoder = new TextEncoder();

type Captured = { signal: AbortSignal | undefined };

const slowBody = (gaps: number[], signal?: AbortSignal) =>
	new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const gap of gaps) {
				await wait(gap);
				if (signal?.aborted) return;
				controller.enqueue(encoder.encode("x"));
			}
			controller.close();
		},
	});

const clientWith = (
	respond: (signal: AbortSignal | undefined) => Promise<Response>,
	captured: Captured = { signal: undefined },
) =>
	new XrpcClient({
		service: "https://pds.test",
		timeoutMs: 60,
		idleTimeoutMs: 60,
		fetch: async (_input, init) => {
			captured.signal = init?.signal ?? undefined;
			return respond(captured.signal);
		},
	});

describe("XrpcClient.stream", () => {
	it("keeps a slow body going past the request timeout while chunks keep arriving", async () => {
		const client = clientWith(async () => new Response(slowBody([30, 30, 30, 30])));

		const response = await client.stream("com.atproto.space.getBlob");
		expect(await response.text()).toBe("xxxx");
	});

	it("aborts a body that stops sending chunks", async () => {
		const captured: Captured = { signal: undefined };
		const client = clientWith(async (signal) => new Response(slowBody([0, 500], signal)), captured);

		const response = await client.stream("com.atproto.space.getBlob");
		await expect(response.text()).rejects.toMatchObject({
			name: "XrpcError",
			code: "UpstreamTimeout",
		});
		expect(captured.signal?.aborted).toBe(true);
	});

	it("gives up when the response headers never arrive", async () => {
		const client = clientWith(
			(signal) =>
				new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason));
				}),
		);

		await expect(client.stream("com.atproto.space.getBlob")).rejects.toMatchObject({
			name: "TimeoutError",
		});
	});

	it("keeps the status and headers of the upstream response", async () => {
		const client = clientWith(
			async () =>
				new Response(slowBody([0]), {
					status: 200,
					headers: { "content-length": "1", "content-type": "image/png" },
				}),
		);

		const response = await client.stream("com.atproto.space.getBlob");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-length")).toBe("1");
		expect(response.headers.get("content-type")).toBe("image/png");
	});
});

describe("XrpcClient.query", () => {
	it("still bounds the whole request with the timeout", async () => {
		const captured: Captured = { signal: undefined };
		const client = clientWith(async () => Response.json({ ok: true }), captured);

		expect(await client.query("com.atproto.space.listBlobs")).toEqual({ ok: true });
		expect(captured.signal?.aborted).toBe(false);
		await wait(100);
		expect(captured.signal?.aborted).toBe(true);
	});
});
