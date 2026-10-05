import { generateKeyPairSync, verify } from "node:crypto";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ApnsSender,
	apnsBody,
	apnsCollapseId,
	apnsSender,
	isApnsDeviceToken,
} from "./apns.js";
import type { PushPayload } from "./push.js";
import type { PushSubscriptionRow } from "./subscriptions.js";

const TOKEN = "a".repeat(64);

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type Received = { headers: IncomingHttpHeaders; body: string };
type Reply = { status: number; reason?: string };

const startServer = async (
	reply: () => Reply,
): Promise<{ url: string; received: Received[]; server: Http2Server }> => {
	const received: Received[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			received.push({ headers: request.headers, body });
			const { status, reason } = reply();
			response.writeHead(status, { "content-type": "application/json" });
			response.end(reason ? JSON.stringify({ reason }) : "");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, received, server };
};

const subscription = (overrides: Partial<PushSubscriptionRow> = {}): PushSubscriptionRow => ({
	id: "sub1",
	actor: "did:plc:actor",
	provider: "apns",
	platform: "ios",
	endpoint: null,
	p256dh: null,
	auth: null,
	token: TOKEN,
	environment: "production",
	createdAt: "2026-10-02T00:00:00.000Z",
	...overrides,
});

const payload: PushPayload = {
	kind: "mention",
	title: "New mention",
	body: "hello there",
	tag: "did:plc:author/3lkmsg1",
	data: {
		channel: "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel1",
		channelUri: "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel1",
		messageAuthor: "did:plc:author",
		messageRkey: "3lkmsg1",
		deepLink:
			"social.colibri:/channel/did:plc:community/social.colibri.beta.channel.text/3lkchannel1",
		authorName: "Alice",
		authorAvatarUrl: "https://appview.example/avatar.jpg",
	},
};

let production: Awaited<ReturnType<typeof startServer>>;
let sandbox: Awaited<ReturnType<typeof startServer>>;
let productionReply: Reply;
let sender: ApnsSender;

beforeEach(async () => {
	productionReply = { status: 200 };
	production = await startServer(() => productionReply);
	sandbox = await startServer(() => ({ status: 200 }));
	sender = apnsSender(
		{ key: pem, keyId: "KEY1234567", teamId: "TEAM123456", topic: "social.colibri.app" },
		{ hosts: { production: production.url, sandbox: sandbox.url } },
	);
});

afterEach(async () => {
	sender.close();
	await new Promise((resolve) => production.server.close(resolve));
	await new Promise((resolve) => sandbox.server.close(resolve));
});

describe("apnsSender", () => {
	it("posts an alert push with a signed provider token", async () => {
		expect(await sender.send(subscription(), payload)).toBe("delivered");

		const [request] = production.received;
		expect(request?.headers[":path"]).toBe(`/3/device/${TOKEN}`);
		expect(request?.headers["apns-push-type"]).toBe("alert");
		expect(request?.headers["apns-topic"]).toBe("social.colibri.app");
		expect(request?.headers["apns-priority"]).toBe("10");
		expect(request?.headers["apns-collapse-id"]).toBe(payload.tag);

		const jwt = String(request?.headers.authorization).replace(/^bearer /, "");
		const [header, claims, signature] = jwt.split(".");
		expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
			alg: "ES256",
			kid: "KEY1234567",
		});
		expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString()).iss).toBe("TEAM123456");
		expect(
			verify(
				"sha256",
				Buffer.from(`${header}.${claims}`),
				{ key: publicKey, dsaEncoding: "ieee-p1363" },
				Buffer.from(signature ?? "", "base64url"),
			),
		).toBe(true);

		expect(JSON.parse(request?.body ?? "")).toEqual(apnsBody(payload));
	});

	it("routes sandbox tokens to the sandbox host", async () => {
		await sender.send(subscription({ environment: "sandbox" }), payload);

		expect(sandbox.received).toHaveLength(1);
		expect(production.received).toHaveLength(0);
	});

	it.each([
		[{ status: 410, reason: "Unregistered" }, "gone"],
		[{ status: 400, reason: "BadDeviceToken" }, "gone"],
		[{ status: 400, reason: "DeviceTokenNotForTopic" }, "gone"],
		[{ status: 400, reason: "PayloadTooLarge" }, "failed"],
		[{ status: 429, reason: "TooManyRequests" }, "failed"],
		[{ status: 500 }, "failed"],
	] as const)("maps %o to %s", async (reply, outcome) => {
		productionReply = reply;
		expect(await sender.send(subscription(), payload)).toBe(outcome);
	});

	it("fails without a token", async () => {
		expect(await sender.send(subscription({ token: null }), payload)).toBe("failed");
		expect(production.received).toHaveLength(0);
	});
});

describe("apnsBody", () => {
	it("names the sender and marks mentions time sensitive", () => {
		expect(apnsBody(payload).aps).toEqual({
			alert: { title: "Alice", subtitle: "New mention", body: "hello there" },
			sound: "default",
			"thread-id": payload.data.channelUri,
			"mutable-content": 1,
			"interruption-level": "time-sensitive",
		});
	});

	it("drops the generic subtitle for plain messages", () => {
		const aps = apnsBody({ ...payload, kind: "message", title: "New message" }).aps as {
			alert: Record<string, string>;
			"interruption-level": string;
		};
		expect(aps.alert).toEqual({ title: "Alice", body: "hello there" });
		expect(aps["interruption-level"]).toBe("active");
	});
});

describe("apnsCollapseId", () => {
	it("hashes tags longer than 64 bytes", () => {
		expect(apnsCollapseId("short")).toBe("short");
		expect(apnsCollapseId(`did:web:${"x".repeat(80)}/3lkmsg1`)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("isApnsDeviceToken", () => {
	it("accepts hex tokens only", () => {
		expect(isApnsDeviceToken(TOKEN)).toBe(true);
		expect(isApnsDeviceToken("not-hex")).toBe(false);
	});
});
