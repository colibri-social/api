import dns from "node:dns";
import net from "node:net";
import { buildConnector, Client, type Dispatcher, request } from "undici";
import { notFetchable } from "./errors.js";
import { isBlockedIp } from "./net.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; ColibriBot/1.0; +https://colibri.social)";

export type ResolvedAddress = {
	address: string;
	family: 4 | 6;
};

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type GuardedFetchOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxRedirects?: number;
	maxResponseBytes?: number;
	dispatcher?: Dispatcher;
	resolveHost?: HostResolver;
	stopStreaming?: (accumulated: Buffer) => boolean;
};

export type GuardedFetchResult = {
	statusCode: number;
	headers: Record<string, string>;
	url: URL;
	body: Buffer;
	truncated: boolean;
};

const stripBrackets = (hostname: string): string =>
	hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

const assertScheme = (url: URL): void => {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw notFetchable(`unsupported scheme '${url.protocol.replace(":", "")}'`);
	}
};

const parseHttpUrl = (rawUrl: string): URL => {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch (cause) {
		throw notFetchable(`invalid url '${rawUrl}'`, cause);
	}
	assertScheme(url);
	return url;
};

export const defaultResolveHost: HostResolver = (hostname) =>
	new Promise((resolve, reject) => {
		dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(
				addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 })),
			);
		});
	});

async function resolveAndValidate(url: URL, resolveHost: HostResolver): Promise<ResolvedAddress> {
	const hostname = stripBrackets(url.hostname);
	const literalFamily = net.isIP(hostname);

	if (literalFamily !== 0) {
		if (isBlockedIp(hostname)) throw notFetchable(`blocked address '${hostname}'`);
		return { address: hostname, family: literalFamily as 4 | 6 };
	}

	let candidates: ResolvedAddress[];
	try {
		candidates = await resolveHost(hostname);
	} catch (cause) {
		throw notFetchable(`dns lookup failed for '${hostname}'`, cause);
	}

	if (candidates.length === 0) throw notFetchable(`no addresses found for '${hostname}'`);

	const blocked = candidates.find((candidate) => isBlockedIp(candidate.address));
	if (blocked)
		throw notFetchable(`'${hostname}' resolves to a blocked address (${blocked.address})`);

	const [first] = candidates;
	if (!first) throw notFetchable(`no addresses found for '${hostname}'`);
	return first;
}

function createPinnedDispatcher(url: URL, resolved: ResolvedAddress, timeoutMs: number): Client {
	const baseConnect = buildConnector({});
	const pinnedConnect: buildConnector.connector = (options, callback) => {
		baseConnect(
			{
				...options,
				hostname: resolved.address,
				host: resolved.address,
				servername: options.servername ?? options.hostname,
			},
			callback,
		);
	};

	return new Client(url.origin, {
		connect: pinnedConnect,
		connectTimeout: timeoutMs,
		headersTimeout: timeoutMs,
		bodyTimeout: timeoutMs,
	});
}

const isRedirectStatus = (statusCode: number): boolean => statusCode >= 300 && statusCode < 400;

const firstHeaderValue = (value: string | string[] | undefined): string | undefined =>
	Array.isArray(value) ? value[0] : value;

function flattenHeaders(headers: Dispatcher.ResponseData["headers"]): Record<string, string> {
	const flat: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const single = firstHeaderValue(value);
		if (single !== undefined) flat[key] = single;
	}
	return flat;
}

type BodyStream = Dispatcher.ResponseData["body"];

async function readCapped(
	body: BodyStream,
	maxBytes: number,
	stopStreaming?: (accumulated: Buffer) => boolean,
): Promise<{ buffer: Buffer; truncated: boolean }> {
	if (maxBytes <= 0) {
		body.destroy();
		return { buffer: Buffer.alloc(0), truncated: true };
	}

	const chunks: Buffer[] = [];
	let total = 0;

	for await (const rawChunk of body) {
		const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
		const remaining = maxBytes - total;
		const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
		chunks.push(slice);
		total += slice.length;

		if (slice.length < chunk.length) {
			body.destroy();
			return { buffer: Buffer.concat(chunks), truncated: true };
		}

		if (stopStreaming?.(Buffer.concat(chunks))) {
			body.destroy();
			return { buffer: Buffer.concat(chunks), truncated: false };
		}
	}

	return { buffer: Buffer.concat(chunks), truncated: false };
}

function toEmbedFetchError(err: unknown): Error {
	if (err instanceof Error && err.name === "AbortError")
		return notFetchable("request timed out", err);
	return notFetchable(`upstream connection failed: ${(err as Error)?.message ?? String(err)}`, err);
}

export async function guardedFetch(
	rawUrl: string,
	options: GuardedFetchOptions = {},
): Promise<GuardedFetchResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const resolveHost = options.resolveHost ?? defaultResolveHost;

	const timeoutController = new AbortController();
	const timer = setTimeout(
		() => timeoutController.abort(notFetchable("request timed out")),
		timeoutMs,
	);

	const signal = options.signal
		? AbortSignal.any([timeoutController.signal, options.signal])
		: timeoutController.signal;

	try {
		let current = parseHttpUrl(rawUrl);

		for (let attempt = 0; attempt <= maxRedirects; attempt++) {
			assertScheme(current);
			const resolved = await resolveAndValidate(current, resolveHost);

			const ownsDispatcher = options.dispatcher === undefined;
			const dispatcher = options.dispatcher ?? createPinnedDispatcher(current, resolved, timeoutMs);

			let response: Dispatcher.ResponseData;
			try {
				response = await request(current, {
					dispatcher,
					method: (options.method ?? "GET") as Dispatcher.HttpMethod,
					headers: { "user-agent": USER_AGENT, ...options.headers },
					body: options.body,
					signal,
				});
			} catch (cause) {
				if (ownsDispatcher) await dispatcher.close().catch(() => undefined);
				throw toEmbedFetchError(cause);
			}

			if (isRedirectStatus(response.statusCode)) {
				response.body.destroy();
				if (ownsDispatcher) dispatcher.close().catch(() => undefined);

				if (attempt === maxRedirects) throw notFetchable("too many redirects");

				const location = firstHeaderValue(response.headers.location);
				if (!location) throw notFetchable("redirect response had no location header");

				try {
					current = new URL(location, current);
				} catch (cause) {
					throw notFetchable(`invalid redirect location '${location}'`, cause);
				}
				continue;
			}

			const { buffer, truncated } = await readCapped(
				response.body,
				maxResponseBytes,
				options.stopStreaming,
			);
			if (ownsDispatcher) dispatcher.close().catch(() => undefined);

			return {
				statusCode: response.statusCode,
				headers: flattenHeaders(response.headers),
				url: current,
				body: buffer,
				truncated,
			};
		}

		throw notFetchable("too many redirects");
	} finally {
		clearTimeout(timer);
	}
}

export type AssertFetchableOptions = {
	resolveHost?: HostResolver;
};

export async function assertFetchable(
	rawUrl: string,
	options: AssertFetchableOptions = {},
): Promise<URL> {
	const url = parseHttpUrl(rawUrl);
	await resolveAndValidate(url, options.resolveHost ?? defaultResolveHost);
	return url;
}
