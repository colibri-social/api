import { describe, expect, it, vi } from "vitest";
import {
	bucket,
	buildHeartbeat,
	HEARTBEAT_INTERVAL_MS,
	heartbeatDue,
	heartbeatSchema,
	nodeMajor,
	sendHeartbeat,
} from "./heartbeat.js";

const input = {
	instanceId: "6f1c7b0e-3c1f-4f7e-9b44-1a2b3c4d5e6f",
	version: "2.40.0",
	flavor: "spaces",
	roles: ["voice", "main", "api"],
	nodes: 4,
	database: "postgres 17",
	os: "linux",
	nodeVersion: "v24.19.1",
	voice: true,
	spaces: 42,
	users30d: 1_500,
	voiceMinutes1d: 10_000.4,
};

describe("bucket", () => {
	it("rounds counts into coarse ranges", () => {
		expect([0, 1, 10, 11, 100, 101, 1_000, 1_001, 10_000, 10_001].map(bucket)).toEqual([
			"0",
			"1-10",
			"1-10",
			"11-100",
			"11-100",
			"101-1k",
			"101-1k",
			"1k-10k",
			"1k-10k",
			"10k+",
		]);
	});
});

describe("buildHeartbeat", () => {
	it("keeps only coarse fields", () => {
		const heartbeat = buildHeartbeat(input);

		expect(heartbeat).toEqual({
			instanceId: input.instanceId,
			version: "2.40.0",
			flavor: "spaces",
			roles: ["api", "main", "voice"],
			nodes: "1-10",
			database: "postgres 17",
			os: "linux",
			node: "24",
			voice: true,
			spaces: "11-100",
			users30d: "1k-10k",
			voiceMinutes1d: "1k-10k",
		});
		expect(heartbeatSchema.parse(heartbeat)).toEqual(heartbeat);
		expect(nodeMajor("22.18.0")).toBe("22");
	});
});

describe("heartbeatDue", () => {
	it("sends on the first start and then once a day", () => {
		const now = new Date("2026-11-11T12:00:00Z");

		expect(heartbeatDue(null, now)).toBe(true);
		expect(heartbeatDue(new Date(now.getTime() - HEARTBEAT_INTERVAL_MS + 1), now)).toBe(false);
		expect(heartbeatDue(new Date(now.getTime() - HEARTBEAT_INTERVAL_MS), now)).toBe(true);
	});
});

describe("sendHeartbeat", () => {
	it("posts the heartbeat as JSON", async () => {
		const request = vi.fn(async () => new Response(null, { status: 204 }));

		expect(
			await sendHeartbeat("https://telemetry.test/v1/heartbeat", buildHeartbeat(input), {
				fetch: request as unknown as typeof fetch,
				userAgent: "colibri-appview/2.40.0",
			}),
		).toBe(true);

		const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];

		expect(url).toBe("https://telemetry.test/v1/heartbeat");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toMatchObject({ spaces: "11-100" });
	});

	it("reports a failure without throwing", async () => {
		const request = vi.fn(async () => {
			throw new Error("offline");
		});

		expect(
			await sendHeartbeat("https://telemetry.test", buildHeartbeat(input), {
				fetch: request as unknown as typeof fetch,
			}),
		).toBe(false);
	});
});
