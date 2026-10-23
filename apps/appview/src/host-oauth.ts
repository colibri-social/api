import {
	JoseKey,
	NodeOAuthClient,
	type NodeSavedSession,
	type NodeSavedSessionStore,
	type NodeSavedState,
	type NodeSavedStateStore,
	type OAuthClientMetadataInput,
	type OAuthSession,
	requestLocalLock,
	TokenInvalidError,
	TokenRefreshError,
	TokenRevokedError,
} from "@atproto/oauth-client-node";
import type { Database } from "@colibri-social/appview-db";
import {
	type CommunityHost,
	HostAuthorizationLost,
	type OAuthHosts,
	type SecretBox,
} from "@colibri-social/community";
import { type Auth, type HostSession, PdsClient } from "@colibri-social/space";
import { eq, lt } from "drizzle-orm";

export const HOST_OAUTH_PATHS = {
	metadata: "/oauth/host/client-metadata.json",
	jwks: "/oauth/host/jwks.json",
	callback: "/oauth/host/callback",
} as const;

const STATE_TTL_MS = 60 * 60 * 1000;

export const hostOAuthScope = (appviewDid: string): string =>
	[
		"atproto",
		"blob:*/*",
		`include:social.colibri.beta.permissionCommunity?aud=${appviewDid}#colibri_appview`,
		`include:social.colibri.beta.permissionMessaging?aud=${appviewDid}#colibri_appview`,
	].join(" ");

export const hostOAuthMetadata = (
	publicUrl: string,
	appviewDid: string,
): OAuthClientMetadataInput => {
	const base = publicUrl.replace(/\/$/, "");
	return {
		client_id: `${base}${HOST_OAUTH_PATHS.metadata}`,
		client_name: "Colibri",
		client_uri: "https://colibri.social",
		redirect_uris: [`${base}${HOST_OAUTH_PATHS.callback}`],
		jwks_uri: `${base}${HOST_OAUTH_PATHS.jwks}`,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		scope: hostOAuthScope(appviewDid),
		application_type: "web",
		token_endpoint_auth_method: "private_key_jwt",
		token_endpoint_auth_signing_alg: "ES256",
		dpop_bound_access_tokens: true,
	} as OAuthClientMetadataInput;
};

export const isAuthorizationLost = (error: unknown): boolean =>
	error instanceof TokenRefreshError ||
	error instanceof TokenRevokedError ||
	error instanceof TokenInvalidError;

const sealedStore = <V>(
	secrets: SecretBox,
	read: (key: string) => Promise<{ ciphertextBase64: string; nonceBase64: string } | undefined>,
	write: (key: string, sealed: { ciphertextBase64: string; nonceBase64: string }) => Promise<void>,
	remove: (key: string) => Promise<void>,
) => ({
	async get(key: string): Promise<V | undefined> {
		const row = await read(key);
		if (!row) return undefined;
		const plain = await secrets.open(row).catch(() => null);
		return plain === null ? undefined : (JSON.parse(plain) as V);
	},
	async set(key: string, value: V): Promise<void> {
		await write(key, await secrets.seal(JSON.stringify(value)));
	},
	async del(key: string): Promise<void> {
		await remove(key);
	},
});

const sessionStore = (database: Database, secrets: SecretBox): NodeSavedSessionStore => {
	const table = database.tables.hostOauthSessions;
	return sealedStore<NodeSavedSession>(
		secrets,
		async (sub) => {
			const [row] = await database.db.select().from(table).where(eq(table.sub, sub)).limit(1);
			return row;
		},
		async (sub, sealed) => {
			const row = { sub, ...sealed, updatedAt: new Date().toISOString() };
			await database.db
				.insert(table)
				.values(row)
				.onConflictDoUpdate({ target: table.sub, set: row });
		},
		async (sub) => {
			await database.db.delete(table).where(eq(table.sub, sub));
		},
	);
};

const stateStore = (database: Database, secrets: SecretBox): NodeSavedStateStore => {
	const table = database.tables.hostOauthStates;
	return sealedStore<NodeSavedState>(
		secrets,
		async (key) => {
			const [row] = await database.db.select().from(table).where(eq(table.key, key)).limit(1);
			return row;
		},
		async (key, sealed) => {
			const cutoff = new Date(Date.now() - STATE_TTL_MS).toISOString();
			await database.db.delete(table).where(lt(table.createdAt, cutoff));
			const row = { key, ...sealed, createdAt: new Date().toISOString() };
			await database.db
				.insert(table)
				.values(row)
				.onConflictDoUpdate({ target: table.key, set: row });
		},
		async (key) => {
			await database.db.delete(table).where(eq(table.key, key));
		},
	);
};

const oauthHostSession = (
	session: OAuthSession,
	handle: string,
	onLost: (error: unknown) => void,
): HostSession => {
	const auth: Auth = {
		kind: "fetch",
		fetch: (input, init) =>
			session.fetchHandler(input instanceof Request ? input.url : String(input), init),
	};
	return {
		did: session.did,
		handle,
		async run<T>(call: (auth: Auth) => Promise<T>): Promise<T> {
			try {
				return await call(auth);
			} catch (error) {
				if (isAuthorizationLost(error)) {
					onLost(error);
					throw new HostAuthorizationLost(session.did, { cause: error });
				}
				throw error;
			}
		},
	};
};

export type HostOAuthDeps = {
	database: Database;
	secrets: SecretBox;
	publicUrl: string;
	appviewDid: string;
	privateKey: string;
	keyId: string;
	plcUrl: string;
	handleOf: (did: string) => Promise<string>;
	onLost: (community: string) => void;
	allowHttp?: boolean;
};

export type HostSignIn = {
	session: OAuthSession;
	host: CommunityHost;
	request: string;
};

export class HostOAuth implements OAuthHosts {
	private constructor(
		private readonly client: NodeOAuthClient,
		private readonly deps: HostOAuthDeps,
	) {}

	static async create(deps: HostOAuthDeps): Promise<HostOAuth> {
		const key = await JoseKey.fromImportable(deps.privateKey.replace(/\\n/g, "\n"), deps.keyId);
		const client = new NodeOAuthClient({
			clientMetadata: hostOAuthMetadata(deps.publicUrl, deps.appviewDid),
			keyset: [key],
			stateStore: stateStore(deps.database, deps.secrets),
			sessionStore: sessionStore(deps.database, deps.secrets),
			requestLock: requestLocalLock,
			plcDirectoryUrl: deps.plcUrl,
			allowHttp: deps.allowHttp ?? false,
		});
		return new HostOAuth(client, deps);
	}

	get clientMetadata(): unknown {
		return this.client.clientMetadata;
	}

	get jwks(): unknown {
		return this.client.jwks;
	}

	authorize(identifier: string, request: string): Promise<URL> {
		return this.client.authorize(identifier, {
			state: request,
			scope: hostOAuthScope(this.deps.appviewDid),
		});
	}

	async callback(params: URLSearchParams): Promise<HostSignIn> {
		const { session, state } = await this.client.callback(params);
		if (!state) throw new Error("the sign-in came back without its request");
		return { session, host: await this.hostFor(session), request: state };
	}

	async open(community: string): Promise<CommunityHost> {
		let session: OAuthSession;
		try {
			session = await this.client.restore(community, "auto");
		} catch (error) {
			if (isAuthorizationLost(error)) throw new HostAuthorizationLost(community, { cause: error });
			throw error;
		}
		return this.hostFor(session);
	}

	async revoke(community: string): Promise<void> {
		await this.client.revoke(community);
	}

	private async hostFor(session: OAuthSession): Promise<CommunityHost> {
		const info = await session.getTokenInfo(false);
		const handle = await this.deps.handleOf(session.did).catch(() => session.did);
		return {
			pds: new PdsClient({ service: info.aud.replace(/\/$/, "") }),
			session: oauthHostSession(session, handle, () => this.deps.onLost(session.did)),
		};
	}
}
