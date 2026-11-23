import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ColibriClient } from "./client.js";

const readOnly = () => {
	return Response.json(
		{ error: "ReadOnly", message: "Colibri can't save changes right now." },
		{ status: 503 },
	);
};

const clientWith = (answers: (() => Response)[]) => {
	const fetcher = vi.fn(async () => (answers.shift() ?? (() => Response.json({})))());
	const client = new ColibriClient({
		appviewUrl: "https://spaces-api.colibri.test",
		appviewDid: "did:web:spaces-api.colibri.test",
		signer: { did: "did:plc:bridge", token: async () => "token" },
		fetch: fetcher as typeof fetch,
		readOnlyWaitMs: 60_000,
		readOnlyRetryMs: 10_000,
	});

	return { client, fetcher };
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ColibriClient writes", () => {
	it("holds writes while the network is read-only and sends them once it takes writes", async () => {
		const { client, fetcher } = clientWith([]);

		client.setWriteMode("readOnly");

		const write = client.procedure("social.colibri.beta.bridge.leave", {});

		await vi.advanceTimersByTimeAsync(30_000);

		expect(fetcher).not.toHaveBeenCalled();

		client.setWriteMode("normal");

		await expect(write).resolves.toEqual({});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("sends a held write after the longest wait", async () => {
		const { client, fetcher } = clientWith([]);

		client.setWriteMode("readOnly");

		const write = client.procedure("social.colibri.beta.bridge.leave", {});

		await vi.advanceTimersByTimeAsync(60_000);

		await expect(write).resolves.toEqual({});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("sends writes right away while queued", async () => {
		const { client, fetcher } = clientWith([]);

		client.setWriteMode("queued");

		await expect(client.procedure("social.colibri.beta.bridge.leave", {})).resolves.toEqual({});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("retries a write the node refused as read-only once", async () => {
		const { client, fetcher } = clientWith([readOnly]);

		const write = client.procedure("social.colibri.beta.bridge.leave", {});

		await vi.advanceTimersByTimeAsync(9_999);

		expect(fetcher).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);

		await expect(write).resolves.toEqual({});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("gives up after the retry is refused too", async () => {
		const { client } = clientWith([readOnly, readOnly]);

		const write = client.procedure("social.colibri.beta.bridge.leave", {});
		const outcome = expect(write).rejects.toMatchObject({ error: "ReadOnly", status: 503 });

		await vi.advanceTimersByTimeAsync(10_000);
		await outcome;
	});
});

describe("ColibriClient channels", () => {
	it("lists a registration's channels", async () => {
		const channel = {
			space: "at://did:plc:community/space/social.colibri.beta.channel.text/general",
			type: "social.colibri.beta.channel.text",
			name: "general",
			viewer: { canRead: true, canPost: true },
		};
		const { client, fetcher } = clientWith([() => Response.json({ channels: [channel] })]);

		await expect(
			client.listChannels({ community: "did:plc:community", registration: "3lkbridgeaaaa" }),
		).resolves.toEqual([channel]);

		const [url] = fetcher.mock.calls[0] as unknown as [URL];

		expect(url.pathname).toBe("/xrpc/social.colibri.beta.bridge.listChannels");
		expect(url.searchParams.get("community")).toBe("did:plc:community");
		expect(url.searchParams.get("registration")).toBe("3lkbridgeaaaa");
	});
});

describe("ColibriClient reads", () => {
	it("lists messages with paging options and returns the cursor", async () => {
		const { client, fetcher } = clientWith([
			() => Response.json({ messages: [], cursor: "older" }),
		]);

		await expect(
			client.listMessages("at://did:plc:community/space/x/general", {
				around: "3lkmsg0000001",
				limit: 9,
			}),
		).resolves.toEqual({ messages: [], cursor: "older" });

		const [url] = fetcher.mock.calls[0] as unknown as [URL];

		expect(url.pathname).toBe("/xrpc/social.colibri.beta.channel.listMessages");
		expect(url.searchParams.get("around")).toBe("3lkmsg0000001");
		expect(url.searchParams.get("limit")).toBe("9");
		expect(url.searchParams.has("reverse")).toBe(false);
		expect(url.searchParams.has("cursor")).toBe(false);
	});

	it("lists a channel's threads", async () => {
		const { client, fetcher } = clientWith([() => Response.json({ threads: [] })]);

		await expect(
			client.listThreads({ community: "did:plc:community", channel: "at://general" }),
		).resolves.toEqual({ threads: [] });

		const [url] = fetcher.mock.calls[0] as unknown as [URL];

		expect(url.pathname).toBe("/xrpc/social.colibri.beta.thread.listThreads");
		expect(url.searchParams.get("channel")).toBe("at://general");
	});

	it("gets a member's standing", async () => {
		const standing = {
			did: "did:plc:member",
			member: true,
			owner: false,
			roles: [{ rkey: "3lkrole000001", name: "Mod", position: 2 }],
			permissions: ["moderation.hide"],
		};
		const { client, fetcher } = clientWith([() => Response.json(standing)]);

		await expect(
			client.getMember({
				community: "did:plc:community",
				registration: "3lkbridgeaaaa",
				did: "did:plc:member",
				channel: "at://general",
			}),
		).resolves.toEqual(standing);

		const [url] = fetcher.mock.calls[0] as unknown as [URL];

		expect(url.pathname).toBe("/xrpc/social.colibri.beta.bridge.getMember");
		expect(url.searchParams.get("did")).toBe("did:plc:member");
		expect(url.searchParams.get("channel")).toBe("at://general");
	});
});
