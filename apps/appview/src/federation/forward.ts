import type { IncomingMessage } from "node:http";
import { ACTING_FOR_HEADER, FORWARDED_HEADER } from "./inbound.js";

export const FORWARD_TIMEOUT_MS = 30_000;
export const FORWARD_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

const SENT_HEADERS = ["content-type", "content-encoding", "accept", "accept-language"];
const PASSED_BACK = [
	"content-type",
	"content-encoding",
	"cache-control",
	"ratelimit-limit",
	"ratelimit-remaining",
	"ratelimit-reset",
	"ratelimit-policy",
];

export type ForwardTarget = { managingApp: string; endpoint: string };

export type ForwardRequest = {
	method: string;
	path: string;
	nsid: string;
	headers: IncomingMessage["headers"];
	body: Buffer | undefined;
	actingFor: string | undefined;
};

export type ForwardAnswer = {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
};

export type ForwardDeps = {
	mint: (audience: string, lxm: string) => Promise<string>;
	fetch?: typeof fetch;
	timeoutMs?: number;
};

export class ForwardUnreachable extends Error {
	constructor(
		readonly managingApp: string,
		options?: ErrorOptions,
	) {
		super(`${managingApp} didn't answer`, options);
		this.name = "ForwardUnreachable";
	}
}

const outgoingHeaders = (
	request: ForwardRequest,
	token: string | undefined,
): Record<string, string> => {
	const headers: Record<string, string> = { [FORWARDED_HEADER]: "1" };

	for (const name of SENT_HEADERS) {
		const value = request.headers[name];

		if (typeof value === "string") headers[name] = value;
	}

	if (token && request.actingFor) {
		headers.authorization = `Bearer ${token}`;
		headers[ACTING_FOR_HEADER] = request.actingFor;
	}

	return headers;
};

const readLimited = async (response: Response): Promise<Buffer> => {
	const declared = Number(response.headers.get("content-length"));

	if (Number.isFinite(declared) && declared > FORWARD_RESPONSE_MAX_BYTES) {
		throw new Error("forwarded response too large");
	}

	const body = Buffer.from(await response.arrayBuffer());

	if (body.length > FORWARD_RESPONSE_MAX_BYTES) throw new Error("forwarded response too large");

	return body;
};

export const createForwarder = (deps: ForwardDeps) => {
	const request = deps.fetch ?? fetch;
	const timeout = deps.timeoutMs ?? FORWARD_TIMEOUT_MS;

	return async (target: ForwardTarget, forward: ForwardRequest): Promise<ForwardAnswer> => {
		const token = forward.actingFor
			? await deps.mint(`${target.managingApp}#colibri_appview`, forward.nsid)
			: undefined;
		const url = new URL(forward.path, target.endpoint);

		let response: Response;

		try {
			response = await request(url, {
				method: forward.method,
				headers: outgoingHeaders(forward, token),
				body: forward.body && forward.body.length > 0 ? new Uint8Array(forward.body) : undefined,
				signal: AbortSignal.timeout(timeout),
				redirect: "error",
			});
		} catch (error) {
			throw new ForwardUnreachable(target.managingApp, { cause: error });
		}

		const headers: Record<string, string> = {};

		for (const name of PASSED_BACK) {
			const value = response.headers.get(name);

			if (value !== null) headers[name] = value;
		}

		return { status: response.status, headers, body: await readLimited(response) };
	};
};

export type Forwarder = ReturnType<typeof createForwarder>;

export const notManagingAppOf = (answer: ForwardAnswer): string | null => {
	if (answer.status !== 400) return null;

	try {
		const parsed = JSON.parse(answer.body.toString("utf8")) as {
			error?: unknown;
			managingApp?: unknown;
		};

		if (parsed.error !== "NotManagingApp") return null;

		return typeof parsed.managingApp === "string" ? parsed.managingApp : "";
	} catch {
		return null;
	}
};
