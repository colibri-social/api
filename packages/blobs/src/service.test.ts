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
const SPACE = "at://did:plc:2hnjxkqm6bpuvvpjbztkxxxx/social.colibri.channel.text/3lkabcdefgh2k";

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
});
