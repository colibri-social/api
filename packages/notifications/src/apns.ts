import { createHash, createPrivateKey, type KeyObject, sign } from "node:crypto";
import { type ClientHttp2Session, connect, constants } from "node:http2";
import type { ApnsConfig } from "./config.js";
import type { PushPayload, PushSender } from "./push.js";

export type ApnsHosts = { production: string; sandbox: string };

export const APNS_HOSTS: ApnsHosts = {
	production: "https://api.push.apple.com",
	sandbox: "https://api.sandbox.push.apple.com",
};

export type ApnsSenderOptions = {
	hosts?: ApnsHosts;
	now?: () => number;
	timeoutMs?: number;
};

export type ApnsSender = PushSender & { close: () => void };

type ApnsResponse = { status: number; reason?: string };

const PROVIDER_TOKEN_LIFETIME_MS = 50 * 60 * 1000;
const GONE_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const STALE_TOKEN_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);
const MAX_COLLAPSE_ID_BYTES = 64;
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

export const signProviderToken = (
	key: KeyObject,
	keyId: string,
	teamId: string,
	issuedAtMs: number,
): string => {
	const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
	const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(issuedAtMs / 1000) }));
	const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
		key,
		dsaEncoding: "ieee-p1363",
	});
	return `${header}.${claims}.${base64url(signature)}`;
};

export const apnsCollapseId = (tag: string): string =>
	Buffer.byteLength(tag) <= MAX_COLLAPSE_ID_BYTES
		? tag
		: createHash("sha256").update(tag).digest("hex");

export const isApnsDeviceToken = (token: string): boolean => DEVICE_TOKEN.test(token);

export const apnsBody = (payload: PushPayload): Record<string, unknown> => {
	const sender = payload.data.authorName;
	const subtitle = sender && payload.kind !== "message" ? payload.title : undefined;
	return {
		aps: {
			alert: {
				title: sender ?? payload.title,
				...(subtitle ? { subtitle } : {}),
				body: payload.body,
			},
			sound: "default",
			"thread-id": payload.data.channelUri ?? payload.data.channel,
			"mutable-content": 1,
			"interruption-level": payload.kind === "mention" ? "time-sensitive" : "active",
		},
		...payload.data,
		tag: payload.tag,
	};
};

const request = (
	session: ClientHttp2Session,
	headers: Record<string, string>,
	body: string,
	timeoutMs: number,
): Promise<ApnsResponse> =>
	new Promise((resolve, reject) => {
		const stream = session.request({
			[constants.HTTP2_HEADER_METHOD]: "POST",
			...headers,
		});
		let status = 0;
		let data = "";
		stream.setEncoding("utf8");
		stream.setTimeout(timeoutMs, () => {
			stream.close(constants.NGHTTP2_CANCEL);
			reject(new Error("apns request timed out"));
		});
		stream.on("response", (responseHeaders) => {
			status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS]);
		});
		stream.on("data", (chunk: string) => {
			data += chunk;
		});
		stream.on("end", () => {
			let reason: string | undefined;
			try {
				reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
			} catch {
				reason = undefined;
			}
			resolve({ status, ...(reason ? { reason } : {}) });
		});
		stream.on("error", reject);
		stream.end(body);
	});

export const apnsSender = (
	credentials: ApnsConfig,
	options: ApnsSenderOptions = {},
): ApnsSender => {
	const hosts = options.hosts ?? APNS_HOSTS;
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? 10_000;
	const key = createPrivateKey(credentials.key);
	const sessions = new Map<string, ClientHttp2Session>();
	const inFlight = new Map<ClientHttp2Session, number>();

	const hold = (session: ClientHttp2Session): void => {
		inFlight.set(session, (inFlight.get(session) ?? 0) + 1);
		session.ref();
	};

	const release = (session: ClientHttp2Session): void => {
		const remaining = (inFlight.get(session) ?? 1) - 1;
		if (remaining > 0) {
			inFlight.set(session, remaining);
			return;
		}
		inFlight.delete(session);
		if (!session.destroyed) session.unref();
	};
	let providerToken: { value: string; issuedAt: number } | undefined;

	const currentProviderToken = (): string => {
		const at = now();
		if (!providerToken || at - providerToken.issuedAt >= PROVIDER_TOKEN_LIFETIME_MS) {
			providerToken = {
				value: signProviderToken(key, credentials.keyId, credentials.teamId, at),
				issuedAt: at,
			};
		}
		return providerToken.value;
	};

	const sessionFor = (host: string): ClientHttp2Session => {
		const existing = sessions.get(host);
		if (existing && !existing.closed && !existing.destroyed) return existing;
		const session = connect(host);
		const forget = () => {
			if (sessions.get(host) === session) sessions.delete(host);
		};
		session.on("close", forget);
		session.on("goaway", forget);
		session.on("error", forget);
		session.unref();
		sessions.set(host, session);
		return session;
	};

	return {
		send: async (subscription, payload) => {
			if (!subscription.token) return "failed";
			const host = subscription.environment === "sandbox" ? hosts.sandbox : hosts.production;
			const session = sessionFor(host);
			hold(session);
			try {
				const response = await request(
					session,
					{
						[constants.HTTP2_HEADER_PATH]: `/3/device/${subscription.token}`,
						authorization: `bearer ${currentProviderToken()}`,
						"apns-push-type": "alert",
						"apns-topic": credentials.topic,
						"apns-priority": "10",
						"apns-collapse-id": apnsCollapseId(payload.tag),
						"content-type": "application/json",
					},
					JSON.stringify(apnsBody(payload)),
					timeoutMs,
				);
				if (response.status === 200) return "delivered";
				if (response.status === 410) return "gone";
				if (response.reason && GONE_REASONS.has(response.reason)) return "gone";
				if (response.reason && STALE_TOKEN_REASONS.has(response.reason)) providerToken = undefined;
				return "failed";
			} catch {
				return "failed";
			} finally {
				release(session);
			}
		},
		close: () => {
			for (const session of sessions.values()) session.close();
			sessions.clear();
		},
	};
};
