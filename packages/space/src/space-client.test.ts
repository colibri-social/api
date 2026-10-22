import { readFileSync } from "node:fs";
import { P256Keypair } from "@atproto/crypto";
import {
	COMMIT_MAC_TYPE,
	computeCommitMac,
	computeRecordMac,
	decapsulate,
	formatMacHeader,
	type MacType,
	parseWantMacHeader,
	RECORD_MAC_TYPE,
	serializeRecord,
	verifyCommit,
	verifyCredentialSig,
} from "@atproto/space";
import type { DidString } from "@atproto/syntax";
import { beforeAll, describe, expect, it } from "vitest";
import type { SpaceCredential, SpaceCredentials } from "./credentials.js";
import { decodeCommit, SpaceClient, SpaceRecordUnverifiedError } from "./space-client.js";
import { SpaceKey } from "./space-key.js";
import { type SpaceRefString, spaceRecordUri } from "./space-ref.js";

const AUTHORITY = "did:plc:rjwk3hgp6bidml6zlwvyhdwi";
const REPO = "did:plc:t4ckug4y36pkmxo5ej75v3ug";
const CID = "bafkreif62j6x5eug3jub6ympnpsoqzzz5wrqnvxzrna4c4watqfkdxms4e";
const SPACE =
	`at://${AUTHORITY}/space/social.colibri.beta.channel.text/3mttl45nkb22p` as SpaceRefString;
const HOST = "https://pds.test";

const COLLECTION = "social.colibri.beta.message";
const RKEY = "3lkmsg1";
const RECORD = { $type: COLLECTION, text: "hello" };

let key: SpaceKey;
let authorKem: P256Keypair;

beforeAll(async () => {
	key = await SpaceKey.generate();
	authorKem = await P256Keypair.create();
});

const kemKeys = () => ({ kemKeyFor: async () => authorKem.did() });

const secretFrom = (sent: Headers, type: MacType): Uint8Array =>
	decapsulate(authorKem, parseWantMacHeader(sent.get("atproto-space-want-mac") ?? undefined, type));

const wireCommit = {
	ver: 1,
	repo: REPO,
	space: SPACE,
	rev: "3lkrev1",
	data: { $bytes: Buffer.alloc(32, 7).toString("base64") },
};

const repoHostResponse = async (url: URL, sent: Headers): Promise<Response | undefined> => {
	const nsid = url.pathname.replace("/xrpc/", "");
	if (nsid === "com.atproto.space.getRecord") {
		const { cid } = await serializeRecord(COLLECTION as never, RKEY as never, RECORD as never);
		const uri = spaceRecordUri(SPACE, REPO, COLLECTION, RKEY);
		const mac = computeRecordMac(secretFrom(sent, RECORD_MAC_TYPE), uri, cid);
		return Response.json(
			{ uri, cid: cid.toString(), value: RECORD },
			{ headers: { "atproto-space-mac": formatMacHeader(RECORD_MAC_TYPE, mac) } },
		);
	}
	if (nsid === "com.atproto.space.listRepoOps") {
		const mac = computeCommitMac(secretFrom(sent, COMMIT_MAC_TYPE), decodeCommit(wireCommit));
		return Response.json(
			{ ops: [], commit: wireCommit },
			{ headers: { "atproto-space-mac": formatMacHeader(COMMIT_MAC_TYPE, mac) } },
		);
	}
	return undefined;
};

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
		kemKeys: kemKeys(),
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			urls.push(url);
			const sent = new Headers(init?.headers);
			headers.push(sent);
			return (
				respond?.(sent) ??
				(await repoHostResponse(new URL(url), sent)) ??
				Response.json({ cids: [], records: [], repos: [], ops: [] })
			);
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
		await client.getRecord(SPACE, HOST, REPO, COLLECTION, RKEY);

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
		expect(sent.get("authorization")).toBe("Atproto-Space-Credential first");
		expect(sent.get("atproto-space-audience")).toBe(REPO);
		expect(sent.get("signature-input")).toBe(
			'atproto-space-credential=("authorization" "atproto-space-audience");tag="atproto-space-credential"',
		);
		await expect(
			verifyCredentialSig(Object.fromEntries(sent.entries()), key.did as DidString),
		).resolves.toBeUndefined();
	});

	it("addresses space host calls to the authority", async () => {
		const { client, headers } = clientRecording();
		await client.listRepos(SPACE);
		await client.registerNotify(SPACE, "did:web:appview.test#atproto_space_syncer");

		for (const sent of headers) expect(sent.get("atproto-space-audience")).toBe(AUTHORITY);
	});

	it("replaces a revoked credential once and retries", async () => {
		const { client, headers, invalidated } = clientRecording((sent) =>
			sent.get("authorization") === "Atproto-Space-Credential first"
				? Response.json({ error: "CredentialRevoked" }, { status: 401 })
				: undefined,
		);
		await client.listRecords(SPACE, HOST, REPO);

		expect(invalidated).toEqual([SPACE]);
		expect(headers.map((sent) => sent.get("authorization"))).toEqual([
			"Atproto-Space-Credential first",
			"Atproto-Space-Credential second",
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
				repos: [{ did: REPO, repoRev: "3lkrepo1", data: { $bytes: "AA==" }, spaceRev: "3lks1" }],
				cursor: "3lks1",
			},
			{ repos: [] },
		];
		const cursors: Array<string | null> = [];
		const client = new SpaceClient({
			hosts: { hostFor: async () => HOST },
			credentials: credentialsIssuing().credentials,
			kemKeys: kemKeys(),
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

describe("SpaceClient MACs", () => {
	it("returns a listRepoOps commit with the proof that verifies it", async () => {
		const { client, headers } = clientRecording();
		const page = await client.listRepoOps(SPACE, HOST, REPO);

		expect(headers[0]?.get("atproto-space-want-mac")).toMatch(
			/^type="atproto-space-repo", ver=1, key_share="did:key:/,
		);
		const proven = page.commit;
		expect(proven).not.toBeNull();
		if (!proven) return;
		expect(
			verifyCommit(proven.commit, {
				space: SPACE,
				repo: REPO,
				sharedSecret: proven.sharedSecret,
				mac: proven.mac,
			}),
		).toBe(true);
	});

	it("leaves a listRepoOps page without a commit unproven", async () => {
		const { client } = clientRecording(() => Response.json({ ops: [] }));
		const page = await client.listRepoOps(SPACE, HOST, REPO);
		expect(page.commit).toBeNull();
	});

	it("uses a fresh key share for every request", async () => {
		const { client, headers } = clientRecording();
		await client.listRepoOps(SPACE, HOST, REPO);
		await client.listRepoOps(SPACE, HOST, REPO);
		const shares = headers.map((sent) => sent.get("atproto-space-want-mac"));
		expect(shares[0]).not.toBe(shares[1]);
	});

	it("accepts a record whose MAC verifies", async () => {
		const { client } = clientRecording();
		const record = await client.getRecord(SPACE, HOST, REPO, COLLECTION, RKEY);
		expect(record.value).toEqual(RECORD);
	});

	it("rejects a record whose MAC was made with another secret", async () => {
		const { client } = clientRecording((sent) => {
			if (!sent.get("atproto-space-want-mac")?.includes("atproto-space-record")) return undefined;
			return Response.json(
				{
					uri: spaceRecordUri(SPACE, REPO, COLLECTION, RKEY),
					cid: CID,
					value: RECORD,
				},
				{
					headers: {
						"atproto-space-mac": formatMacHeader(RECORD_MAC_TYPE, new Uint8Array(32)),
					},
				},
			);
		});
		await expect(client.getRecord(SPACE, HOST, REPO, COLLECTION, RKEY)).rejects.toBeInstanceOf(
			SpaceRecordUnverifiedError,
		);
	});

	it("rejects a commit response without a MAC header", async () => {
		const { client } = clientRecording(() => Response.json({ ops: [], commit: wireCommit }));
		await expect(client.listRepoOps(SPACE, HOST, REPO)).rejects.toThrow();
	});
});
