import type { Queryable, Schema } from "@colibri-social/appview-db";
import type { PdsAdmin, PdsSession } from "@colibri-social/space";
import { PdsClient, XrpcError } from "@colibri-social/space";
import { eq } from "drizzle-orm";
import { generatePassword, type SecretBox } from "./crypto.js";

export type CredentialFailure =
	| "notProvisioned"
	| "rejected"
	| "unrecoverable"
	| "recoveryUnavailable";

export class CommunityCredentialError extends Error {
	constructor(
		readonly community: string,
		readonly failure: CredentialFailure,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "CommunityCredentialError";
	}
}

export type CredentialStoreDeps = {
	db: Queryable;
	tables: Schema;
	secrets: SecretBox;
	pds: PdsClient;
	admin: PdsAdmin | null;
	clientFor?: (endpoint: string) => PdsClient;
	now?: () => Date;
	log?: (event: string, detail: Record<string, unknown>) => void;
};

export type CommunityHost = {
	pds: PdsClient;
	session: PdsSession;
};

export type StoredCredentials = {
	community: string;
	pdsEndpoint: string;
	identifier: string;
	password: string;
	source: "provisioned" | "registered";
};

const RECOVERY_COOLDOWN_MS = 30_000;
const UNRECOVERABLE_BACKOFF_MS = 10 * 60 * 1000;

export const isCredentialRejection = (error: unknown): boolean =>
	error instanceof XrpcError &&
	[
		"AuthenticationRequired",
		"InvalidPassword",
		"AuthFactorTokenRequired",
		"AccountNotFound",
	].includes(error.code);

export class CommunityCredentials {
	private readonly hosts = new Map<string, Promise<CommunityHost>>();
	private readonly clients = new Map<string, PdsClient>();
	private readonly nextAttemptAt = new Map<string, number>();
	private readonly now: () => Date;

	constructor(private readonly deps: CredentialStoreDeps) {
		this.now = deps.now ?? (() => new Date());
	}

	clientFor(endpoint: string): PdsClient {
		if (endpoint === this.deps.pds.service) return this.deps.pds;
		const existing = this.clients.get(endpoint);
		if (existing) return existing;
		const client = this.deps.clientFor?.(endpoint) ?? new PdsClient({ service: endpoint });
		this.clients.set(endpoint, client);
		return client;
	}

	async store(credentials: StoredCredentials): Promise<void> {
		const sealed = await this.deps.secrets.seal(credentials.password);
		const row = {
			community: credentials.community,
			pdsEndpoint: credentials.pdsEndpoint,
			identifier: credentials.identifier,
			passwordCiphertextBase64: sealed.ciphertextBase64,
			passwordNonceBase64: sealed.nonceBase64,
			source: credentials.source,
			createdAt: this.now().toISOString(),
		};
		await this.deps.db
			.insert(this.deps.tables.communityCredentials)
			.values(row)
			.onConflictDoUpdate({ target: this.deps.tables.communityCredentials.community, set: row });
		this.hosts.delete(credentials.community);
	}

	async load(community: string): Promise<StoredCredentials | null> {
		const [row] = await this.deps.db
			.select()
			.from(this.deps.tables.communityCredentials)
			.where(eq(this.deps.tables.communityCredentials.community, community))
			.limit(1);
		if (!row) return null;
		const password = await this.deps.secrets
			.open({
				ciphertextBase64: row.passwordCiphertextBase64,
				nonceBase64: row.passwordNonceBase64,
			})
			.catch(() => null);
		if (password === null) return null;
		return {
			community: row.community,
			pdsEndpoint: row.pdsEndpoint,
			identifier: row.identifier,
			password,
			source: row.source,
		};
	}

	async forget(community: string): Promise<void> {
		this.hosts.delete(community);
		await this.deps.db
			.delete(this.deps.tables.communityCredentials)
			.where(eq(this.deps.tables.communityCredentials.community, community));
	}

	connect(community: string): Promise<CommunityHost> {
		const existing = this.hosts.get(community);
		if (existing) return existing;
		const pending = this.openHost(community).catch((error: unknown) => {
			this.hosts.delete(community);
			throw error;
		});
		this.hosts.set(community, pending);
		return pending;
	}

	async session(community: string): Promise<PdsSession> {
		return (await this.connect(community)).session;
	}

	private async login(credentials: StoredCredentials): Promise<CommunityHost> {
		const pds = this.clientFor(credentials.pdsEndpoint);
		const session = await pds.login({
			identifier: credentials.identifier,
			password: credentials.password,
		});
		return { pds, session };
	}

	private async openHost(community: string): Promise<CommunityHost> {
		const stored = await this.load(community);
		if (!stored) return this.login(await this.recover(community));

		try {
			return await this.login(stored);
		} catch (error) {
			if (!isCredentialRejection(error)) throw error;
			this.deps.log?.("credentials.rejected", { community });
			return this.login(await this.recover(community, stored));
		}
	}

	async recover(community: string, stored?: StoredCredentials): Promise<StoredCredentials> {
		if (stored && stored.pdsEndpoint !== this.deps.pds.service) {
			throw new CommunityCredentialError(
				community,
				"recoveryUnavailable",
				`${community} is hosted on ${stored.pdsEndpoint}, so this AppView cannot reset its password`,
			);
		}

		if (!this.deps.admin) {
			throw new CommunityCredentialError(
				community,
				"recoveryUnavailable",
				"no PDS admin password is configured, so this community's access cannot be repaired",
			);
		}

		const blockedUntil = this.nextAttemptAt.get(community) ?? 0;
		if (Date.now() < blockedUntil) {
			throw new CommunityCredentialError(
				community,
				"unrecoverable",
				`recovery for ${community} is backing off until ${new Date(blockedUntil).toISOString()}`,
			);
		}
		this.nextAttemptAt.set(community, Date.now() + RECOVERY_COOLDOWN_MS);

		const info = await this.deps.admin.getAccountInfo(community).catch((cause: unknown) => {
			throw new CommunityCredentialError(
				community,
				"unrecoverable",
				`the PDS does not know about ${community}, so its password cannot be reset`,
				{ cause },
			);
		});

		const password = generatePassword();
		try {
			await this.deps.admin.updateAccountPassword(community, password);
		} catch (cause) {
			this.nextAttemptAt.set(community, Date.now() + UNRECOVERABLE_BACKOFF_MS);
			throw new CommunityCredentialError(
				community,
				"unrecoverable",
				`resetting the password for ${community} failed`,
				{ cause },
			);
		}

		const recovered: StoredCredentials = {
			community,
			pdsEndpoint: stored?.pdsEndpoint ?? this.deps.pds.service,
			identifier: info.handle ?? stored?.identifier ?? community,
			password,
			source: stored?.source ?? "provisioned",
		};
		await this.store(recovered);
		this.deps.log?.("credentials.recovered", { community });
		return recovered;
	}
}
