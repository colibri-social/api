import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SpaceCredential, SpaceCredentials } from "./credentials.js";
import { SpaceClient } from "./space-client.js";
import type { SpaceRefString } from "./space-ref.js";

const AUTHORITY = "did:plc:rjwk3hgp6bidml6zlwvyhdwi";
const REPO = "did:plc:t4ckug4y36pkmxo5ej75v3ug";
const CID = "bafkreif62j6x5eug3jub6ympnpsoqzzz5wrqnvxzrna4c4watqfkdxms4e";
const SPACE =
	`at://${AUTHORITY}/space/social.colibri.beta.channel.text/3mttl45nkb22p` as SpaceRefString;
const HOST = "https://pds.test";

const credentials = {
	acquire: async (): Promise<SpaceCredential> => ({
		credential: "credential",
		key: { proof: async () => "proof" } as unknown as SpaceCredential["key"],
		expiresAt: new Date(Date.now() + 60_000),
	}),
} as unknown as SpaceCredentials;

const requiredParamsOf = (nsid: string): string[] => {
	const path = `packages/lexicons/lexicons/${nsid.replaceAll(".", "/")}.json`;
	const document = JSON.parse(readFileSync(path, "utf8")) as {
		defs: { main: { parameters?: { required?: string[] } } };
	};
	return document.defs.main.parameters?.required ?? [];
};

const clientRecording = () => {
	const urls: string[] = [];
	const client = new SpaceClient({
		hosts: { hostFor: async () => HOST },
		credentials,
		fetch: (async (input: string | URL | Request) => {
			urls.push(typeof input === "string" ? input : input.toString());
			return Response.json({ cids: [], records: [], repos: [], ops: [] });
		}) as typeof globalThis.fetch,
	});
	return { client, urls };
};

describe("SpaceClient request parameters", () => {
	it("sends every parameter com.atproto.space.getBlob requires", async () => {
		const { client, urls } = clientRecording();
		await client.getBlob(SPACE, HOST, REPO, CID);

		const url = new URL(urls[0] as string);
		expect(url.pathname).toBe("/xrpc/com.atproto.space.getBlob");
		for (const name of requiredParamsOf("com.atproto.space.getBlob")) {
			expect(url.searchParams.get(name), `missing ${name}`).not.toBeNull();
		}
		expect(url.searchParams.get("repo")).toBe(REPO);
		expect(url.searchParams.get("cid")).toBe(CID);
		expect(url.searchParams.get("space")).toBe(SPACE);
	});

	it("names the repo the same way across every repo-scoped space method", async () => {
		const { client, urls } = clientRecording();
		await client.getBlob(SPACE, HOST, REPO, CID);
		await client.listBlobs(SPACE, HOST, REPO);
		await client.listRecords(SPACE, HOST, REPO);
		await client.listRepoOps(SPACE, HOST, REPO);
		await client.getRecord(
			SPACE,
			HOST,
			REPO,
			"social.colibri.beta.message",
			"3lkmsg1",
		);

		for (const raw of urls) {
			const url = new URL(raw);
			const nsid = url.pathname.replace("/xrpc/", "");
			for (const name of requiredParamsOf(nsid)) {
				expect(
					url.searchParams.get(name),
					`${nsid} is missing ${name}`,
				).not.toBeNull();
			}
		}
	});
});
