import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_MAX_BLOB_BYTES } from "@colibri-social/blobs";
import type { Logger } from "../logger.js";
import { POLYFILL_BLOB_MAX_BYTES } from "../polyfill/blobs.js";
import {
	type ForwardAnswer,
	type Forwarder,
	ForwardUnreachable,
	notManagingAppOf,
} from "./forward.js";
import { ACTING_FOR_HEADER, FORWARDED_HEADER } from "./inbound.js";
import type { SpaceHost, SpaceHostResolver } from "./resolve-host.js";
import { routeOf, spaceAuthority } from "./route-table.js";

export const JSON_BODY_LIMIT = 1_000_000;
export const BLOB_BODY_LIMIT = 20 * 1024 * 1024;

const BODY_LIMITS: Readonly<Record<string, number>> = {
	"social.colibri.beta.polyfill.uploadBlob": POLYFILL_BLOB_MAX_BYTES,
};

const bodyLimitOf = (nsid: string): number => {
	return BODY_LIMITS[nsid] ?? BLOB_BODY_LIMIT;
};

const ANSWER_LIMITS: Readonly<Record<string, number>> = {
	"social.colibri.beta.polyfill.getBlob": POLYFILL_BLOB_MAX_BYTES,
	"social.colibri.beta.blob.get": DEFAULT_MAX_BLOB_BYTES,
};

export type BufferedRequest = IncomingMessage & {
	body?: unknown;
	rawBody?: Buffer;
	_body?: boolean;
};

export type RouterDeps = {
	enabled: boolean;
	self: readonly string[];
	localManagingApp: (authority: string) => Promise<string | null | undefined>;
	hosts: Pick<SpaceHostResolver, "resolve" | "forget">;
	forward: Forwarder;
	verifyUser: (token: string, lxm: string) => Promise<string>;
	log: Pick<Logger, "warn">;
};

type RemoteHost = Extract<SpaceHost, { local: false }>;

class BodyTooLarge extends Error {}

const nsidOf = (url: string | undefined): string | null => {
	const match = /^\/xrpc\/([^?/]+)/.exec(url ?? "");

	return match?.[1] ?? null;
};

const bearer = (request: IncomingMessage): string | null => {
	const value = request.headers.authorization;

	return typeof value === "string" && value.startsWith("Bearer ")
		? value.slice("Bearer ".length)
		: null;
};

const isJson = (request: IncomingMessage): boolean => {
	return (request.headers["content-type"] ?? "").split(";")[0]?.trim() === "application/json";
};

export const bufferBody = async (request: BufferedRequest, limit: number): Promise<Buffer> => {
	if (request.rawBody) return request.rawBody;

	const declared = Number(request.headers["content-length"]);

	if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();

	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of request) {
		size += (chunk as Buffer).length;

		if (size > limit) throw new BodyTooLarge();

		chunks.push(chunk as Buffer);
	}

	request.rawBody = Buffer.concat(chunks);

	return request.rawBody;
};

const readJsonBody = async (request: BufferedRequest): Promise<unknown> => {
	const raw = await bufferBody(request, JSON_BODY_LIMIT);

	try {
		request.body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
	} catch {
		request.body = undefined;
	}

	request._body = true;

	return request.body;
};

const reply = (response: ServerResponse, status: number, body: Record<string, unknown>) => {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(body));
};

const relay = (response: ServerResponse, answer: ForwardAnswer) => {
	response.statusCode = answer.status;

	for (const [name, value] of Object.entries(answer.headers)) response.setHeader(name, value);

	response.end(answer.body);
};

export const createFederationRouter = (deps: RouterDeps) => {
	const remoteHost = async (authority: string): Promise<RemoteHost | undefined> => {
		const host = await deps.hosts.resolve(authority);

		return host && !host.local ? host : undefined;
	};

	const route = async (
		request: BufferedRequest,
		response: ServerResponse,
		next: (error?: unknown) => void,
	): Promise<void> => {
		const nsid = nsidOf(request.url);
		const routed = nsid ? routeOf(nsid) : undefined;

		if (!nsid || !routed || routed === "local") return next();

		const forwarded =
			request.headers[FORWARDED_HEADER] !== undefined ||
			request.headers[ACTING_FOR_HEADER] !== undefined;

		if (forwarded && !deps.enabled) {
			return reply(response, 403, {
				error: "FederationDisabled",
				message: "this AppView doesn't federate",
			});
		}

		const query = new URL(request.url ?? "/", "http://appview.invalid").searchParams;
		const needsBody =
			request.method === "POST" && isJson(request) && !spaceAuthority(routed, query, undefined);
		const body = needsBody ? await readJsonBody(request) : undefined;
		const authority = spaceAuthority(routed, query, body);

		if (!authority) return next();

		if (!deps.enabled) {
			const managingApp = await deps.localManagingApp(authority);

			if (!managingApp || deps.self.includes(managingApp)) return next();

			return reply(response, 403, {
				error: "FederationDisabled",
				message: "this AppView doesn't reach communities on other AppViews",
			});
		}

		let host: RemoteHost | undefined;

		try {
			host = await remoteHost(authority);
		} catch (error) {
			deps.log.warn({ community: authority, err: error }, "federation.hostLookupFailed");

			if (forwarded) return next();

			return reply(response, 502, {
				error: "UpstreamFailure",
				message: "couldn't find the AppView that manages this community",
			});
		}

		if (!host) return next();

		if (forwarded) {
			return reply(response, 400, {
				error: "NotManagingApp",
				message: "another AppView manages this community",
				managingApp: host.managingApp,
			});
		}

		const token = bearer(request);
		let actingFor: string | undefined;

		if (token) {
			try {
				actingFor = await deps.verifyUser(token, nsid);
			} catch (error) {
				return reply(response, 401, {
					error: "AuthRequired",
					message: error instanceof Error ? error.message : "service auth could not be verified",
				});
			}
		}

		const payload =
			request.method === "POST" ? await bufferBody(request, bodyLimitOf(nsid)) : undefined;
		const forward = {
			method: request.method ?? "GET",
			path: request.url ?? "/",
			nsid,
			headers: request.headers,
			body: payload,
			actingFor,
			maxResponseBytes: ANSWER_LIMITS[nsid],
		};

		let answer = await deps.forward(host, forward);

		if (notManagingAppOf(answer) !== null) {
			await deps.hosts.forget(authority);

			const moved = await remoteHost(authority);

			if (moved && moved.managingApp !== host.managingApp) {
				answer = await deps.forward(moved, forward);
			}
		}

		relay(response, answer);
	};

	return (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
		route(request, response, next).catch((error: unknown) => {
			if (error instanceof BodyTooLarge) {
				return reply(response, 413, {
					error: "PayloadTooLarge",
					message: "request body too large",
				});
			}

			if (error instanceof ForwardUnreachable) {
				return reply(response, 502, {
					error: "UpstreamFailure",
					message: `the AppView that manages this community didn't answer`,
				});
			}

			next(error);
		});
	};
};
