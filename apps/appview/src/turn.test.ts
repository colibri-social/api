import { describe, expect, it, vi } from "vitest";
import { cloudflareTurn, TURN_CREDENTIAL_TTL_SECONDS, turnCredentialsFor } from "./turn.js";

const log = { warn: vi.fn() };

const respond = (status: number, body: unknown) => {
	return vi.fn(async () => new Response(JSON.stringify(body), { status }));
};

describe("cloudflareTurn", () => {
	it("mints credentials with a 24 hour lifetime and drops port 53", async () => {
		const fetch = respond(201, {
			iceServers: [
				{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
				{
					urls: [
						"turn:turn.cloudflare.com:3478?transport=udp",
						"turn:turn.cloudflare.com:53?transport=udp",
						"turns:turn.cloudflare.com:443?transport=tcp",
					],
					username: "user",
					credential: "secret",
				},
			],
		});
		const turn = cloudflareTurn({ keyId: "key", apiToken: "token", log, fetch });

		await expect(turn.iceServers()).resolves.toEqual([
			{ urls: ["stun:stun.cloudflare.com:3478"] },
			{
				urls: [
					"turn:turn.cloudflare.com:3478?transport=udp",
					"turns:turn.cloudflare.com:443?transport=tcp",
				],
				username: "user",
				credential: "secret",
			},
		]);

		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];

		expect(url).toBe(
			"https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers",
		);
		expect(init.headers).toMatchObject({ authorization: "Bearer token" });
		expect(JSON.parse(String(init.body))).toEqual({ ttl: TURN_CREDENTIAL_TTL_SECONDS });
	});

	it("returns no servers when Cloudflare refuses", async () => {
		const turn = cloudflareTurn({
			keyId: "key",
			apiToken: "token",
			log,
			fetch: respond(401, { error: "unauthorized" }),
		});

		await expect(turn.iceServers()).resolves.toEqual([]);
		expect(log.warn).toHaveBeenCalledWith({ status: 401 }, "voice.turnCredentialsFailed");
	});

	it("returns no servers when the request fails", async () => {
		const turn = cloudflareTurn({
			keyId: "key",
			apiToken: "token",
			log,
			fetch: vi.fn(async () => {
				throw new Error("offline");
			}),
		});

		await expect(turn.iceServers()).resolves.toEqual([]);
	});
});

describe("turnCredentialsFor", () => {
	it("mints nothing without both TURN settings", async () => {
		await expect(turnCredentialsFor({ TURN_KEY_ID: "key" }, log).iceServers()).resolves.toEqual([]);
	});
});
