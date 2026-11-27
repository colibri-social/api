import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
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
	serviceAuth?: boolean;
	timeoutMs?: number;
	maxResponseBytes?: number;
};

export type ForwardAnswer = {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
};

export type ForwardDeps = {
	mint: (audience: string, lxm: string) => Promise<string>;
	allowPrivateAddresses: boolean;
	resolveHost?: (hostname: string) => Promise<string[]>;
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

export class ForwardRefused extends ForwardUnreachable {
	constructor(managingApp: string, hostname: string) {
		super(managingApp, {
			cause: new Error(`${hostname} resolves to a private address`),
		});
		this.name = "ForwardRefused";
	}
}

const PRIVATE_RANGES: ReadonlyArray<[string, number, "ipv4" | "ipv6"]> = [
	["0.0.0.0", 8, "ipv4"],
	["10.0.0.0", 8, "ipv4"],
	["100.64.0.0", 10, "ipv4"],
	["127.0.0.0", 8, "ipv4"],
	["169.254.0.0", 16, "ipv4"],
	["172.16.0.0", 12, "ipv4"],
	["192.168.0.0", 16, "ipv4"],
	["::", 128, "ipv6"],
	["::1", 128, "ipv6"],
	["fc00::", 7, "ipv6"],
	["fe80::", 10, "ipv6"],
];

const privateAddresses = new BlockList();

for (const [network, prefix, family] of PRIVATE_RANGES) {
	privateAddresses.addSubnet(network, prefix, family);
}

const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

const isPrivateAddress = (address: string): boolean => {
	const mapped = MAPPED_IPV4.exec(address)?.[1];

	if (mapped) return privateAddresses.check(mapped, "ipv4");

	const family = isIP(address);

	if (family === 0) return true;

	return privateAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
};

const resolveAll = async (hostname: string): Promise<string[]> => {
	const addresses = await lookup(hostname, { all: true, verbatim: true });

	return addresses.map((entry) => entry.address);
};

const outgoingHeaders = (
	request: ForwardRequest,
	token: string | undefined,
): Record<string, string> => {
	const headers: Record<string, string> = { [FORWARDED_HEADER]: "1" };

	for (const name of SENT_HEADERS) {
		const value = request.headers[name];

		if (typeof value === "string") headers[name] = value;
	}

	if (token) headers.authorization = `Bearer ${token}`;

	if (token && request.actingFor) headers[ACTING_FOR_HEADER] = request.actingFor;

	return headers;
};

const readLimited = async (
	response: Response,
	limit: number,
	managingApp: string,
): Promise<Buffer> => {
	const declared = Number(response.headers.get("content-length"));

	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel().catch(() => undefined);

		throw new ForwardUnreachable(managingApp, {
			cause: new Error("forwarded response too large"),
		});
	}

	let body: Buffer;

	try {
		body = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		throw new ForwardUnreachable(managingApp, { cause: error });
	}

	if (body.length > limit) {
		throw new ForwardUnreachable(managingApp, {
			cause: new Error("forwarded response too large"),
		});
	}

	return body;
};

export const createForwarder = (deps: ForwardDeps) => {
	const request = deps.fetch ?? fetch;
	const timeout = deps.timeoutMs ?? FORWARD_TIMEOUT_MS;
	const resolveHost = deps.resolveHost ?? resolveAll;

	const guard = async (target: ForwardTarget, url: URL): Promise<void> => {
		if (deps.allowPrivateAddresses) return;

		const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");

		let addresses: string[];

		try {
			addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
		} catch (error) {
			throw new ForwardUnreachable(target.managingApp, { cause: error });
		}

		if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
			throw new ForwardRefused(target.managingApp, hostname);
		}
	};

	return async (target: ForwardTarget, forward: ForwardRequest): Promise<ForwardAnswer> => {
		const url = new URL(forward.path, target.endpoint);

		await guard(target, url);

		const token =
			forward.actingFor || forward.serviceAuth
				? await deps.mint(`${target.managingApp}#colibri_appview`, forward.nsid)
				: undefined;

		let response: Response;

		try {
			response = await request(url, {
				method: forward.method,
				headers: outgoingHeaders(forward, token),
				body: forward.body && forward.body.length > 0 ? new Uint8Array(forward.body) : undefined,
				signal: AbortSignal.timeout(forward.timeoutMs ?? timeout),
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

		return {
			status: response.status,
			headers,
			body: await readLimited(
				response,
				forward.maxResponseBytes ?? FORWARD_RESPONSE_MAX_BYTES,
				target.managingApp,
			),
		};
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
