import { describe, expect, it, vi } from "vitest";
import {
	createForwarder,
	ForwardRefused,
	ForwardUnreachable,
	notManagingAppOf,
} from "./forward.js";

const TARGET = { managingApp: "did:web:host.example", endpoint: "https://host.example" };
const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxx";
const NSID = "social.colibri.beta.community.join";

const request = (actingFor: string | undefined) => ({
	method: "POST",
	path: `/xrpc/${NSID}?x=1`,
	nsid: NSID,
	headers: {
		"content-type": "application/json",
		authorization: "Bearer user-token",
		cookie: "secret",
	},
	body: Buffer.from('{"community":"did:plc:x"}'),
	actingFor,
});

describe("createForwarder", () => {
	it("signs as this AppView, names the user and keeps the path and body", async () => {
		const fetch = vi.fn(async () =>
			Response.json({ ok: true }, { headers: { "cache-control": "no-store", "set-cookie": "x" } }),
		);
		const mint = vi.fn(async () => "peer-token");
		const forward = createForwarder({
			mint,
			allowPrivateAddresses: true,
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		const answer = await forward(TARGET, request(USER));

		expect(mint).toHaveBeenCalledWith("did:web:host.example#colibri_appview", NSID);

		const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];

		expect(url.toString()).toBe(`https://host.example/xrpc/${NSID}?x=1`);
		expect(init.headers).toEqual({
			"colibri-forwarded": "1",
			"content-type": "application/json",
			authorization: "Bearer peer-token",
			"colibri-acting-for": USER,
		});
		expect(Buffer.from(init.body as Uint8Array).toString()).toBe('{"community":"did:plc:x"}');
		expect(answer.status).toBe(200);
		expect(answer.headers).toEqual({
			"content-type": "application/json",
			"cache-control": "no-store",
		});
	});

	it("forwards an anonymous request without any credentials", async () => {
		const fetch = vi.fn(async () => Response.json({}));
		const mint = vi.fn(async () => "peer-token");
		const forward = createForwarder({
			mint,
			allowPrivateAddresses: true,
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		await forward(TARGET, request(undefined));

		const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];

		expect(mint).not.toHaveBeenCalled();
		expect(init.headers).not.toHaveProperty("authorization");
		expect(init.headers).not.toHaveProperty("colibri-acting-for");
	});

	it("takes a larger answer only when the request allows it", async () => {
		const large = new Uint8Array(33 * 1024 * 1024);
		const fetch = vi.fn(async () => new Response(large));
		const mint = vi.fn(async () => "peer-token");
		const forward = createForwarder({
			mint,
			allowPrivateAddresses: true,
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		await expect(forward(TARGET, request(USER))).rejects.toBeInstanceOf(ForwardUnreachable);

		const answer = await forward(TARGET, {
			...request(USER),
			maxResponseBytes: 75 * 1024 * 1024,
		});

		expect(answer.body.length).toBe(large.length);
	});

	it("reports an AppView that doesn't answer", async () => {
		const forward = createForwarder({
			mint: async () => "t",
			allowPrivateAddresses: true,
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as unknown as typeof globalThis.fetch,
		});

		await expect(forward(TARGET, request(USER))).rejects.toBeInstanceOf(ForwardUnreachable);
	});

	it("reports a body that times out while it's read as unreachable", async () => {
		const stalled = new ReadableStream({
			start: (controller) => controller.error(new DOMException("timed out", "TimeoutError")),
		});

		const forward = createForwarder({
			mint: async () => "t",
			allowPrivateAddresses: true,
			fetch: (async () => new Response(stalled)) as unknown as typeof globalThis.fetch,
		});

		await expect(forward(TARGET, request(USER))).rejects.toBeInstanceOf(ForwardUnreachable);
	});

	it.each([
		["https://127.0.0.1", []],
		["https://[::1]", []],
		["https://[fd00::1]", []],
		["https://[::ffff:10.0.0.1]", []],
		["https://169.254.169.254", []],
		["https://internal.example", ["192.168.1.10"]],
		["https://mixed.example", ["93.184.215.14", "10.1.2.3"]],
	])("refuses to reach %s", async (endpoint, addresses) => {
		const fetch = vi.fn(async () => Response.json({}));

		const forward = createForwarder({
			mint: async () => "t",
			allowPrivateAddresses: false,
			resolveHost: async () => addresses,
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		const target = {
			...TARGET,
			endpoint,
		};

		await expect(forward(target, request(USER))).rejects.toBeInstanceOf(ForwardRefused);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reaches a public address and allows private ones in development", async () => {
		const fetch = vi.fn(async () => Response.json({}));

		const strict = createForwarder({
			mint: async () => "t",
			allowPrivateAddresses: false,
			resolveHost: async () => ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		const relaxed = createForwarder({
			mint: async () => "t",
			allowPrivateAddresses: true,
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		const local = {
			...TARGET,
			endpoint: "http://127.0.0.1:2583",
		};

		await strict(TARGET, request(USER));
		await relaxed(local, request(USER));

		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

describe("notManagingAppOf", () => {
	const answer = (status: number, body: unknown) => ({
		status,
		headers: {},
		body: Buffer.from(JSON.stringify(body)),
	});

	it("reads the AppView a NotManagingApp answer points to", () => {
		expect(
			notManagingAppOf(answer(400, { error: "NotManagingApp", managingApp: "did:web:new" })),
		).toBe("did:web:new");
		expect(notManagingAppOf(answer(400, { error: "InvalidRequest" }))).toBeNull();
		expect(notManagingAppOf(answer(200, { error: "NotManagingApp" }))).toBeNull();
	});
});
