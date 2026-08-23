import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { EmbedError } from "./errors.js";
import { playableVideoType, probeVideo, videoTypeFromExtension } from "./video.js";

describe("playableVideoType", () => {
	it("recognizes mp4 and webm, ignoring parameters and case", () => {
		expect(playableVideoType("video/mp4")).toBe("video/mp4");
		expect(playableVideoType("VIDEO/WEBM; charset=binary")).toBe("video/webm");
	});

	it("rejects anything else", () => {
		expect(playableVideoType("text/html")).toBeUndefined();
		expect(playableVideoType("")).toBeUndefined();
	});
});

describe("videoTypeFromExtension", () => {
	it("classifies by file extension", () => {
		expect(videoTypeFromExtension(new URL("https://cdn.example.com/clip.mp4"))).toBe("video/mp4");
		expect(videoTypeFromExtension(new URL("https://cdn.example.com/clip.m4v"))).toBe("video/mp4");
		expect(videoTypeFromExtension(new URL("https://cdn.example.com/clip.webm"))).toBe("video/webm");
		expect(videoTypeFromExtension(new URL("https://cdn.example.com/clip"))).toBeUndefined();
	});
});

let agent: MockAgent | undefined;

afterEach(async () => {
	if (agent) {
		await agent.close();
		agent = undefined;
	}
});

function newMockAgent(): MockAgent {
	agent = new MockAgent();
	agent.disableNetConnect();
	return agent;
}

describe("probeVideo", () => {
	it("reports range support and the total length from content-range", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/clip.mp4", method: "GET" })
			.reply(206, Buffer.from([0]), {
				headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/123456" },
			});

		const probe = await probeVideo("http://93.184.216.34/clip.mp4", { dispatcher: mockAgent });
		expect(probe.contentType).toBe("video/mp4");
		expect(probe.rangeSupported).toBe(true);
		expect(probe.contentLength).toBe(123456);
	});

	it("reports no range support when the server ignores the range request", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/clip.mp4", method: "GET" })
			.reply(200, Buffer.alloc(50_000), {
				headers: { "content-type": "video/mp4", "content-length": "50000" },
			});

		const probe = await probeVideo("http://93.184.216.34/clip.mp4", { dispatcher: mockAgent });
		expect(probe.rangeSupported).toBe(false);
		expect(probe.contentLength).toBe(50_000);
	});

	it("surfaces an upstream failure for a non-success status", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/missing.mp4", method: "GET" })
			.reply(404, "not found");

		await expect(
			probeVideo("http://93.184.216.34/missing.mp4", { dispatcher: mockAgent }),
		).rejects.toBeInstanceOf(EmbedError);
	});

	it("refuses to probe a blocked address", async () => {
		await expect(probeVideo("http://127.0.0.1/clip.mp4")).rejects.toMatchObject({
			code: "NotFetchable",
		});
	});
});
