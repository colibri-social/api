import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { AUTH_SUBPROTOCOL, bearerToken, selectSubprotocol } from "./auth.js";

const url = (query = "") => new URL(`http://appview.test/xrpc/whatever${query}`);

const headers = (values: Record<string, string>): IncomingHttpHeaders =>
	values as IncomingHttpHeaders;

describe("websocket bearer token", () => {
	it("reads the Authorization header", () => {
		expect(bearerToken(headers({ authorization: "Bearer abc" }), url())).toBe("abc");
	});

	it("reads the token from the auth subprotocol a browser can actually send", () => {
		const request = headers({ "sec-websocket-protocol": `${AUTH_SUBPROTOCOL}, abc` });
		expect(bearerToken(request, url())).toBe("abc");
	});

	it("tolerates a subprotocol list without surrounding spaces", () => {
		const request = headers({ "sec-websocket-protocol": `${AUTH_SUBPROTOCOL},abc` });
		expect(bearerToken(request, url())).toBe("abc");
	});

	it("ignores a subprotocol offer that carries no token", () => {
		const request = headers({ "sec-websocket-protocol": AUTH_SUBPROTOCOL });
		expect(bearerToken(request, url())).toBeNull();
	});

	it("ignores subprotocols that are not ours", () => {
		const request = headers({ "sec-websocket-protocol": "graphql-ws, abc" });
		expect(bearerToken(request, url())).toBeNull();
	});

	it("falls back to the query parameter", () => {
		expect(bearerToken(headers({}), url("?auth=abc"))).toBe("abc");
	});

	it("prefers the header over the query parameter", () => {
		expect(bearerToken(headers({ authorization: "Bearer header" }), url("?auth=query"))).toBe(
			"header",
		);
	});

	it("returns null when no token is offered at all", () => {
		expect(bearerToken(headers({}), url())).toBeNull();
	});
});

describe("subprotocol selection", () => {
	it("echoes our auth subprotocol so the browser handshake completes", () => {
		expect(selectSubprotocol(new Set([AUTH_SUBPROTOCOL, "some-token"]))).toBe(AUTH_SUBPROTOCOL);
	});

	it("selects nothing when the client offered none of ours", () => {
		expect(selectSubprotocol(new Set(["graphql-ws"]))).toBe(false);
		expect(selectSubprotocol(new Set())).toBe(false);
	});
});
