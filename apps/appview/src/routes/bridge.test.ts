import { XRPCError } from "@atproto/xrpc-server";
import { BridgeError, CommunityCredentialError } from "@colibri-social/community";
import { describe, expect, it } from "vitest";
import { bridgeFailureToXrpc, registrationView } from "./bridge.js";

describe("bridgeFailureToXrpc", () => {
	it("names each failure after its lexicon error", () => {
		const error = bridgeFailureToXrpc(new BridgeError("channelNotLinked", "not linked"));

		expect(error).toBeInstanceOf(XRPCError);
		expect((error as XRPCError).customErrorName).toBe("ChannelNotLinked");
		expect((error as XRPCError).statusCode).toBe(400);
	});

	it("answers a rate limit with 429", () => {
		const error = bridgeFailureToXrpc(new BridgeError("rateLimited", "slow down"));

		expect((error as XRPCError).customErrorName).toBe("RateLimited");
		expect((error as XRPCError).statusCode).toBe(429);
	});

	it("reports unusable community credentials", () => {
		const error = bridgeFailureToXrpc(
			new CommunityCredentialError(
				"did:plc:communityxxxxxxxxxxxxxxxxxxx",
				"notProvisioned",
				"no credentials",
			),
		);

		expect((error as XRPCError).customErrorName).toBe("CredentialsUnavailable");
	});

	it("passes other errors through untouched", () => {
		const original = new Error("boom");

		expect(bridgeFailureToXrpc(original)).toBe(original);
	});
});

describe("registrationView", () => {
	it("serves links and leaves absent optional fields out", () => {
		const view = registrationView({
			community: "did:plc:communityxxxxxxxxxxxxxxxxxxx",
			id: "3lkbridgeaaaa",
			bridge: "did:plc:bridgexxxxxxxxxxxxxxxxxxxxxx",
			platform: "chat",
			remoteSpace: "server-1",
			remoteSpaceName: "Server One",
			links: [
				{
					channel:
						"at://did:plc:communityxxxxxxxxxxxxxxxxxxx/space/social.colibri.beta.channel.text/3lkchannel001",
					remoteRoom: "room-1",
					remoteName: "general",
				},
			],
			enabled: true,
			mirrorModeration: false,
			createdBy: "did:plc:adminxxxxxxxxxxxxxxxxxxxxxxx",
			createdAt: "2026-09-24T12:00:00.000Z",
			updatedAt: null,
		});

		expect(view.links).toHaveLength(1);
		expect(view.updatedAt).toBeUndefined();
		expect(view.bridgeHandle).toBeUndefined();
	});
});
