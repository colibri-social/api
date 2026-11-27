import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForwardRequest, ForwardTarget } from "./forward.js";
import { ForwardUnreachable } from "./forward.js";
import type { SpaceHost } from "./resolve-host.js";
import { type BufferedRequest, createFederationRouter, type RouterDeps } from "./router.js";

const LOCAL = "did:plc:localxxxxxxxxxxxxxxxxxxxxx";
const REMOTE = "did:plc:remotexxxxxxxxxxxxxxxxxxxx";
const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxx";
const THEIRS: SpaceHost = {
	local: false,
	managingApp: "did:web:other.example",
	endpoint: "https://other.example",
};
const MOVED: SpaceHost = {
	local: false,
	managingApp: "did:web:moved.example",
	endpoint: "https://moved.example",
};

let server: Server | undefined;

afterEach(async () => {
	await new Promise((resolve) => server?.close(resolve));
	server = undefined;
});

const start = async (overrides: Partial<RouterDeps> = {}) => {
	const handled: Array<{ url: string; body: unknown }> = [];
	const forwarded: Array<{ target: ForwardTarget; request: ForwardRequest }> = [];
	const deps: RouterDeps = {
		enabled: true,
		hosts: {
			resolve: vi.fn(async (authority: string) =>
				authority === REMOTE ? THEIRS : { local: true as const, managingApp: "did:web:us" },
			),
			forget: vi.fn(async () => {}),
		},
		forward: vi.fn(async (target, request) => {
			forwarded.push({ target, request });

			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: Buffer.from('{"from":"remote"}'),
			};
		}),
		verifyUser: vi.fn(async () => USER),
		log: { warn: vi.fn() },
		...overrides,
	};
	const router = createFederationRouter(deps);

	server = createServer((request, response) => {
		router(request, response, () => {
			const buffered = request as BufferedRequest;

			handled.push({ url: request.url ?? "", body: buffered.body });
			response.end("local");
		});
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));

	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return { base, deps, handled, forwarded };
};

const xrpc = (nsid: string) => `/xrpc/social.colibri.beta.${nsid}`;

describe("createFederationRouter", () => {
	it("leaves local methods and local communities to this AppView", async () => {
		const { base, handled, forwarded } = await start();

		await fetch(`${base}${xrpc("actor.listCommunities")}`);
		await fetch(`${base}${xrpc("community.getCommunity")}?community=${LOCAL}`);

		expect(handled).toHaveLength(2);
		expect(forwarded).toHaveLength(0);
	});

	it("keeps a parsed JSON body for the local handler", async () => {
		const { base, handled } = await start();

		await fetch(`${base}${xrpc("community.join")}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ community: LOCAL }),
		});

		expect(handled[0]?.body).toEqual({ community: LOCAL });
	});

	it("forwards a request about a remote community as the verified user", async () => {
		const { base, forwarded, deps } = await start();

		const response = await fetch(`${base}${xrpc("community.join")}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer user-token" },
			body: JSON.stringify({ community: REMOTE }),
		});

		expect(await response.json()).toEqual({ from: "remote" });
		expect(deps.verifyUser).toHaveBeenCalledWith(
			"user-token",
			"social.colibri.beta.community.join",
		);
		expect(forwarded[0]?.target).toBe(THEIRS);
		expect(forwarded[0]?.request).toMatchObject({
			method: "POST",
			nsid: "social.colibri.beta.community.join",
			actingFor: USER,
		});
		expect(forwarded[0]?.request.body?.toString()).toBe(JSON.stringify({ community: REMOTE }));
	});

	it("forwards an anonymous query without acting for anyone", async () => {
		const { base, forwarded } = await start();

		await fetch(`${base}${xrpc("community.getInvitation")}?code=abc&community=${REMOTE}`);

		expect(forwarded[0]?.request.actingFor).toBeUndefined();
	});

	it("refuses a token that doesn't verify before forwarding", async () => {
		const { base, forwarded } = await start({
			verifyUser: async () => {
				throw new Error("bad token");
			},
		});

		const response = await fetch(`${base}${xrpc("community.getCommunity")}?community=${REMOTE}`, {
			headers: { authorization: "Bearer nope" },
		});

		expect(response.status).toBe(401);
		expect(forwarded).toHaveLength(0);
	});

	it("answers NotManagingApp to a forwarded request it would have to forward again", async () => {
		const { base, forwarded } = await start();

		const response = await fetch(`${base}${xrpc("community.getCommunity")}?community=${REMOTE}`, {
			headers: { "colibri-forwarded": "1" },
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: "NotManagingApp",
			managingApp: "did:web:other.example",
		});
		expect(forwarded).toHaveLength(0);
	});

	it("refuses both directions when federation is off", async () => {
		const { base, forwarded } = await start({ enabled: false });

		const outbound = await fetch(`${base}${xrpc("community.getCommunity")}?community=${REMOTE}`);
		const inbound = await fetch(`${base}${xrpc("community.getCommunity")}?community=${LOCAL}`, {
			headers: { "colibri-acting-for": USER },
		});

		expect(await outbound.json()).toMatchObject({ error: "FederationDisabled" });
		expect(await inbound.json()).toMatchObject({ error: "FederationDisabled" });
		expect(forwarded).toHaveLength(0);
	});

	it("looks the community up again and retries once when it moved", async () => {
		const resolve = vi.fn().mockResolvedValueOnce(THEIRS).mockResolvedValueOnce(MOVED);
		const forward = vi
			.fn()
			.mockResolvedValueOnce({
				status: 400,
				headers: {},
				body: Buffer.from(JSON.stringify({ error: "NotManagingApp", managingApp: "x" })),
			})
			.mockResolvedValueOnce({ status: 200, headers: {}, body: Buffer.from("moved") });
		const forget = vi.fn(async () => {});
		const { base } = await start({ hosts: { resolve, forget }, forward });

		const response = await fetch(`${base}${xrpc("community.getCommunity")}?community=${REMOTE}`);

		expect(await response.text()).toBe("moved");
		expect(forget).toHaveBeenCalledWith(REMOTE);
		expect(forward.mock.calls[1]?.[0]).toBe(MOVED);
	});

	it("forwards a polyfill upload up to the polyfill's own size limit", async () => {
		const { base, forwarded } = await start();
		const space = `at:space/${REMOTE}/social.colibri.beta.channel.text/general`;
		const upload = new Uint8Array(25 * 1024 * 1024);

		const response = await fetch(
			`${base}${xrpc("polyfill.uploadBlob")}?space=${encodeURIComponent(space)}`,
			{
				method: "POST",
				headers: { "content-type": "image/png", authorization: "Bearer token" },
				body: upload,
			},
		);

		expect(response.status).toBe(200);
		expect(forwarded[0]?.request.body?.length).toBe(upload.length);
	});

	it("refuses other forwarded bodies over the general upload limit", async () => {
		const { base, forwarded } = await start();

		const response = await fetch(
			`${base}${xrpc("blob.get")}?space=${encodeURIComponent(
				`at:space/${REMOTE}/social.colibri.beta.channel.text/general`,
			)}`,
			{
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: new Uint8Array(21 * 1024 * 1024),
			},
		);

		expect(response.status).toBe(413);
		expect(forwarded).toEqual([]);
	});

	it("answers UpstreamFailure when the managing AppView doesn't answer", async () => {
		const { base } = await start({
			forward: async () => {
				throw new ForwardUnreachable("did:web:other.example");
			},
		});

		const response = await fetch(`${base}${xrpc("community.getCommunity")}?community=${REMOTE}`);

		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: "UpstreamFailure" });
	});

	it("answers UpstreamFailure when the managing AppView can't be found", async () => {
		const { base } = await start({
			hosts: {
				resolve: async () => {
					throw new Error("plc down");
				},
				forget: async () => {},
			},
		});

		const response = await fetch(`${base}${xrpc("community.getCommunity")}?community=${REMOTE}`);

		expect(response.status).toBe(502);
	});
});
