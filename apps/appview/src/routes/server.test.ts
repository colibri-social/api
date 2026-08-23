import { describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { describeServer } from "./server.js";

const contextWith = (overrides: Record<string, unknown> = {}): AppContext =>
	({
		config: {
			APPVIEW_DID: "did:web:appview.test",
			APPVIEW_FLAVOR: "vanilla",
			COMMUNITY_HANDLE_DOMAIN: "communities.test",
			PDS_URL: "https://pds.test",
			VOICE_ENABLED: false,
			pushProviders: [],
			gifsEnabled: false,
			...overrides,
		},
	}) as unknown as AppContext;

describe("describeServer", () => {
	it("identifies the software so a client can recognise a Colibri AppView", () => {
		const description = describeServer(contextWith());
		expect(description.software).toBe("colibri-appview");
		expect(description.flavor).toBe("vanilla");
		expect(description.version).not.toBe("");
	});

	it("reports the flavor a fork configured for itself", () => {
		const description = describeServer(contextWith({ APPVIEW_FLAVOR: "seibert-internal" }));
		expect(description.flavor).toBe("seibert-internal");
	});

	it("lists only the features that are actually configured", () => {
		expect(describeServer(contextWith()).features).toEqual(["embeds"]);
		expect(
			describeServer(contextWith({ VOICE_ENABLED: true, gifsEnabled: true })).features,
		).toEqual(["voice", "gifs", "embeds"]);
	});
});
