import { cidForRawBytes } from "@atproto/lex-data";
import type { SpaceClient, SpaceHostResolver } from "@colibri-social/space";
import { XrpcError } from "@colibri-social/space";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { BlobCache } from "./cache.js";
import { BlobNotFoundError, BlobUpstreamError } from "./errors.js";
import { BlobService } from "./service.js";

const DID = "did:plc:7fkdlwjqmzcuvvpjbztkyyyy";
const HOST = "https://pds.test";
const SPACE =
	"at://did:plc:2hnjxkqm6bpuvvpjbztkxxxx/social.colibri.beta.channel.text/3lkabcdefgh2k";

const pngBytes = () =>
	sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 9, g: 8, b: 7 } } })
		.png()
		.toBuffer();

const staticHosts = (host = HOST): SpaceHostResolver => ({
	hostFor: async () => host,
});

type FakeFetch = {
	fetch: typeof globalThis.fetch;
	callCount: () => number;
};

const fakeFetch = (respond: () => Response): FakeFetch => {
	let calls = 0;
	const fetchImpl = async (): Promise<Response> => {
		calls += 1;
		return respond();
	};
	return { fetch: fetchImpl, callCount: () => calls };
};

type FakeSpaceClient = {
	client: SpaceClient;
	callCount: () => number;
};

const fakeSpaceClient = (respond: () => Response | Promise<Response>): FakeSpaceClient => {
	let calls = 0;
	const client = {
		getBlob: async () => {
			calls += 1;
			return respond();
		},
	};
	return { client: client as unknown as SpaceClient, callCount: () => calls };
};

const SPACE_B =
	"at://did:plc:2hnjxkqm6bpuvvpjbztkxxxx/social.colibri.beta.channel.text/3lkbbbbbbbbbb";

const chunkedResponse = (source: Uint8Array, chunkSize = 16): Response => {
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= source.byteLength) {
				controller.close();
				return;
			}
			controller.enqueue(source.slice(offset, offset + chunkSize));
			offset += chunkSize;
		},
	});
	return new Response(body, { headers: { "content-length": String(source.byteLength) } });
};

const drain = async (stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> => {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
};

const joined = (chunks: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
};

describe("BlobService", () => {
	let bytes: Uint8Array;
	let cid: string;

	beforeEach(async () => {
		bytes = new Uint8Array(await pngBytes());
		cid = (await cidForRawBytes(bytes)).toString();
	});

	it("fetches a public blob and verifies its CID", async () => {
		const { fetch } = fakeFetch(() => new Response(bytes));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		const result = await service.fetch({ did: DID, cid });
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.mimeType).toBe("image/png");
			expect(result.bytes).toEqual(bytes);
			expect(result.totalSize).toBe(bytes.byteLength);
		}
	});

	it("fetches a permissioned blob through the space client when a space is given", async () => {
		const { client, callCount } = fakeSpaceClient(() => new Response(bytes));
		const service = new BlobService({ spaceClient: client, hosts: staticHosts() });

		const result = await service.fetch({ did: DID, cid, space: SPACE });
		expect(result.status).toBe("ok");
		expect(callCount()).toBe(1);
	});

	it("rejects bytes that do not match the requested CID", async () => {
		const tampered = new Uint8Array(bytes);
		tampered[0] = (tampered[0] ?? 0) ^ 0xff;
		const { fetch } = fakeFetch(() => new Response(tampered));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		await expect(service.fetch({ did: DID, cid })).rejects.toMatchObject({
			name: "BlobRejectedError",
			reason: "cidMismatch",
		});
	});

	it("surfaces a 404 upstream as BlobNotFoundError", async () => {
		const { fetch } = fakeFetch(() => new Response(null, { status: 404 }));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		await expect(service.fetch({ did: DID, cid })).rejects.toBeInstanceOf(BlobNotFoundError);
	});

	it("surfaces an XRPC 400 BlobNotFound upstream as BlobNotFoundError", async () => {
		const { fetch } = fakeFetch(() =>
			Response.json({ error: "BlobNotFound", message: "Blob not found" }, { status: 400 }),
		);
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		await expect(service.fetch({ did: DID, cid })).rejects.toBeInstanceOf(BlobNotFoundError);
	});

	it("keeps any other upstream 400 a BlobUpstreamError", async () => {
		const { fetch } = fakeFetch(() =>
			Response.json({ error: "InvalidRequest", message: "bad cid" }, { status: 400 }),
		);
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		await expect(service.fetch({ did: DID, cid })).rejects.toBeInstanceOf(BlobUpstreamError);
	});

	it("surfaces an upstream 500 as BlobUpstreamError", async () => {
		const { fetch } = fakeFetch(() => new Response(null, { status: 500 }));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		await expect(service.fetch({ did: DID, cid })).rejects.toBeInstanceOf(BlobUpstreamError);
	});

	it("maps a not-found XrpcError from the space client to BlobNotFoundError", async () => {
		const client = {
			getBlob: async () => {
				throw new XrpcError(404, "BlobNotFound", "no such blob", "com.atproto.space.getBlob");
			},
		};
		const service = new BlobService({
			spaceClient: client as unknown as SpaceClient,
			hosts: staticHosts(),
		});

		await expect(service.fetch({ did: DID, cid, space: SPACE })).rejects.toBeInstanceOf(
			BlobNotFoundError,
		);
	});

	it("caches the original blob so a second fetch does not hit the network again", async () => {
		const { fetch, callCount } = fakeFetch(() => new Response(bytes));
		const cache = new BlobCache();
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
			cache,
		});

		await service.fetch({ did: DID, cid });
		await service.fetch({ did: DID, cid });

		expect(callCount()).toBe(1);
	});

	it("renders a variant from the cached original without a second upstream fetch", async () => {
		const { fetch, callCount } = fakeFetch(() => new Response(bytes));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		const full = await service.fetch({ did: DID, cid, variant: "full" });
		const thumb = await service.fetch({ did: DID, cid, variant: "thumbnail" });

		expect(callCount()).toBe(1);
		expect(full.status).toBe("ok");
		expect(thumb.status).toBe("ok");
		if (full.status === "ok" && thumb.status === "ok") {
			expect(thumb.mimeType).toBe("image/webp");
			expect(thumb.bytes).not.toEqual(full.bytes);
		}
	});

	it("applies a range to the resolved bytes", async () => {
		const { fetch } = fakeFetch(() => new Response(bytes));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		const result = await service.fetch({ did: DID, cid, range: "bytes=0-9" });
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.range).toEqual({ start: 0, end: 9 });
			expect(result.bytes).toEqual(bytes.subarray(0, 10));
		}
	});

	it("reports an unsatisfiable range instead of throwing", async () => {
		const { fetch } = fakeFetch(() => new Response(bytes));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		const result = await service.fetch({
			did: DID,
			cid,
			range: `bytes=${bytes.byteLength + 100}-`,
		});
		expect(result).toEqual({ status: "rangeNotSatisfiable", totalSize: bytes.byteLength });
	});

	it("streams a full blob above the cache entry cap without caching it", async () => {
		const { fetch, callCount } = fakeFetch(() => chunkedResponse(bytes));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
			cache: new BlobCache({ maxEntryBytes: 32 }),
		});

		const result = await service.fetch({ did: DID, cid });
		expect(result.status).toBe("stream");
		if (result.status !== "stream") return;
		expect(result.mimeType).toBe("image/png");
		expect(result.length).toBe(bytes.byteLength);
		expect(joined(await drain(result.stream))).toEqual(bytes);

		const again = await service.fetch({ did: DID, cid });
		if (again.status === "stream") await drain(again.stream);
		expect(callCount()).toBe(2);
	});

	it("aborts a streamed blob whose bytes do not match the CID before the last chunk", async () => {
		const tampered = new Uint8Array(bytes);
		const last = tampered.byteLength - 1;
		tampered[last] = (tampered[last] ?? 0) ^ 0xff;
		const { fetch } = fakeFetch(() => chunkedResponse(tampered));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
			cache: new BlobCache({ maxEntryBytes: 32 }),
		});

		const result = await service.fetch({ did: DID, cid });
		expect(result.status).toBe("stream");
		if (result.status !== "stream") return;

		const received: Uint8Array[] = [];
		await expect(
			(async () => {
				for await (const chunk of result.stream) received.push(chunk);
			})(),
		).rejects.toMatchObject({ name: "BlobRejectedError", reason: "cidMismatch" });
		expect(joined(received).byteLength).toBeLessThan(tampered.byteLength);
	});

	it("serves a range from a streamed blob", async () => {
		const { fetch } = fakeFetch(() => chunkedResponse(bytes));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
			cache: new BlobCache({ maxEntryBytes: 32 }),
		});

		const result = await service.fetch({ did: DID, cid, range: "bytes=5-40" });
		expect(result.status).toBe("stream");
		if (result.status !== "stream") return;
		expect(result.range).toEqual({ start: 5, end: 40 });
		expect(result.length).toBe(36);
		expect(result.totalSize).toBe(bytes.byteLength);
		expect(joined(await drain(result.stream))).toEqual(bytes.subarray(5, 41));
	});

	it("reports an unsatisfiable range on a streamed blob", async () => {
		const { fetch } = fakeFetch(() => chunkedResponse(bytes));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
			cache: new BlobCache({ maxEntryBytes: 32 }),
		});

		const result = await service.fetch({ did: DID, cid, range: `bytes=${bytes.byteLength}-` });
		expect(result).toEqual({ status: "rangeNotSatisfiable", totalSize: bytes.byteLength });
	});

	it("renders a variant from a blob above the cache entry cap", async () => {
		const { fetch } = fakeFetch(() => chunkedResponse(bytes));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
			cache: new BlobCache({ maxEntryBytes: 32 }),
		});

		const thumb = await service.fetch({ did: DID, cid, variant: "thumbnail" });
		expect(thumb.status).toBe("ok");
	});

	it("rejects a blob whose declared size is above the limit", async () => {
		const { fetch } = fakeFetch(() => chunkedResponse(bytes));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
			maxBlobBytes: 32,
		});

		await expect(service.fetch({ did: DID, cid })).rejects.toMatchObject({
			name: "BlobRejectedError",
			reason: "tooLarge",
		});
	});

	it("coalesces concurrent fetches of one blob into one upstream request", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { client, callCount } = fakeSpaceClient(async () => {
			await gate;
			return new Response(bytes);
		});
		const service = new BlobService({ spaceClient: client, hosts: staticHosts() });

		const first = service.fetch({ did: DID, cid, space: SPACE });
		const second = service.fetch({ did: DID, cid, space: SPACE });
		const thumb = service.fetch({ did: DID, cid, space: SPACE, variant: "thumbnail" });
		release();

		const results = await Promise.all([first, second, thumb]);
		expect(results.map((result) => result.status)).toEqual(["ok", "ok", "ok"]);
		expect(callCount()).toBe(1);
	});

	it("never serves a cached blob across spaces without asking upstream", async () => {
		const { client, callCount } = fakeSpaceClient(() => new Response(bytes));
		const service = new BlobService({ spaceClient: client, hosts: staticHosts() });

		await service.fetch({ did: DID, cid, space: SPACE });
		await service.fetch({ did: DID, cid, space: SPACE });
		await service.fetch({ did: DID, cid, space: SPACE_B });

		expect(callCount()).toBe(2);
	});

	it("serves bytes outside the media allowlist as a download", async () => {
		const html = new TextEncoder().encode("<!doctype html><html><body>hi</body></html>");
		const htmlCid = (await cidForRawBytes(html)).toString();
		const { fetch } = fakeFetch(() => new Response(html));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
		});

		const result = await service.fetch({ did: DID, cid: htmlCid });
		expect(result).toMatchObject({ status: "ok", mimeType: "application/octet-stream" });

		await expect(
			service.fetch({ did: DID, cid: htmlCid, variant: "thumbnail" }),
		).rejects.toMatchObject({ name: "BlobRejectedError", reason: "mimeNotAllowed" });
	});

	it("streams a large non-media blob as a download", async () => {
		const blob = new Uint8Array(200).fill(7);
		const blobCid = (await cidForRawBytes(blob)).toString();
		const { fetch } = fakeFetch(() => chunkedResponse(blob));
		const service = new BlobService({
			spaceClient: {} as unknown as SpaceClient,
			hosts: staticHosts(),
			fetch,
			cache: new BlobCache({ maxEntryBytes: 32 }),
		});

		const result = await service.fetch({ did: DID, cid: blobCid });
		expect(result).toMatchObject({ status: "stream", mimeType: "application/octet-stream" });
		if (result.status === "stream") expect(joined(await drain(result.stream))).toEqual(blob);
	});
});
