import { fromBase64 } from "@atproto/lex-data";
import {
	COMMIT_MAC_TYPE,
	type Commit,
	encapsulate,
	formatWantMacHeader,
	MAC_HEADER,
	type MacType,
	parseMacHeader,
	RECORD_MAC_TYPE,
	SpaceMacError,
	verifyRecord,
	WANT_MAC_HEADER,
} from "@atproto/space";
import type { DidString } from "@atproto/syntax";
import type { SpaceCredentials } from "./credentials.js";
import { XrpcError } from "./errors.js";
import type { SpaceHostResolver } from "./host.js";
import { type Auth, XrpcClient } from "./http.js";
import { parseSpaceRef, type SpaceRefString, spaceRecordUri } from "./space-ref.js";

export type WireBytes = { $bytes: string };

export type WireCommit = {
	ver: number;
	repo: string;
	space: string;
	rev: string;
	data: WireBytes;
};

export const decodeCommit = (wire: WireCommit): Commit => ({
	ver: wire.ver,
	repo: wire.repo as Commit["repo"],
	space: wire.space as Commit["space"],
	rev: wire.rev,
	data: fromBase64(wire.data.$bytes),
});

export type MacProof = {
	sharedSecret: Uint8Array;
	mac: Uint8Array;
};

export type ProvenCommit = MacProof & { commit: Commit };

export type RepoListing = {
	did: string;
	repoRev: string;
	data: Uint8Array;
	spaceRev: string;
};

export type RepoOp = {
	rev: string;
	collection: string;
	rkey: string;
	cid: string | null;
	prev: string | null;
	value?: Record<string, unknown>;
};

export type RepoOpsPage = {
	ops: RepoOp[];
	commit: ProvenCommit | null;
	cursor: string | null;
};

export type RepoStar = MacProof & { star: AsyncIterable<Uint8Array> };

export type KemKeyResolver = {
	kemKeyFor(did: string, forceRefresh?: boolean): Promise<string>;
};

export class SpaceRecordUnverifiedError extends Error {
	constructor(readonly uri: string) {
		super(`the MAC on ${uri} did not verify`);
		this.name = "SpaceRecordUnverifiedError";
	}
}

export type SpaceRecord = {
	uri: string;
	cid: string;
	value: Record<string, unknown>;
};

export type SpaceClientOptions = {
	hosts: SpaceHostResolver;
	credentials: SpaceCredentials;
	kemKeys: KemKeyResolver;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
};

export class SpaceClient {
	private readonly clients = new Map<string, XrpcClient>();

	constructor(private readonly options: SpaceClientOptions) {}

	private clientFor(service: string): XrpcClient {
		const existing = this.clients.get(service);
		if (existing) return existing;
		const client = new XrpcClient({
			service,
			fetch: this.options.fetch,
			timeoutMs: this.options.timeoutMs,
		});
		this.clients.set(service, client);
		return client;
	}

	private async withCredential<T>(
		space: SpaceRefString,
		audience: string,
		send: (auth: Auth) => Promise<T>,
	): Promise<T> {
		const attempt = async (): Promise<T> => {
			const credential = await this.options.credentials.acquire(space);
			return send({
				kind: "spaceCredential",
				credential: credential.credential,
				key: credential.key,
				audience: audience as DidString,
			});
		};
		try {
			return await attempt();
		} catch (error) {
			if (!(error instanceof XrpcError) || !error.isCredentialRejected) throw error;
			await this.options.credentials.invalidate(space);
			return attempt();
		}
	}

	private async wantMac(
		repo: string,
		type: MacType,
	): Promise<{ sharedSecret: Uint8Array; headers: Record<string, string> }> {
		const { keyShare, sharedSecret } = await encapsulate(
			await this.options.kemKeys.kemKeyFor(repo),
		);
		return { sharedSecret, headers: { [WANT_MAC_HEADER]: formatWantMacHeader(type, keyShare) } };
	}

	private withAuthorityCredential<T>(
		space: SpaceRefString,
		send: (auth: Auth) => Promise<T>,
	): Promise<T> {
		return this.withCredential(space, parseSpaceRef(space).authority, send);
	}

	private hostForAuthority(space: SpaceRefString): Promise<string> {
		return this.options.hosts.hostFor(parseSpaceRef(space).authority);
	}

	async listRepos(
		space: SpaceRefString,
		options: { limit?: number; cursor?: string } = {},
	): Promise<{ repos: RepoListing[]; cursor: string | null }> {
		const client = this.clientFor(await this.hostForAuthority(space));
		const response = await this.withAuthorityCredential(space, (auth) =>
			client.query<{
				repos: Array<{ did: string; repoRev: string; data: WireBytes; spaceRev: string }>;
				cursor?: string;
			}>("com.atproto.space.listRepos", { space, ...options }, auth),
		);
		return {
			repos: response.repos.map((repo) => ({
				did: repo.did,
				repoRev: repo.repoRev,
				data: fromBase64(repo.data.$bytes),
				spaceRev: repo.spaceRev,
			})),
			cursor: response.cursor ?? null,
		};
	}

	async *allRepos(space: SpaceRefString, since?: string): AsyncGenerator<RepoListing> {
		let cursor = since;
		while (true) {
			const page = await this.listRepos(space, { limit: 1000, cursor });
			yield* page.repos;
			if (page.repos.length === 0 || !page.cursor) return;
			cursor = page.cursor;
		}
	}

	async listRepoOps(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
		options: { since?: string; cursor?: string; limit?: number; excludeValues?: boolean } = {},
	): Promise<RepoOpsPage> {
		const client = this.clientFor(repoHost);
		const { body, headers, sharedSecret } = await this.withCredential(space, repo, async (auth) => {
			const want = await this.wantMac(repo, COMMIT_MAC_TYPE);
			const response = await client.queryWithHeaders<{
				ops: RepoOp[];
				commit?: WireCommit;
				cursor?: string;
			}>("com.atproto.space.listRepoOps", { space, repo, ...options }, auth, want.headers);
			return { ...response, sharedSecret: want.sharedSecret };
		});
		return {
			ops: body.ops,
			commit: body.commit
				? {
						commit: decodeCommit(body.commit),
						sharedSecret,
						mac: macFrom(headers, COMMIT_MAC_TYPE),
					}
				: null,
			cursor: body.cursor ?? null,
		};
	}

	async getLatestCommit(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
	): Promise<ProvenCommit | null> {
		const client = this.clientFor(repoHost);
		const { body, headers, sharedSecret } = await this.withCredential(space, repo, async (auth) => {
			const want = await this.wantMac(repo, COMMIT_MAC_TYPE);
			const response = await client.queryWithHeaders<{ commit?: WireCommit }>(
				"com.atproto.space.getLatestCommit",
				{ space, repo },
				auth,
				want.headers,
			);
			return { ...response, sharedSecret: want.sharedSecret };
		});
		if (!body.commit) return null;
		return {
			commit: decodeCommit(body.commit),
			sharedSecret,
			mac: macFrom(headers, COMMIT_MAC_TYPE),
		};
	}

	async getRepoStar(space: SpaceRefString, repoHost: string, repo: string): Promise<RepoStar> {
		const client = this.clientFor(repoHost);
		const { response, sharedSecret } = await this.withCredential(space, repo, async (auth) => {
			const want = await this.wantMac(repo, COMMIT_MAC_TYPE);
			const response = await client.stream(
				"com.atproto.space.getRepo",
				{ space, repo },
				auth,
				want.headers,
			);
			return { response, sharedSecret: want.sharedSecret };
		});
		let mac: Uint8Array;
		try {
			mac = macFrom(response.headers, COMMIT_MAC_TYPE);
		} catch (error) {
			await response.body?.cancel().catch(() => undefined);
			throw error;
		}
		return { star: streamBytes(response), sharedSecret, mac };
	}

	async getRecord(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
		collection: string,
		rkey: string,
	): Promise<SpaceRecord> {
		const client = this.clientFor(repoHost);
		const { body, headers, sharedSecret } = await this.withCredential(space, repo, async (auth) => {
			const want = await this.wantMac(repo, RECORD_MAC_TYPE);
			const response = await client.queryWithHeaders<SpaceRecord>(
				"com.atproto.space.getRecord",
				{ space, repo, collection, rkey },
				auth,
				want.headers,
			);
			return { ...response, sharedSecret: want.sharedSecret };
		});
		const uri = spaceRecordUri(space, repo, collection, rkey);
		const authentic = await verifyRecord(
			{
				uri: body.uri,
				cid: body.cid,
				value: body.value as Parameters<typeof verifyRecord>[0]["value"],
			},
			{ uri, sharedSecret, mac: macFrom(headers, RECORD_MAC_TYPE) },
		);
		if (!authentic) throw new SpaceRecordUnverifiedError(uri);
		return body;
	}

	async listRecords(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
		options: { collection?: string; cursor?: string; limit?: number; excludeValues?: boolean } = {},
	): Promise<{ records: SpaceRecord[]; cursor: string | null }> {
		const client = this.clientFor(repoHost);
		const response = await this.withCredential(space, repo, (auth) =>
			client.query<{ records: SpaceRecord[]; cursor?: string }>(
				"com.atproto.space.listRecords",
				{ space, repo, ...options },
				auth,
			),
		);
		return { records: response.records, cursor: response.cursor ?? null };
	}

	async getBlob(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
		cid: string,
	): Promise<Response> {
		const client = this.clientFor(repoHost);
		return this.withCredential(space, repo, (auth) =>
			client.stream("com.atproto.space.getBlob", { space, repo, cid }, auth),
		);
	}

	async listBlobs(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
		options: { cursor?: string; limit?: number } = {},
	): Promise<{ cids: string[]; cursor: string | null }> {
		const client = this.clientFor(repoHost);
		const response = await this.withCredential(space, repo, (auth) =>
			client.query<{ cids: string[]; cursor?: string }>(
				"com.atproto.space.listBlobs",
				{ space, repo, ...options },
				auth,
			),
		);
		return { cids: response.cids, cursor: response.cursor ?? null };
	}

	async registerNotify(space: SpaceRefString, service: string): Promise<{ expiresAt: Date }> {
		const client = this.clientFor(await this.hostForAuthority(space));
		const response = await this.withAuthorityCredential(space, (auth) =>
			client.procedure<{ expiresAt: string }>(
				"com.atproto.space.registerNotify",
				{ space, service },
				auth,
			),
		);
		return { expiresAt: new Date(response.expiresAt) };
	}

	async unregisterNotify(space: SpaceRefString, service: string): Promise<void> {
		const client = this.clientFor(await this.hostForAuthority(space));
		await this.withAuthorityCredential(space, (auth) =>
			client.procedure("com.atproto.space.unregisterNotify", { space, service }, auth),
		);
	}
}

const macFrom = (headers: Headers, type: MacType): Uint8Array => {
	const value = headers.get(MAC_HEADER);
	if (value === null) throw new SpaceMacError("the response carried no MAC");
	return parseMacHeader(value, type);
};

const streamBytes = (response: Response): AsyncIterable<Uint8Array> => {
	const body = response.body;
	if (!body) return (async function* () {})();
	return (async function* () {
		const reader = body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				if (value) yield value;
			}
		} finally {
			reader.releaseLock();
		}
	})();
};
