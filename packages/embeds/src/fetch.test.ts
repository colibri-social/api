import { Dispatcher, MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedError } from "./errors.js";
import { assertFetchable, guardedFetch } from "./fetch.js";

class FakeController implements Dispatcher.DispatchController {
	get aborted(): boolean {
		return false;
	}
	get paused(): boolean {
		return false;
	}
	get reason(): Error | null {
		return null;
	}
	abort(): void {}
	pause(): void {}
	resume(): void {}
}

class DelayedEndDispatcher extends Dispatcher {
	dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
		const controller = new FakeController();
		handler.onRequestStart?.(controller, {});
		if (options.path === "/start") {
			handler.onResponseStart?.(controller, 302, { location: "http://1.1.1.1/final" }, "Found");
			handler.onResponseData?.(controller, Buffer.from("Redirecting..."));
		} else {
			handler.onResponseStart?.(controller, 200, { "content-type": "text/plain" }, "OK");
			handler.onResponseData?.(controller, Buffer.from("hello"));
		}
		setImmediate(() => handler.onResponseEnd?.(controller, {}));
		return true;
	}

	close(): Promise<void> {
		return Promise.resolve();
	}

	destroy(): Promise<void> {
		return Promise.resolve();
	}
}

function fakeResolver(map: Record<string, string>) {
	return async (hostname: string) => {
		const address = map[hostname];
		if (!address) throw new Error(`no fake dns entry for ${hostname}`);
		return [{ address, family: 4 as const }];
	};
}

let agent: MockAgent | undefined;

afterEach(async () => {
	if (agent) {
		await agent.close();
		agent = undefined;
	}
});

function newMockAgent(): MockAgent {
	agent = new MockAgent();
	agent.disableNetConnect();
	return agent;
}

describe("assertFetchable", () => {
	it("rejects a non-http(s) scheme", async () => {
		await expect(assertFetchable("ftp://example.com/file")).rejects.toBeInstanceOf(EmbedError);
	});

	it("rejects an unparseable url", async () => {
		await expect(assertFetchable("not a url")).rejects.toMatchObject({ code: "NotFetchable" });
	});

	it("rejects a literal loopback address", async () => {
		await expect(assertFetchable("http://127.0.0.1/")).rejects.toMatchObject({
			code: "NotFetchable",
		});
	});

	it("rejects a literal private address", async () => {
		await expect(assertFetchable("http://10.0.0.5/")).rejects.toMatchObject({
			code: "NotFetchable",
		});
	});

	it("allows a literal public address", async () => {
		const url = await assertFetchable("http://93.184.216.34/page");
		expect(url.hostname).toBe("93.184.216.34");
	});

	it("rejects a hostname whose only resolved address is blocked", async () => {
		const resolveHost = fakeResolver({ "internal.test": "127.0.0.1" });
		await expect(assertFetchable("http://internal.test/", { resolveHost })).rejects.toMatchObject({
			code: "NotFetchable",
		});
	});

	it("allows a hostname that resolves to a public address", async () => {
		const resolveHost = fakeResolver({ "public.test": "8.8.8.8" });
		const url = await assertFetchable("http://public.test/", { resolveHost });
		expect(url.hostname).toBe("public.test");
	});

	it("rejects a hostname when any resolved address is blocked, even if another is public", async () => {
		const resolveHost = async (hostname: string) => {
			expect(hostname).toBe("multi.test");
			return [
				{ address: "8.8.8.8", family: 4 as const },
				{ address: "127.0.0.1", family: 4 as const },
			];
		};
		await expect(assertFetchable("http://multi.test/", { resolveHost })).rejects.toMatchObject({
			code: "NotFetchable",
		});
	});
});

describe("guardedFetch redirect handling", () => {
	it("refuses to follow a redirect from a public address to a loopback address", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/start", method: "GET" })
			.reply(302, "", { headers: { location: "http://127.0.0.1/evil" } });

		await expect(
			guardedFetch("http://93.184.216.34/start", { dispatcher: mockAgent }),
		).rejects.toMatchObject({ code: "NotFetchable" });
	});

	it("follows a redirect between two allowed public addresses", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/start", method: "GET" })
			.reply(302, "", { headers: { location: "http://1.1.1.1/final" } });
		mockAgent
			.get("http://1.1.1.1")
			.intercept({ path: "/final", method: "GET" })
			.reply(200, "hello", { headers: { "content-type": "text/plain" } });

		const result = await guardedFetch("http://93.184.216.34/start", { dispatcher: mockAgent });
		expect(result.statusCode).toBe(200);
		expect(result.url.href).toBe("http://1.1.1.1/final");
		expect(result.body.toString("utf8")).toBe("hello");
	});

	it("gives up after the redirect cap is exceeded", async () => {
		const mockAgent = newMockAgent();
		const pool = mockAgent.get("http://93.184.216.34");
		for (let i = 0; i < 10; i++) {
			pool
				.intercept({ path: `/hop${i}`, method: "GET" })
				.reply(302, "", { headers: { location: `http://93.184.216.34/hop${i + 1}` } });
		}

		await expect(
			guardedFetch("http://93.184.216.34/hop0", { dispatcher: mockAgent, maxRedirects: 2 }),
		).rejects.toMatchObject({ code: "NotFetchable" });
	});

	it("does not crash the process when a redirect response body ends after being destroyed", async () => {
		const dispatcher = new DelayedEndDispatcher();

		const onUncaught = vi.fn();
		process.once("uncaughtException", onUncaught);
		try {
			const result = await guardedFetch("http://93.184.216.34/start", { dispatcher });
			expect(result.statusCode).toBe(200);
			expect(result.body.toString("utf8")).toBe("hello");
			await new Promise((resolve) => setImmediate(resolve));
			expect(onUncaught).not.toHaveBeenCalled();
		} finally {
			process.removeListener("uncaughtException", onUncaught);
		}
	});
});

describe("guardedFetch response size cap", () => {
	it("stops reading and truncates once the cap is exceeded", async () => {
		const mockAgent = newMockAgent();
		const big = Buffer.alloc(2_000_000, "a");
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/big", method: "GET" })
			.reply(200, big);

		const result = await guardedFetch("http://93.184.216.34/big", {
			dispatcher: mockAgent,
			maxResponseBytes: 1_000_000,
		});

		expect(result.truncated).toBe(true);
		expect(result.body.length).toBe(1_000_000);
	});

	it("does not truncate a response within the cap", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/small", method: "GET" })
			.reply(200, "small body");

		const result = await guardedFetch("http://93.184.216.34/small", {
			dispatcher: mockAgent,
			maxResponseBytes: 1_000_000,
		});

		expect(result.truncated).toBe(false);
		expect(result.body.toString("utf8")).toBe("small body");
	});

	it("stops early via stopStreaming without marking the result as truncated", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/marker", method: "GET" })
			.reply(200, "before-marker-STOP-after-marker");

		const result = await guardedFetch("http://93.184.216.34/marker", {
			dispatcher: mockAgent,
			maxResponseBytes: 1_000_000,
			stopStreaming: (accumulated) => accumulated.includes("STOP"),
		});

		expect(result.truncated).toBe(false);
		expect(result.body.toString("utf8")).toContain("STOP");
	});
});
