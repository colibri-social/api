import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "@atproto/xrpc-server";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { NODE_ID_HEADER } from "../cluster/protocol.js";
import { logRejectedUploads } from "./upload-log.js";

const UPLOAD_PATH = "/xrpc/social.colibri.beta.polyfill.uploadBlob";

const servers: HttpServer[] = [];

const start = async (status: number) => {
	const warnings: Array<{ fields: Record<string, unknown>; event: string }> = [];
	const log = {
		warn: (fields: Record<string, unknown>, event: string) => {
			warnings.push({ fields, event });
		},
	};
	const xrpc = createServer(undefined, {});

	xrpc.routes.use(logRejectedUploads(log as never, "stl-1"));
	xrpc.routes.post(UPLOAD_PATH, (_req: Request, res: Response) => {
		res.status(status).json({ error: "InvalidRequest", message: "The file is empty." });
	});
	xrpc.routes.post("/xrpc/a.b.c", (_req: Request, res: Response) => {
		res.status(400).json({ error: "InvalidRequest", message: "nope" });
	});

	const http = createHttpServer(xrpc.router);

	servers.push(http);

	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));

	const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

	return { url, warnings };
};

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
	);
});

describe("logRejectedUploads", () => {
	it("logs a rejected upload with its response and request headers", async () => {
		const { url, warnings } = await start(400);

		await fetch(`${url}${UPLOAD_PATH}`, {
			method: "POST",
			headers: { "content-type": "image/jpeg", [NODE_ID_HEADER]: "lau-1" },
			body: new Uint8Array(0),
		});

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.event).toBe("polyfill.uploadRejected");
		expect(warnings[0]?.fields).toMatchObject({
			status: 400,
			contentType: "image/jpeg",
			contentLength: "0",
			forwardedFrom: "lau-1",
			node: "stl-1",
		});
		expect(warnings[0]?.fields.response).toContain("The file is empty.");
	});

	it("stays quiet for successful uploads and other methods", async () => {
		const ok = await start(200);

		await fetch(`${ok.url}${UPLOAD_PATH}`, { method: "POST", body: "abc" });
		await fetch(`${ok.url}/xrpc/a.b.c`, { method: "POST", body: "abc" });

		expect(ok.warnings).toHaveLength(0);
	});
});
