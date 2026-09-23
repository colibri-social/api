import type { AddressInfo } from "node:net";
import { createServer, InvalidRequestError } from "@atproto/xrpc-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { respondWithError } from "./xrpc-errors.js";

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
	await close?.();
	close = null;
	vi.restoreAllMocks();
});

const serve = async () => {
	const log = { error: vi.fn() };
	const server = createServer(undefined, { catchall: undefined });
	const app = server.routes;

	app.get("/xrpc/test.notFound", (_req, _res, next) => {
		next(new InvalidRequestError("no community exists at that identifier", "CommunityNotFound"));
	});
	app.get("/xrpc/test.crashes", (_req, _res, next) => {
		next(new Error("database went away"));
	});
	app.use(respondWithError(log));

	const http = server.router.listen(0);
	await new Promise((resolve) => http.once("listening", resolve));
	close = () => new Promise<void>((resolve) => http.close(() => resolve()));

	const { port } = http.address() as AddressInfo;
	return { log, request: (path: string) => fetch(`http://127.0.0.1:${port}${path}`) };
};

describe("respondWithError", () => {
	it("answers a client error without reaching the library's error middleware", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { log, request } = await serve();

		const response = await request("/xrpc/test.notFound");

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "CommunityNotFound",
			message: "no community exists at that identifier",
		});
		expect(consoleError).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("logs a server error once and hides its message from the client", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { log, request } = await serve();

		const response = await request("/xrpc/test.crashes");

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: "InternalServerError" });
		expect(consoleError).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalledOnce();
		expect(log.error).toHaveBeenCalledWith(
			expect.objectContaining({ status: 500, reason: "database went away" }),
			"route.unhandled",
		);
	});
});
