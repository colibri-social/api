import { describe, expect, it } from "vitest";
import { keepsTransaction, skipsTracing } from "./sentry.js";

const transaction = (seconds: number, code?: number, status?: string) => {
	return {
		start_timestamp: 100,
		timestamp: 100 + seconds,
		contexts: {
			trace: {
				...(status ? { status } : {}),
				data: code === undefined ? {} : { "http.response.status_code": code },
			},
		},
	};
};

describe("skipsTracing", () => {
	it("never traces the health check", () => {
		expect(skipsTracing("GET /health")).toBe(true);
		expect(skipsTracing("GET", { "url.path": "/health" })).toBe(true);
		expect(skipsTracing("POST /xrpc/social.colibri.beta.channel.sendMessage")).toBe(false);
	});
});

describe("keepsTransaction", () => {
	it("keeps slow and failed requests and samples the rest", () => {
		expect(keepsTransaction(transaction(1.2, 200), 0.1, () => 0.99)).toBe(true);
		expect(keepsTransaction(transaction(0.05, 502), 0.1, () => 0.99)).toBe(true);
		expect(keepsTransaction(transaction(0.05, undefined, "internal_error"), 0.1, () => 0.99)).toBe(
			true,
		);
		expect(keepsTransaction(transaction(0.05, 404, "not_found"), 0.1, () => 0.99)).toBe(false);
		expect(keepsTransaction(transaction(0.05, 200), 0.1, () => 0.05)).toBe(true);
		expect(keepsTransaction(transaction(0.05, 200), 0.1, () => 0.5)).toBe(false);
	});
});
