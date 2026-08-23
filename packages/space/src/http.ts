import type { DpopKey } from "./dpop.js";
import { XrpcError } from "./errors.js";

export type Auth =
	| { kind: "none" }
	| { kind: "bearer"; token: string }
	| { kind: "basic"; user: string; password: string }
	| { kind: "dpopGrant"; token: string; key: DpopKey }
	| { kind: "dpopCredential"; credential: string; key: DpopKey };

export type QueryParams = Record<
	string,
	string | number | boolean | undefined | null | Array<string | number>
>;

export type XrpcClientOptions = {
	service: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
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

export class XrpcClient {
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly timeoutMs: number;

	constructor(private readonly options: XrpcClientOptions) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 30_000;
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
		return this.send(nsid, "GET", params, undefined, auth);
	}

	private urlFor(nsid: string, params: QueryParams): string {
		const query = encodeParams(params);
		return `${this.options.service.replace(/\/$/, "")}/xrpc/${nsid}${query ? `?${query}` : ""}`;
	}

	private async headersFor(auth: Auth, method: string, url: string): Promise<Headers> {
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
			case "dpopGrant":
				headers.set("authorization", `Bearer ${auth.token}`);
				headers.set("dpop", await auth.key.proof({ method, url }));
				break;
			case "dpopCredential":
				headers.set("authorization", `DPoP ${auth.credential}`);
				headers.set("dpop", await auth.key.proof({ method, url, credential: auth.credential }));
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
	): Promise<Response> {
		const url = this.urlFor(nsid, params);
		const attempt = async (): Promise<Response> => {
			const headers = await this.headersFor(auth, method, url);
			if (body !== undefined) headers.set("content-type", "application/json");
			return this.fetchImpl(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		};

		const response = await attempt();
		if (!response.ok) throw await parseFailure(response, nsid);
		return response;
	}
}
