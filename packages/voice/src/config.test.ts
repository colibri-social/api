import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_INITIAL_OUTGOING_BITRATE,
	parseIceServers,
	parseVoiceSfuConfig,
} from "./config.js";

describe("parseVoiceSfuConfig", () => {
	it("applies sensible defaults matching the Rust .env.example", () => {
		const config = parseVoiceSfuConfig();

		expect(config).toEqual({
			workerCount: availableParallelism(),
			listenIp: "0.0.0.0",
			rtcPort: 40_000,
			iceServers: [],
			initialAvailableOutgoingBitrate: DEFAULT_INITIAL_OUTGOING_BITRATE,
			participantsPerWorker: 20,
			roomGraceMs: 30_000,
			speakingDebounceMs: 1_000,
		});
	});

	it("keeps an explicit worker count", () => {
		const config = parseVoiceSfuConfig({ workerCount: 4 });
		expect(config.workerCount).toBe(4);
	});

	it("rejects a non positive worker count", () => {
		expect(() => parseVoiceSfuConfig({ workerCount: 0 })).toThrow();
	});

	it("keeps an explicit rtc port", () => {
		expect(parseVoiceSfuConfig({ rtcPort: 41_000 }).rtcPort).toBe(41_000);
	});

	it("rejects an rtc port outside the valid range", () => {
		expect(() => parseVoiceSfuConfig({ rtcPort: 70_000 })).toThrow();
	});

	it("keeps an explicit initial outgoing bitrate", () => {
		const config = parseVoiceSfuConfig({ initialAvailableOutgoingBitrate: 120_000 });
		expect(config.initialAvailableOutgoingBitrate).toBe(120_000);
	});

	it("rejects a non positive initial outgoing bitrate", () => {
		expect(() => parseVoiceSfuConfig({ initialAvailableOutgoingBitrate: 0 })).toThrow();
	});

	it("keeps an announced ip when given", () => {
		const config = parseVoiceSfuConfig({ announcedIp: "203.0.113.1" });
		expect(config.announcedIp).toBe("203.0.113.1");
	});
});

describe("parseIceServers", () => {
	it("returns an empty array for an unset value", () => {
		expect(parseIceServers(undefined)).toEqual([]);
		expect(parseIceServers("")).toEqual([]);
		expect(parseIceServers("   ")).toEqual([]);
	});

	it("parses a JSON array of RTCIceServer objects", () => {
		const raw = JSON.stringify([
			{ urls: ["turn:turn.example.com:3478"], username: "user", credential: "pass" },
		]);
		expect(parseIceServers(raw)).toEqual([
			{ urls: ["turn:turn.example.com:3478"], username: "user", credential: "pass" },
		]);
	});

	it("accepts a single url string", () => {
		const raw = JSON.stringify([{ urls: "stun:stun.example.com:3478" }]);
		expect(parseIceServers(raw)).toEqual([{ urls: "stun:stun.example.com:3478" }]);
	});

	it("throws on invalid JSON", () => {
		expect(() => parseIceServers("not json")).toThrow(/not valid JSON/);
	});

	it("throws when the JSON does not match the ice server shape", () => {
		expect(() => parseIceServers(JSON.stringify([{ foo: "bar" }]))).toThrow(/invalid/);
	});
});
