import { type Auth, XrpcClient } from "./http.js";
import { PdsSession, type SessionCredentials } from "./session.js";
import type { SpaceRefString } from "./space-ref.js";

export type SpacePolicy =
	| { $type: "com.atproto.simplespace.defs#publicPolicy" }
	| { $type: "com.atproto.simplespace.defs#memberListPolicy" }
	| { $type: "com.atproto.simplespace.defs#managingAppPolicy"; managingApp: string };

export type SpaceAppAccess =
	| { $type: "com.atproto.simplespace.defs#open" }
	| { $type: "com.atproto.simplespace.defs#allowList"; allowed: string[] };

export const publicPolicy = (): SpacePolicy => ({
	$type: "com.atproto.simplespace.defs#publicPolicy",
});
export const memberListPolicy = (): SpacePolicy => ({
	$type: "com.atproto.simplespace.defs#memberListPolicy",
});
export const managingAppPolicy = (managingApp: string): SpacePolicy => ({
	$type: "com.atproto.simplespace.defs#managingAppPolicy",
	managingApp,
});
export const openAppAccess = (): SpaceAppAccess => ({ $type: "com.atproto.simplespace.defs#open" });
export const allowListAppAccess = (allowed: string[]): SpaceAppAccess => ({
	$type: "com.atproto.simplespace.defs#allowList",
	allowed,
});

export type CreatedAccount = {
	did: string;
	handle: string;
	accessJwt: string;
	refreshJwt: string;
};

export type AccountInfo = {
	did: string;
	handle: string;
	email?: string;
	deactivatedAt?: string;
};

export type RecordWrite = {
	space: SpaceRefString;
	collection: string;
	rkey?: string;
	record: Record<string, unknown>;
	validate?: boolean;
};

export type WriteResult = {
	uri: string;
	cid: string;
};

export type PdsClientOptions = {
	service: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
};

export class PdsClient {
	readonly xrpc: XrpcClient;

	constructor(options: PdsClientOptions) {
		this.xrpc = new XrpcClient(options);
	}

	get service(): string {
		return this.xrpc.service;
	}

	login(credentials: SessionCredentials): Promise<PdsSession> {
		return PdsSession.login(this.xrpc, credentials);
	}

	getDelegationToken(session: PdsSession, space: SpaceRefString): Promise<string> {
		return session
			.run((auth) =>
				this.xrpc.query<{ token: string }>("com.atproto.space.getDelegationToken", { space }, auth),
			)
			.then((response) => response.token);
	}

	createRecord(session: PdsSession, write: RecordWrite): Promise<WriteResult> {
		return session.run((auth) =>
			this.xrpc.procedure<WriteResult>(
				"com.atproto.space.createRecord",
				{ ...write, repo: session.did },
				auth,
			),
		);
	}

	putRecord(session: PdsSession, write: RecordWrite & { rkey: string }): Promise<WriteResult> {
		return session.run((auth) =>
			this.xrpc.procedure<WriteResult>(
				"com.atproto.space.putRecord",
				{ ...write, repo: session.did },
				auth,
			),
		);
	}

	deleteRecord(
		session: PdsSession,
		params: { space: SpaceRefString; collection: string; rkey: string },
	): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure(
				"com.atproto.space.deleteRecord",
				{ ...params, repo: session.did },
				auth,
			);
		});
	}

	applyWrites(
		session: PdsSession,
		params: { space: SpaceRefString; writes: unknown[] },
	): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure(
				"com.atproto.space.applyWrites",
				{ ...params, repo: session.did },
				auth,
			);
		});
	}

	listSpaces(session: PdsSession): Promise<{ spaces: Array<{ uri: string }> }> {
		return session.run((auth) =>
			this.xrpc.query<{ spaces: Array<{ uri: string }> }>("com.atproto.space.listSpaces", {}, auth),
		);
	}

	createSpace(
		session: PdsSession,
		params: { type: string; skey?: string; policy: SpacePolicy; appAccess: SpaceAppAccess },
	): Promise<{ uri: SpaceRefString }> {
		return session.run((auth) =>
			this.xrpc.procedure<{ uri: SpaceRefString }>(
				"com.atproto.simplespace.createSpace",
				params,
				auth,
			),
		);
	}

	updateSpace(
		session: PdsSession,
		params: { space: SpaceRefString; policy?: SpacePolicy; appAccess?: SpaceAppAccess },
	): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure("com.atproto.simplespace.updateSpace", params, auth);
		});
	}

	deleteSpace(session: PdsSession, space: SpaceRefString): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure("com.atproto.simplespace.deleteSpace", { space }, auth);
		});
	}

	getSpace(
		session: PdsSession,
		space: SpaceRefString,
	): Promise<{ uri: SpaceRefString; policy: SpacePolicy; appAccess: SpaceAppAccess }> {
		return session.run((auth) =>
			this.xrpc.query<{ uri: SpaceRefString; policy: SpacePolicy; appAccess: SpaceAppAccess }>(
				"com.atproto.simplespace.getSpace",
				{ space },
				auth,
			),
		);
	}

	addMember(session: PdsSession, space: SpaceRefString, did: string): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure("com.atproto.simplespace.addMember", { space, did }, auth);
		});
	}

	removeMember(session: PdsSession, space: SpaceRefString, did: string): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure("com.atproto.simplespace.removeMember", { space, did }, auth);
		});
	}

	getPublicRecord<T>(repo: string, collection: string, rkey: string): Promise<T> {
		return this.xrpc.query<T>("com.atproto.repo.getRecord", { repo, collection, rkey });
	}

	resolveHandle(handle: string): Promise<{ did: string }> {
		return this.xrpc.query<{ did: string }>("com.atproto.identity.resolveHandle", { handle });
	}

	uploadBlob(session: PdsSession, bytes: Uint8Array, mimeType: string): Promise<{ blob: unknown }> {
		return session.run(async (auth) => {
			const headers = new Headers({ "content-type": mimeType });
			if (auth.kind === "bearer") headers.set("authorization", `Bearer ${auth.token}`);
			const response = await fetch(`${this.service}/xrpc/com.atproto.repo.uploadBlob`, {
				method: "POST",
				headers,
				body: bytes,
			});
			if (!response.ok) throw new Error(`uploadBlob failed with ${response.status}`);
			return (await response.json()) as { blob: unknown };
		});
	}
}

export type AdminAuth = { password: string };

export class PdsAdmin {
	constructor(
		private readonly xrpc: XrpcClient,
		private readonly admin: AdminAuth,
	) {}

	private get auth(): Auth {
		return { kind: "basic", user: "admin", password: this.admin.password };
	}

	createInviteCode(useCount = 1): Promise<{ code: string }> {
		return this.xrpc.procedure<{ code: string }>(
			"com.atproto.server.createInviteCode",
			{ useCount },
			this.auth,
		);
	}

	createAccount(params: {
		handle: string;
		email: string;
		password: string;
		inviteCode?: string;
	}): Promise<CreatedAccount> {
		return this.xrpc.procedure<CreatedAccount>("com.atproto.server.createAccount", params);
	}

	updateAccountPassword(did: string, password: string): Promise<void> {
		return this.xrpc
			.procedure("com.atproto.admin.updateAccountPassword", { did, password }, this.auth)
			.then(() => undefined);
	}

	deleteAccount(did: string): Promise<void> {
		return this.xrpc
			.procedure("com.atproto.admin.deleteAccount", { did }, this.auth)
			.then(() => undefined);
	}

	getAccountInfo(did: string): Promise<AccountInfo> {
		return this.xrpc.query<AccountInfo>("com.atproto.admin.getAccountInfo", { did }, this.auth);
	}
}
