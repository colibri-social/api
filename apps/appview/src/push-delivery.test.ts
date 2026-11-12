import { buildReadPayload, type PushSender, type Senders } from "@colibri-social/notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { count } from "./metrics.js";
import { measuredSenders } from "./push-delivery.js";

vi.mock("./metrics.js", () => ({ count: vi.fn() }));

type Subscription = Parameters<PushSender["send"]>[0];

const subscription = {} as Subscription;

const payload = buildReadPayload(
	{ channel: "at://did:plc:community/space/channel", through: "3lkmsg1" },
	0,
);

beforeEach(() => {
	vi.mocked(count).mockClear();
});

describe("measuredSenders", () => {
	it("counts each send with its provider, outcome and payload type", async () => {
		const senders: Senders = { apns: { send: async () => "gone" } };

		await expect(measuredSenders(senders).apns?.send(subscription, payload)).resolves.toBe("gone");

		expect(count).toHaveBeenCalledWith("pushDeliveries", {
			provider: "apns",
			outcome: "gone",
			type: "read",
		});
	});

	it("counts a throwing send as failed with its payload type", async () => {
		const senders: Senders = {
			fcm: {
				send: async () => {
					throw new Error("boom");
				},
			},
		};

		await expect(measuredSenders(senders).fcm?.send(subscription, payload)).rejects.toThrow("boom");

		expect(count).toHaveBeenCalledWith("pushDeliveries", {
			provider: "fcm",
			outcome: "failed",
			type: "read",
		});
	});
});
