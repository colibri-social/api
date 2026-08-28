import { MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageMeasurer, proxyableImageType } from "./image.js";

const PNG_40X24_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAACgAAAAYCAIAAAAH5iiXAAAAJklEQVR4nO3NsQ0AAAwCIP9/ur3CuJCwk0smNqtYLBaLxWKxWFzxwKS8buYblL4AAAAASUVORK5CYII=";

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

const pngHeaderDecoder = async (bytes: Uint8Array) => {
	const view = Buffer.from(bytes);
	if (view.length < 24 || view.toString("latin1", 12, 16) !== "IHDR") return null;
	return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
};

describe("proxyableImageType", () => {
	it("accepts a content type with parameters", () => {
		expect(proxyableImageType("IMAGE/JPEG; charset=binary")).toBe("image/jpeg");
	});

	it("rejects a type it will not proxy", () => {
		expect(proxyableImageType("image/svg+xml")).toBeUndefined();
		expect(proxyableImageType(undefined)).toBeUndefined();
	});
});

describe("createImageMeasurer", () => {
	const serve = (
		mockAgent: MockAgent,
		statusCode: number,
		body: string | Buffer,
		contentType?: string,
	) => {
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/card.png", method: "GET" })
			.reply(statusCode, body, contentType ? { headers: { "content-type": contentType } } : {});
	};

	it("reads the intrinsic size of an image the page never sized", async () => {
		const mockAgent = newMockAgent();
		serve(mockAgent, 200, Buffer.from(PNG_40X24_BASE64, "base64"), "image/png");

		const measure = createImageMeasurer({ decode: pngHeaderDecoder, dispatcher: mockAgent });
		await expect(measure("http://93.184.216.34/card.png")).resolves.toEqual({
			width: 40,
			height: 24,
		});
	});

	it("gives up on a response that is not an image", async () => {
		const mockAgent = newMockAgent();
		serve(mockAgent, 200, "<html>nope</html>", "text/html");
		const onMiss = vi.fn();

		const measure = createImageMeasurer({
			decode: pngHeaderDecoder,
			dispatcher: mockAgent,
			onMiss,
		});
		await expect(measure("http://93.184.216.34/card.png")).resolves.toBeUndefined();
		expect(onMiss).toHaveBeenCalledWith("the origin served text/html");
	});

	it("gives up when the origin answers with an error", async () => {
		const mockAgent = newMockAgent();
		serve(mockAgent, 404, "gone");
		const onMiss = vi.fn();

		const measure = createImageMeasurer({
			decode: pngHeaderDecoder,
			dispatcher: mockAgent,
			onMiss,
		});
		await expect(measure("http://93.184.216.34/card.png")).resolves.toBeUndefined();
		expect(onMiss).toHaveBeenCalledWith("the origin answered 404");
	});

	it("gives up on bytes the decoder cannot read", async () => {
		const mockAgent = newMockAgent();
		serve(mockAgent, 200, "not really a png", "image/png");
		const onMiss = vi.fn();

		const measure = createImageMeasurer({
			decode: pngHeaderDecoder,
			dispatcher: mockAgent,
			onMiss,
		});
		await expect(measure("http://93.184.216.34/card.png")).resolves.toBeUndefined();
		expect(onMiss).toHaveBeenCalledWith("the image/png header could not be decoded");
	});

	it("stops reading once the byte cap is reached", async () => {
		const mockAgent = newMockAgent();
		const png = Buffer.from(PNG_40X24_BASE64, "base64");
		serve(mockAgent, 200, Buffer.concat([png, Buffer.alloc(4096, 7)]), "image/png");

		const decode = vi.fn(pngHeaderDecoder);
		const measure = createImageMeasurer({ decode, dispatcher: mockAgent, maxBytes: 32 });
		await expect(measure("http://93.184.216.34/card.png")).resolves.toEqual({
			width: 40,
			height: 24,
		});
		expect(decode.mock.calls[0]?.[0].byteLength).toBe(32);
	});

	it("refuses an image url that resolves to a private address", async () => {
		const onMiss = vi.fn();
		const measure = createImageMeasurer({ decode: pngHeaderDecoder, onMiss });
		await expect(measure("http://127.0.0.1/card.png")).resolves.toBeUndefined();
		expect(onMiss).toHaveBeenCalledWith("blocked address '127.0.0.1'");
	});
});
