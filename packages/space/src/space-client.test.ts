import { readFileSync } from "node:fs";
import { verifySpaceSignature } from "@atproto/space";
import { beforeAll, describe, expect, it } from "vitest";
import type { SpaceCredential, SpaceCredentials } from "./credentials.js";
import { SpaceClient } from "./space-client.js";
import { SpaceKey } from "./space-key.js";
import type { SpaceRefString } from "./space-ref.js";

const AUTHORITY = "did:plc:rjwk3hgp6bidml6zlwvyhdwi";
const REPO = "did:plc:t4ckug4y36pkmxo5ej75v3ug";
const CID = "bafkreif62j6x5eug3jub6ympnpsoqzzz5wrqnvxzrna4c4watqfkdxms4e";
const SPACE =
	`at://${AUTHORITY}/space/social.colibri.beta.channel.text/3mttl45nkb22p` as SpaceRefString;
const HOST = "https://pds.test";

let key: SpaceKey;

beforeAll(async () => {
	key = await SpaceKey.generate();
});

const credentialsIssuing = (names: string[] = ["credential"]) => {
	let issued = 0;
	const invalidated: string[] = [];
	const credentials = {
		acquire: async (): Promise<SpaceCredential> => ({
			credential: names[Math.min(issued++, names.length - 1)] as string,
			key,
			expiresAt: new Date(Date.now() + 60_000),
		}),
		invalidate: async (space: string) => void invalidated.push(space),
	} as unknown as SpaceCredentials;
	return { credentials, invalidated };
};

const requiredParamsOf = (nsid: string): string[] => {
	const path = `packages/lexicons/lexicons/${nsid.replaceAll(".", "/")}.json`;
	const document = JSON.parse(readFileSync(path, "utf8")) as {
		defs: { main: { parameters?: { required?: string[] } } };
	};
	return document.defs.main.parameters?.required ?? [];
};

const clientRecording = (respond?: (headers: Headers) => Response | undefined) => {
	const urls: string[] = [];
	const headers: Headers[] = [];
	const { credentials, invalidated } = credentialsIssuing(["first", "second"]);
	const client = new SpaceClient({
		hosts: { hostFor: async () => HOST },
		credentials,
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			urls.push(typeof input === "string" ? input : input.toString());
			const sent = new Headers(init?.headers);
			headers.push(sent);
			return respond?.(sent) ?? Response.json({ cids: [], records: [], repos: [], ops: [] });
		}) as typeof globalThis.fetch,
	});
	return { client, urls, headers, invalidated };
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
		await client.getRecord(SPACE, HOST, REPO, "social.colibri.beta.message", "3lkmsg1");

		for (const raw of urls) {
			const url = new URL(raw);
			const nsid = url.pathname.replace("/xrpc/", "");
			for (const name of requiredParamsOf(nsid)) {
				expect(url.searchParams.get(name), `${nsid} is missing ${name}`).not.toBeNull();
			}
		}
	});
});

describe("SpaceClient credential signatures", () => {
	it("addresses repo calls to the repo owner", async () => {
		const { client, headers } = clientRecording();
		await client.listRecords(SPACE, HOST, REPO);

		const sent = headers[0] as Headers;
		expect(sent.get("authorization")).toBe("Atproto-Space first");
		expect(sent.get("atproto-space-audience")).toBe(REPO);
		expect(await verifySpaceSignature(Object.fromEntries(sent.entries()), key.did as never)).toBe(
			key.did,
		);
	});

	it("addresses space host calls to the authority", async () => {
		const { client, headers } = clientRecording();
		await client.listRepos(SPACE);
		await client.registerNotify(SPACE, "did:web:appview.test#atproto_space_syncer");

		for (const sent of headers) expect(sent.get("atproto-space-audience")).toBe(AUTHORITY);
	});

	it("replaces a revoked credential once and retries", async () => {
		const { client, headers, invalidated } = clientRecording((sent) =>
			sent.get("authorization") === "Atproto-Space first"
				? Response.json({ error: "CredentialRevoked" }, { status: 401 })
				: undefined,
		);
		await client.listRecords(SPACE, HOST, REPO);

		expect(invalidated).toEqual([SPACE]);
		expect(headers.map((sent) => sent.get("authorization"))).toEqual([
			"Atproto-Space first",
			"Atproto-Space second",
		]);
	});

	it("leaves an audience mismatch to the caller", async () => {
		const { client, headers, invalidated } = clientRecording(() =>
			Response.json({ error: "BadSpaceAudience" }, { status: 401 }),
		);
		await expect(client.listRecords(SPACE, HOST, REPO)).rejects.toThrow();

		expect(invalidated).toEqual([]);
		expect(headers).toHaveLength(1);
	});
});

describe("SpaceClient repo listing", () => {
	it("pages by space revision until an empty page", async () => {
		const pages = [
			{
				repos: [{ did: REPO, repoRev: "3lkrepo1", hash: { $bytes: "AA==" }, spaceRev: "3lks1" }],
				cursor: "3lks1",
			},
			{ repos: [] },
		];
		const cursors: Array<string | null> = [];
		const client = new SpaceClient({
			hosts: { hostFor: async () => HOST },
			credentials: credentialsIssuing().credentials,
			fetch: (async (input: string | URL | Request) => {
				cursors.push(new URL(String(input)).searchParams.get("cursor"));
				return Response.json(pages.shift());
			}) as typeof globalThis.fetch,
		});

		const listed = [];
		for await (const repo of client.allRepos(SPACE, "3lks0")) listed.push(repo);

		expect(cursors).toEqual(["3lks0", "3lks1"]);
		expect(listed.map((repo) => [repo.did, repo.repoRev, repo.spaceRev])).toEqual([
			[REPO, "3lkrepo1", "3lks1"],
		]);
	});
});
