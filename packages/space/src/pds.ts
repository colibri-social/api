import { type Auth, XrpcClient } from "./http.js";
import { type HostSession, PdsSession, type SessionCredentials } from "./session.js";
import type { SpaceRefString } from "./space-ref.js";

export type MemberspacePolicy = {
	$type: "com.atproto.memberspace.policy";
	publicRead?: boolean;
	publicWrite?: boolean;
	allowedApps?: string[];
	publishPolicy?: boolean;
	publishMembers?: boolean;
};

export type ManagedspacePolicy = {
	$type: "com.atproto.managedspace.policy";
	managingApp: string;
	publishPolicy?: boolean;
};

export type PersonalspacePolicy = { $type: "com.atproto.personalspace.policy" };

export type SpacePolicy = MemberspacePolicy | ManagedspacePolicy | PersonalspacePolicy;

export const memberspacePolicy = (
	options: Omit<MemberspacePolicy, "$type"> = {},
): MemberspacePolicy => ({
	$type: "com.atproto.memberspace.policy",
	...options,
});
export const managedspacePolicy = (managingApp: string): ManagedspacePolicy => ({
	$type: "com.atproto.managedspace.policy",
	managingApp,
});

export type SpaceConfiguration = {
	uri: SpaceRefString;
	policy: SpacePolicy;
};

export type SpaceMemberAccess = {
	read: boolean;
	write: boolean;
};

export type SpaceMember = SpaceMemberAccess & {
	did: string;
};

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

	getDelegationToken(session: HostSession, space: SpaceRefString): Promise<string> {
		return session
			.run((auth) =>
				this.xrpc.query<{ token: string }>("com.atproto.space.getDelegationToken", { space }, auth),
			)
			.then((response) => response.token);
	}

	createRecord(session: HostSession, write: RecordWrite): Promise<WriteResult> {
		return session.run((auth) =>
			this.xrpc.procedure<WriteResult>(
				"com.atproto.space.createRecord",
				{ ...write, repo: session.did },
				auth,
			),
		);
	}

	putRecord(session: HostSession, write: RecordWrite & { rkey: string }): Promise<WriteResult> {
		return session.run((auth) =>
			this.xrpc.procedure<WriteResult>(
				"com.atproto.space.putRecord",
				{ ...write, repo: session.did },
				auth,
			),
		);
	}

	deleteRecord(
		session: HostSession,
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

	putRepoRecord(
		session: HostSession,
		write: { collection: string; rkey: string; record: Record<string, unknown> },
	): Promise<WriteResult> {
		return session.run((auth) =>
			this.xrpc.procedure<WriteResult>(
				"com.atproto.repo.putRecord",
				{ ...write, repo: session.did },
				auth,
			),
		);
	}

	deleteRepoRecord(
		session: HostSession,
		params: { collection: string; rkey: string },
	): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure(
				"com.atproto.repo.deleteRecord",
				{ ...params, repo: session.did },
				auth,
			);
		});
	}

	applyWrites(
		session: HostSession,
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

	listSpaces(session: HostSession): Promise<{ spaces: Array<{ uri: string }> }> {
		return session.run((auth) =>
			this.xrpc.query<{ spaces: Array<{ uri: string }> }>("com.atproto.space.listSpaces", {}, auth),
		);
	}

	createSpace(
		session: HostSession,
		params: {
			spaceType: string;
			skey?: string;
			policy: SpacePolicy;
		},
	): Promise<{ uri: SpaceRefString }> {
		return session.run((auth) =>
			this.xrpc.procedure<{ uri: SpaceRefString }>("com.atproto.space.createSpace", params, auth),
		);
	}

	updateSpace(
		session: HostSession,
		params: {
			space: SpaceRefString;
			policy: SpacePolicy;
		},
	): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure("com.atproto.space.updateSpace", params, auth);
		});
	}

	deleteSpace(session: HostSession, space: SpaceRefString): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure("com.atproto.space.deleteSpace", { space }, auth);
		});
	}

	getSpace(session: HostSession, space: SpaceRefString): Promise<SpaceConfiguration> {
		return session.run((auth) =>
			this.xrpc.query<SpaceConfiguration>("com.atproto.space.getSpace", { space }, auth),
		);
	}

	putMember(
		session: HostSession,
		space: SpaceRefString,
		did: string,
		access: SpaceMemberAccess,
	): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure(
				"com.atproto.memberspace.putMember",
				{ space, did, read: access.read, write: access.write },
				auth,
			);
		});
	}

	listMembers(
		session: HostSession,
		space: SpaceRefString,
		options: { limit?: number; cursor?: string } = {},
	): Promise<{ members: SpaceMember[]; cursor?: string }> {
		return session.run((auth) =>
			this.xrpc.query<{ members: SpaceMember[]; cursor?: string }>(
				"com.atproto.memberspace.listMembers",
				{ space, ...options },
				auth,
			),
		);
	}

	removeMember(session: HostSession, space: SpaceRefString, did: string): Promise<void> {
		return session.run(async (auth) => {
			await this.xrpc.procedure("com.atproto.memberspace.removeMember", { space, did }, auth);
		});
	}

	getPublicRecord<T>(repo: string, collection: string, rkey: string): Promise<T> {
		return this.xrpc.query<T>("com.atproto.repo.getRecord", { repo, collection, rkey });
	}

	listPublicRecords<T>(
		repo: string,
		collection: string,
		options: { limit?: number; cursor?: string; reverse?: boolean } = {},
	): Promise<{ records: Array<{ uri: string; cid: string; value: T }>; cursor?: string }> {
		return this.xrpc.query("com.atproto.repo.listRecords", { repo, collection, ...options });
	}

	resolveHandle(handle: string): Promise<{ did: string }> {
		return this.xrpc.query<{ did: string }>("com.atproto.identity.resolveHandle", { handle });
	}

	uploadBlob(
		session: HostSession,
		bytes: Uint8Array,
		mimeType: string,
	): Promise<{ blob: unknown }> {
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

	updateAccountEmail(did: string, email: string): Promise<void> {
		return this.xrpc
			.procedure("com.atproto.admin.updateAccountEmail", { account: did, email }, this.auth)
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
