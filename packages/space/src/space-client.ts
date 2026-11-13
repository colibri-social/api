import { fromBase64 } from "@atproto/lex-data";
import {
	COMMIT_MAC_PROFILE,
	encapsulate,
	formatMacRequest,
	MAC_COVERED_HEADER,
	type MacProfile,
	RECORD_MAC_PROFILE,
	type SpaceCommit,
	SpaceError,
	verifyRecord,
} from "@atproto/space";
import type { DidString, SpaceAtUriString } from "@atproto/syntax";
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

export const decodeCommit = (wire: WireCommit): SpaceCommit => ({
	ver: wire.ver,
	repo: wire.repo as SpaceCommit["repo"],
	space: wire.space as SpaceCommit["space"],
	rev: wire.rev as SpaceCommit["rev"],
	data: fromBase64(wire.data.$bytes),
});

export type MacProof = {
	keyShare: DidString;
	sharedSecret: Uint8Array;
	headers: Record<string, string>;
};

export type ProvenCommit = MacProof & { commit: SpaceCommit };

export const REPO_WRITE_TYPE = "com.atproto.space.defs#repoWrite";
export const REPO_REMOVED_TYPE = "com.atproto.space.defs#repoRemoved";

export type RepoWriteEntry = {
	$type: typeof REPO_WRITE_TYPE;
	repo: string;
	repoRev: string;
	data: Uint8Array;
	spaceRev: string;
};

export type RepoRemovedEntry = {
	$type: typeof REPO_REMOVED_TYPE;
	repo: string;
	spaceRev: string;
};

export type WriterEntry = RepoWriteEntry | RepoRemovedEntry;

type WireWriterEntry =
	| {
			$type: typeof REPO_WRITE_TYPE;
			repo: string;
			repoRev: string;
			data: WireBytes;
			spaceRev: string;
	  }
	| { $type: typeof REPO_REMOVED_TYPE; repo: string; spaceRev: string }
	| { $type?: string };

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
	commit: ProvenCommit;
	cursor: string | null;
};

export type RepoStar = MacProof & { star: AsyncIterable<Uint8Array> };

export const STAR_CONTENT_TYPE = "application/vnd.dasl.star";

type MacRequest = {
	keyShare: DidString;
	sharedSecret: Uint8Array;
	headers: Record<string, string>;
};

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

	private async wantMac(repo: string, profile: MacProfile): Promise<MacRequest> {
		const { keyShare, sharedSecret } = await encapsulate(
			(await this.options.kemKeys.kemKeyFor(repo)) as DidString,
		);

		return {
			keyShare,
			sharedSecret,
			headers: { "accept-signature": formatMacRequest(profile, keyShare) },
		};
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

	async listWriters(
		space: SpaceRefString,
		options: { limit?: number; cursor?: string } = {},
	): Promise<{ writers: WriterEntry[]; cursor: string | null }> {
		const client = this.clientFor(await this.hostForAuthority(space));
		const response = await this.withAuthorityCredential(space, (auth) =>
			client.query<{ repos: WireWriterEntry[]; cursor?: string }>(
				"com.atproto.space.listWriters",
				{ space, ...options },
				auth,
			),
		);

		return {
			writers: response.repos.flatMap(decodeWriterEntry),
			cursor: response.cursor ?? null,
		};
	}

	async *allWriters(space: SpaceRefString, since?: string): AsyncGenerator<WriterEntry> {
		let cursor = since;
		while (true) {
			const page = await this.listWriters(space, { limit: 1000, cursor });
			yield* page.writers;
			if (page.writers.length === 0 || !page.cursor) return;
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
		const { body, headers, request } = await this.withCredential(space, repo, async (auth) => {
			const request = await this.wantMac(repo, COMMIT_MAC_PROFILE);
			const response = await client.queryWithHeaders<{
				ops: RepoOp[];
				commit: WireCommit;
				cursor?: string;
			}>("com.atproto.space.listRepoOps", { space, repo, ...options }, auth, request.headers);

			return { ...response, request };
		});

		return {
			ops: body.ops,
			commit: {
				commit: decodeCommit(body.commit),
				...macProof(request, headers, COMMIT_MAC_PROFILE),
			},
			cursor: body.cursor ?? null,
		};
	}

	async getLatestCommit(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
	): Promise<ProvenCommit | null> {
		const client = this.clientFor(repoHost);
		const { body, headers, request } = await this.withCredential(space, repo, async (auth) => {
			const request = await this.wantMac(repo, COMMIT_MAC_PROFILE);
			const response = await client.queryWithHeaders<{ commit?: WireCommit }>(
				"com.atproto.space.getLatestCommit",
				{ space, repo },
				auth,
				request.headers,
			);

			return { ...response, request };
		});

		if (!body.commit) return null;

		return {
			commit: decodeCommit(body.commit),
			...macProof(request, headers, COMMIT_MAC_PROFILE),
		};
	}

	async getRepoStar(space: SpaceRefString, repoHost: string, repo: string): Promise<RepoStar> {
		const client = this.clientFor(repoHost);
		const { response, request } = await this.withCredential(space, repo, async (auth) => {
			const request = await this.wantMac(repo, COMMIT_MAC_PROFILE);
			const response = await client.stream("com.atproto.space.getRepo", { space, repo }, auth, {
				...request.headers,
				accept: STAR_CONTENT_TYPE,
			});

			return { response, request };
		});

		return {
			star: streamBytes(response),
			...macProof(request, response.headers, COMMIT_MAC_PROFILE),
		};
	}

	async getRecord(
		space: SpaceRefString,
		repoHost: string,
		repo: string,
		collection: string,
		rkey: string,
	): Promise<SpaceRecord> {
		const client = this.clientFor(repoHost);
		const { body, headers, request } = await this.withCredential(space, repo, async (auth) => {
			const request = await this.wantMac(repo, RECORD_MAC_PROFILE);
			const response = await client.queryWithHeaders<SpaceRecord>(
				"com.atproto.space.getRecord",
				{ space, repo, collection, rkey },
				auth,
				request.headers,
			);

			return { ...response, request };
		});

		const uri = spaceRecordUri(space, repo, collection, rkey);

		try {
			await verifyRecord(
				{
					uri: body.uri,
					cid: body.cid,
					value: body.value as Parameters<typeof verifyRecord>[0]["value"],
				},
				{
					uri: uri as SpaceAtUriString,
					keyShare: request.keyShare,
					sharedSecret: request.sharedSecret,
					headers,
				},
			);
		} catch (error) {
			if (error instanceof SpaceError) throw new SpaceRecordUnverifiedError(uri);
			throw error;
		}

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
}

const decodeWriterEntry = (entry: WireWriterEntry): WriterEntry[] => {
	if (entry.$type === REPO_WRITE_TYPE && "repoRev" in entry) {
		return [
			{
				$type: REPO_WRITE_TYPE,
				repo: entry.repo,
				repoRev: entry.repoRev,
				data: fromBase64(entry.data.$bytes),
				spaceRev: entry.spaceRev,
			},
		];
	}

	if (entry.$type === REPO_REMOVED_TYPE && "repo" in entry) {
		return [{ $type: REPO_REMOVED_TYPE, repo: entry.repo, spaceRev: entry.spaceRev }];
	}

	return [];
};

const MAC_RESPONSE_HEADERS = ["signature-input", "signature"];

const macProof = (request: MacRequest, headers: Headers, profile: MacProfile): MacProof => {
	const picked: Record<string, string> = {};

	for (const name of [...MAC_RESPONSE_HEADERS, MAC_COVERED_HEADER[profile]]) {
		const value = headers.get(name);
		if (value !== null) picked[name] = value;
	}

	return { keyShare: request.keyShare, sharedSecret: request.sharedSecret, headers: picked };
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
