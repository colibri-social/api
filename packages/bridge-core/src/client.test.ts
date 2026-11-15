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
