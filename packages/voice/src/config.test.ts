import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import { parseIceServers, parseVoiceSfuConfig, voiceSfuConfigFromEnv } from "./config.js";

describe("parseVoiceSfuConfig", () => {
	it("applies sensible defaults matching the Rust .env.example", () => {
		const config = parseVoiceSfuConfig();

		expect(config).toEqual({
			workerCount: availableParallelism(),
			listenIp: "0.0.0.0",
			rtcMinPort: 40_000,
			rtcMaxPort: 40_100,
			iceServers: [],
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

	it("keeps a valid rtc port range", () => {
		const config = parseVoiceSfuConfig({ rtcMinPort: 40_000, rtcMaxPort: 40_100 });
		expect(config.rtcMinPort).toBe(40_000);
		expect(config.rtcMaxPort).toBe(40_100);
	});

	it("falls back to the default range when the range is inverted", () => {
		const config = parseVoiceSfuConfig({ rtcMinPort: 40_100, rtcMaxPort: 40_000 });
		expect(config.rtcMinPort).toBe(40_000);
		expect(config.rtcMaxPort).toBe(40_100);
	});

	it("fills the open end of a one sided range from the defaults", () => {
		const config = parseVoiceSfuConfig({ rtcMinPort: 40_050 });
		expect(config.rtcMinPort).toBe(40_050);
		expect(config.rtcMaxPort).toBe(40_100);
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

describe("voiceSfuConfigFromEnv", () => {
	it("reads the SFU_* variables", () => {
		const config = voiceSfuConfigFromEnv({
			SFU_WORKER_COUNT: "2",
			SFU_LISTEN_IP: "127.0.0.1",
			SFU_ANNOUNCED_IP: "203.0.113.1",
			SFU_RTC_MIN_PORT: "40000",
			SFU_RTC_MAX_PORT: "40100",
			SFU_ICE_SERVERS: JSON.stringify([{ urls: ["stun:stun.example.com"] }]),
		});

		expect(config).toEqual({
			workerCount: 2,
			listenIp: "127.0.0.1",
			announcedIp: "203.0.113.1",
			rtcMinPort: 40_000,
			rtcMaxPort: 40_100,
			iceServers: [{ urls: ["stun:stun.example.com"] }],
			roomGraceMs: 30_000,
			speakingDebounceMs: 1_000,
		});
	});

	it("falls back to defaults when the env is empty", () => {
		const config = voiceSfuConfigFromEnv({});
		expect(config.listenIp).toBe("0.0.0.0");
		expect(config.announcedIp).toBeUndefined();
		expect(config.workerCount).toBe(availableParallelism());
	});

	it("carries the default port range when the env names no range", () => {
		const config = voiceSfuConfigFromEnv({ SFU_ANNOUNCED_IP: "203.0.113.1" });
		expect(config.rtcMinPort).toBe(40_000);
		expect(config.rtcMaxPort).toBe(40_100);
	});

	it("ignores a garbage worker count instead of throwing", () => {
		const config = voiceSfuConfigFromEnv({ SFU_WORKER_COUNT: "not-a-number" });
		expect(config.workerCount).toBe(availableParallelism());
	});
});
