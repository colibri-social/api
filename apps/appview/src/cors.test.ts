import type { AddressInfo } from "node:net";
import { AuthRequiredError, createServer } from "@atproto/xrpc-server";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { corsMiddleware, DEVELOPMENT_ORIGINS, parseOrigins } from "./cors.js";

const DEV_ORIGIN = "http://127.0.0.1:4321";

const REQUIRED_ENV = {
	APPVIEW_DID: "did:web:localhost%3A3000",
	PUBLIC_URL: "http://127.0.0.1:3000",
	SIGNING_KEY: "a".repeat(64),
	CREDENTIAL_ENCRYPTION_KEY: "not-checked-here",
	PDS_URL: "https://pds.example.com",
	COMMUNITY_HANDLE_DOMAIN: "communities.example.com",
};

type Captured = { status: number; headers: Record<string, string>; ended: boolean };

const call = (origins: readonly string[], method: string, origin?: string) => {
	const captured: Captured = { status: 200, headers: {}, ended: false };
	const res = {
		setHeader: (name: string, value: string) => {
			captured.headers[name.toLowerCase()] = value;
		},
		append: (name: string, value: string) => {
			captured.headers[name.toLowerCase()] = value;
		},
		status: (code: number) => {
			captured.status = code;
			return res;
		},
		end: () => {
			captured.ended = true;
			return res;
		},
	} as unknown as Response;

	let passed = false;
	const req = { method, headers: origin ? { origin } : {} } as unknown as Request;
	corsMiddleware(origins)(req, res, () => {
		passed = true;
	});

	return { ...captured, passed };
};

describe("corsMiddleware", () => {
	it("allows an origin on the list and nothing else", () => {
		const allowed = call(DEVELOPMENT_ORIGINS, "GET", DEV_ORIGIN);
		expect(allowed.headers["access-control-allow-origin"]).toBe(DEV_ORIGIN);

		const refused = call(DEVELOPMENT_ORIGINS, "GET", "https://evil.example.com");
		expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
		expect(refused.passed).toBe(true);
	});

	it("varies on origin so a cache cannot serve one origin's response to another", () => {
		expect(call(DEVELOPMENT_ORIGINS, "GET", DEV_ORIGIN).headers.vary).toBe("Origin");
		expect(call(DEVELOPMENT_ORIGINS, "GET", "https://evil.example.com").headers.vary).toBe(
			"Origin",
		);
	});

	it("reflects a wildcard for any origin, without varying", () => {
		const wide = call(["*"], "GET", "https://anywhere.example.com");
		expect(wide.headers["access-control-allow-origin"]).toBe("*");
		expect(wide.headers.vary).toBeUndefined();
	});

	it("answers a preflight without reaching the route", () => {
		const preflight = call(DEVELOPMENT_ORIGINS, "OPTIONS", DEV_ORIGIN);
		expect(preflight.status).toBe(204);
		expect(preflight.ended).toBe(true);
		expect(preflight.passed).toBe(false);
	});

	it("permits the headers an authenticated XRPC call sends", () => {
		const allowed = call(DEVELOPMENT_ORIGINS, "OPTIONS", DEV_ORIGIN).headers[
			"access-control-allow-headers"
		];
		expect(allowed).toContain("authorization");
		expect(allowed).toContain("atproto-proxy");
		expect(allowed).toContain("content-type");
	});

	it("allows no origin at all when the list is empty", () => {
		expect(call([], "GET", DEV_ORIGIN).headers["access-control-allow-origin"]).toBeUndefined();
	});
});

describe("parseOrigins", () => {
	it("splits a comma-separated list and drops a trailing slash", () => {
		expect(parseOrigins("https://a.test, https://b.test/")).toEqual([
			"https://a.test",
			"https://b.test",
		]);
	});

	it("treats an empty value as no origins", () => {
		expect(parseOrigins(undefined)).toEqual([]);
		expect(parseOrigins(" , ")).toEqual([]);
	});
});

describe("CORS_ORIGINS", () => {
	it("covers the dev client out of the box, and nothing in production", () => {
		expect(loadConfig({ ...REQUIRED_ENV }).corsOrigins).toEqual(DEVELOPMENT_ORIGINS);
		expect(loadConfig({ ...REQUIRED_ENV, NODE_ENV: "production" }).corsOrigins).toEqual([]);
	});

	it("replaces the default rather than adding to it", () => {
		const config = loadConfig({ ...REQUIRED_ENV, CORS_ORIGINS: "https://app.example.com" });
		expect(config.corsOrigins).toEqual(["https://app.example.com"]);
	});
});

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
	await close?.();
	close = null;
});

const serveLikeTheAppView = async () => {
	const server = createServer(undefined, { catchall: undefined });
	const app = server.routes;
	app.use(corsMiddleware(DEVELOPMENT_ORIGINS));

	app.get("/xrpc/test.refuses", (_req, _res, next) => {
		next(new AuthRequiredError("no token", "AuthRequired"));
	});
	app.get("/xrpc/test.mountedLate", (_req: Request, res: Response) => {
		res.json({ reached: true });
	});

	const http = server.router.listen(0);
	await new Promise((resolve) => http.once("listening", resolve));
	close = () => new Promise<void>((resolve) => http.close(() => resolve()));

	const { port } = http.address() as AddressInfo;
	return (path: string, init?: RequestInit) =>
		fetch(`http://127.0.0.1:${port}${path}`, { headers: { origin: DEV_ORIGIN }, ...init });
};

describe("the middleware order createAppServer builds", () => {
	it("puts the header on an error response, not only on a success", async () => {
		const request = await serveLikeTheAppView();
		const response = await request("/xrpc/test.refuses");

		expect(response.status).toBe(401);
		expect(response.headers.get("access-control-allow-origin")).toBe(DEV_ORIGIN);
		expect(await response.json()).toMatchObject({ error: "AuthRequired" });
	});

	it("answers a preflight instead of letting the catchall reject the method", async () => {
		const request = await serveLikeTheAppView();
		const response = await request("/xrpc/test.refuses", {
			method: "OPTIONS",
			headers: { origin: DEV_ORIGIN, "access-control-request-method": "GET" },
		});

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(DEV_ORIGIN);
		expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
	});

	it("reaches a route mounted after the XRPC ones, which the catchall would otherwise shadow", async () => {
		const request = await serveLikeTheAppView();
		const response = await request("/xrpc/test.mountedLate");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ reached: true });
	});
});
