import { openTestDatabase } from "@colibri-social/appview-db";
import { describe, expect, it } from "vitest";
import { createRegistry } from "../cluster/registry.js";
import type { AppContext } from "../context.js";
import { describeServer, listNodes } from "./server.js";

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
		expect(describeServer(contextWith()).features).toEqual(["embeds", "emoji"]);
		expect(
			describeServer(contextWith({ VOICE_ENABLED: true, gifsEnabled: true })).features,
		).toEqual(["voice", "gifs", "embeds", "emoji"]);
	});

	it("offers node selection on a clustered AppView", () => {
		const ctx = { ...contextWith(), clustered: true } as AppContext;

		expect(describeServer(ctx).features).toContain("nodes");
	});

	it("leaves out the default community when none is configured", () => {
		expect(describeServer(contextWith()).defaultCommunity).toBeUndefined();
	});

	it("reports the configured default community", () => {
		const description = describeServer(
			contextWith({ DEFAULT_COMMUNITY_DID: "did:plc:mprdjqjluoswa7awzggaggj3" }),
		);
		expect(description.defaultCommunity).toBe("did:plc:mprdjqjluoswa7awzggaggj3");
	});
});

describe("listNodes", () => {
	it("lists nothing on a single AppView", async () => {
		expect(await listNodes({ clustered: false } as AppContext)).toEqual({ nodes: [] });
	});

	it("lists the nodes that accept clients with a probe URL", async () => {
		const database = await openTestDatabase();
		const registry = createRegistry(database);

		try {
			await registry.register(
				{ id: "eu-2", region: "eu", roles: ["api", "live", "voice"] },
				{
					publicUrl: "https://eu-2.nodes.colibri.social",
					tailnetUrl: "http://eu-2:3100",
					version: "1",
				},
			);
			await registry.register(
				{ id: "eu-db", region: "eu", roles: ["main"] },
				{ publicUrl: "https://eu-1.test", tailnetUrl: "http://eu-1:3100", version: "1" },
			);

			expect(await listNodes({ clustered: true, registry } as unknown as AppContext)).toEqual({
				nodes: [
					{
						id: "eu-2",
						region: "eu",
						roles: ["api", "live", "voice"],
						endpoint: "https://eu-2.nodes.colibri.social",
						probeUrl: "https://eu-2.nodes.colibri.social/health",
					},
				],
			});
		} finally {
			await database.destroy();
		}
	});
});
