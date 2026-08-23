import type { IncomingHttpHeaders } from "node:http";

export const AUTH_SUBPROTOCOL = "colibri.auth.bearer";

const offeredProtocols = (headers: IncomingHttpHeaders): string[] => {
	const raw = headers["sec-websocket-protocol"];
	const value = Array.isArray(raw) ? raw.join(",") : raw;
	if (!value) return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
};

export const selectSubprotocol = (offered: Set<string> | string[]): string | false => {
	const values = offered instanceof Set ? [...offered] : offered;
	return values.includes(AUTH_SUBPROTOCOL) ? AUTH_SUBPROTOCOL : false;
};

export const bearerToken = (headers: IncomingHttpHeaders, url: URL): string | null => {
	const header = headers.authorization;
	if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);

	const offered = offeredProtocols(headers);
	const marker = offered.indexOf(AUTH_SUBPROTOCOL);
	if (marker !== -1 && offered[marker + 1]) return offered[marker + 1] as string;

	return url.searchParams.get("auth");
};
