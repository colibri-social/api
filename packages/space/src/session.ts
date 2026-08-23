import { XrpcError } from "./errors.js";
import type { Auth, XrpcClient } from "./http.js";

export type SessionTokens = {
	did: string;
	handle: string;
	accessJwt: string;
	refreshJwt: string;
};

export type SessionCredentials = {
	identifier: string;
	password: string;
};

export class PdsSession {
	private tokens: SessionTokens;
	private refreshing: Promise<void> | null = null;

	private constructor(
		private readonly client: XrpcClient,
		private readonly credentials: SessionCredentials,
		tokens: SessionTokens,
	) {
		this.tokens = tokens;
	}

	static async login(client: XrpcClient, credentials: SessionCredentials): Promise<PdsSession> {
		const tokens = await client.procedure<SessionTokens>("com.atproto.server.createSession", {
			identifier: credentials.identifier,
			password: credentials.password,
		});
		return new PdsSession(client, credentials, tokens);
	}

	get did(): string {
		return this.tokens.did;
	}

	get handle(): string {
		return this.tokens.handle;
	}

	get auth(): Auth {
		return { kind: "bearer", token: this.tokens.accessJwt };
	}

	async run<T>(call: (auth: Auth) => Promise<T>): Promise<T> {
		try {
			return await call(this.auth);
		} catch (error) {
			if (!(error instanceof XrpcError) || !error.isExpiredToken) throw error;
			await this.renew();
			return call(this.auth);
		}
	}

	private async renew(): Promise<void> {
		this.refreshing ??= this.doRenew().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	private async doRenew(): Promise<void> {
		try {
			this.tokens = await this.client.procedure<SessionTokens>(
				"com.atproto.server.refreshSession",
				undefined,
				{ kind: "bearer", token: this.tokens.refreshJwt },
			);
		} catch {
			this.tokens = await this.client.procedure<SessionTokens>("com.atproto.server.createSession", {
				identifier: this.credentials.identifier,
				password: this.credentials.password,
			});
		}
	}
}
