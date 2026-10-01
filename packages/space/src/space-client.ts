import { fromBase64 } from "@atproto/lex-data";
import type { SignedCommit } from "@atproto/space";
import type { DidString } from "@atproto/syntax";
import type { SpaceCredentials } from "./credentials.js";
import { XrpcError } from "./errors.js";
import type { SpaceHostResolver } from "./host.js";
import { type Auth, XrpcClient } from "./http.js";
import { parseSpaceRef, type SpaceRefString } from "./space-ref.js";

export type WireBytes = { $bytes: string };

export type WireSignedCommit = {
	ver: number;
	hash: WireBytes;
	ikm: WireBytes;
	sig: WireBytes;
	mac: WireBytes;
	rev: string;
};

export const decodeSignedCommit = (wire: WireSignedCommit): SignedCommit => ({
	ver: wire.ver as 1,
	hash: fromBase64(wire.hash.$bytes),
	ikm: fromBase64(wire.ikm.$bytes),
	sig: fromBase64(wire.sig.$bytes),
	mac: fromBase64(wire.mac.$bytes),
	rev: wire.rev,
});

export type RepoListing = {
	did: string;
	repoRev: string;
	hash: Uint8Array;
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
	commit: SignedCommit | null;
	cursor: string | null;
};

export type SpaceRecord = {
	uri: string;
	cid: string;
	value: Record<string, unknown>;
};

export type SpaceClientOptions = {
	hosts: SpaceHostResolver;
	credentials: SpaceCredentials;
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
				repos: Array<{ did: string; repoRev: string; hash: WireBytes; spaceRev: string }>;
				cursor?: string;
			}>("com.atproto.space.listRepos", { space, ...options }, auth),
		);
		return {
			repos: response.repos.map((repo) => ({
				did: repo.did,
				repoRev: repo.repoRev,
				hash: fromBase64(repo.hash.$bytes),
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
		const response = await this.withCredential(space, repo, (auth) =>
			client.query<{
				ops: RepoOp[];
				commit?: WireSignedCommit;
				cursor?: string;
			}>("com.atproto.space.listRepoOps", { space, repo, ...options }, auth),
		);
		return {
			ops: response.ops,
			commit: response.commit ? decodeSignedCommit(response.commit) : null,
			cursor: response.cursor ?? null,
		};
	}

	async getLatestCommit(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
	): Promise<SignedCommit | null> {
		const client = this.clientFor(repoHost);
		const response = await this.withCredential(space, repo, (auth) =>
			client.query<{ commit?: WireSignedCommit }>(
				"com.atproto.space.getLatestCommit",
				{ space, repo },
				auth,
			),
		);
		return response.commit ? decodeSignedCommit(response.commit) : null;
	}

	async getRepoCar(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
	): Promise<AsyncIterable<Uint8Array>> {
		const client = this.clientFor(repoHost);
		const response = await this.withCredential(space, repo, (auth) =>
			client.stream("com.atproto.space.getRepo", { space, repo }, auth),
		);
		return streamBytes(response);
	}

	async getRecord(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
		collection: string,
		rkey: string,
	): Promise<SpaceRecord> {
		const client = this.clientFor(repoHost);
		return this.withCredential(space, repo, (auth) =>
			client.query<SpaceRecord>(
				"com.atproto.space.getRecord",
				{ space, repo, collection, rkey },
				auth,
			),
		);
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
