import type { DidString } from "@atproto/syntax";
import { XrpcError } from "./errors.js";
import type { SpaceKey } from "./space-key.js";

export type Auth =
	| { kind: "none" }
	| { kind: "bearer"; token: string }
	| { kind: "basic"; user: string; password: string }
	| { kind: "spaceGrant"; token: string; key: SpaceKey }
	| { kind: "spaceCredential"; credential: string; key: SpaceKey; audience: DidString };

export type QueryParams = Record<
	string,
	string | number | boolean | undefined | null | Array<string | number>
>;

export type XrpcClientOptions = {
	service: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	idleTimeoutMs?: number;
	userAgent?: string;
};

const encodeParams = (params: QueryParams): string => {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const entry of value) search.append(key, String(entry));
			continue;
		}
		search.append(key, String(value));
	}
	return search.toString();
};

const parseFailure = async (response: Response, method: string): Promise<XrpcError> => {
	const body = await response.text().catch(() => "");
	let code = response.status === 401 ? "AuthRequired" : "UpstreamFailure";
	let message = body || response.statusText;
	try {
		const parsed = JSON.parse(body) as { error?: string; message?: string };
		if (parsed.error) code = parsed.error;
		if (parsed.message) message = parsed.message;
	} catch {}
	return new XrpcError(response.status, code, message, method);
};

const idleTimeoutError = (method: string) =>
	new XrpcError(504, "UpstreamTimeout", "the upstream body stalled", method);

const withIdleTimeout = (
	body: ReadableStream<Uint8Array>,
	controller: AbortController,
	idleMs: number,
	method: string,
): ReadableStream<Uint8Array> => {
	const reader = body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stalled = false;
	const stop = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
	return new ReadableStream<Uint8Array>({
		async pull(out) {
			timer = setTimeout(() => {
				stalled = true;
				controller.abort(idleTimeoutError(method));
				void reader.cancel().catch(() => undefined);
			}, idleMs);
			try {
				const { done, value } = await reader.read();
				stop();
				if (stalled) out.error(idleTimeoutError(method));
				else if (done) out.close();
				else out.enqueue(value);
			} catch (error) {
				stop();
				out.error(stalled ? idleTimeoutError(method) : error);
			}
		},
		async cancel(reason) {
			stop();
			await reader.cancel(reason).catch(() => undefined);
		},
	});
};

const setAll = (headers: Headers, values: Record<string, string>): void => {
	for (const [name, value] of Object.entries(values)) headers.set(name, value);
};

export class XrpcClient {
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly timeoutMs: number;
	private readonly idleTimeoutMs: number;

	constructor(private readonly options: XrpcClientOptions) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
	}

	get service(): string {
		return this.options.service;
	}

	async query<T>(
		nsid: string,
		params: QueryParams = {},
		auth: Auth = { kind: "none" },
	): Promise<T> {
		const response = await this.send(nsid, "GET", params, undefined, auth);
		return (await response.json()) as T;
	}

	async procedure<T>(
		nsid: string,
		body: unknown = undefined,
		auth: Auth = { kind: "none" },
	): Promise<T> {
		const response = await this.send(nsid, "POST", {}, body, auth);
		if (response.status === 204) return undefined as T;
		const text = await response.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	async stream(
		nsid: string,
		params: QueryParams = {},
		auth: Auth = { kind: "none" },
	): Promise<Response> {
		const controller = new AbortController();
		const headersTimer = setTimeout(
			() => controller.abort(new DOMException("headers timed out", "TimeoutError")),
			this.timeoutMs,
		);
		let response: Response;
		try {
			response = await this.send(nsid, "GET", params, undefined, auth, controller.signal);
		} finally {
			clearTimeout(headersTimer);
		}
		if (!response.body) return response;
		return new Response(withIdleTimeout(response.body, controller, this.idleTimeoutMs, nsid), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	private urlFor(nsid: string, params: QueryParams): string {
		const query = encodeParams(params);
		return `${this.options.service.replace(/\/$/, "")}/xrpc/${nsid}${query ? `?${query}` : ""}`;
	}

	private async headersFor(auth: Auth): Promise<Headers> {
		const headers = new Headers({ accept: "application/json" });
		if (this.options.userAgent) headers.set("user-agent", this.options.userAgent);

		switch (auth.kind) {
			case "none":
				break;
			case "bearer":
				headers.set("authorization", `Bearer ${auth.token}`);
				break;
			case "basic":
				headers.set(
					"authorization",
					`Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}`,
				);
				break;
			case "spaceGrant":
				setAll(headers, await auth.key.headers({ authorization: `Bearer ${auth.token}` }));
				break;
			case "spaceCredential":
				setAll(
					headers,
					await auth.key.headers({
						authorization: `Atproto-Space ${auth.credential}`,
						audience: auth.audience,
					}),
				);
				break;
		}
		return headers;
	}

	private async send(
		nsid: string,
		method: "GET" | "POST",
		params: QueryParams,
		body: unknown,
		auth: Auth,
		signal: AbortSignal = AbortSignal.timeout(this.timeoutMs),
	): Promise<Response> {
		const url = this.urlFor(nsid, params);
		const attempt = async (): Promise<Response> => {
			const headers = await this.headersFor(auth);
			if (body !== undefined) headers.set("content-type", "application/json");
			return this.fetchImpl(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			});
		};

		const response = await attempt();
		if (!response.ok) throw await parseFailure(response, nsid);
		return response;
	}
}
