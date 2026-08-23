import type { Queryable, Schema } from "@colibri-social/appview-db";
import type { PdsAdmin, PdsClient, PdsSession } from "@colibri-social/space";
import { XrpcError } from "@colibri-social/space";
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
	now?: () => Date;
	log?: (event: string, detail: Record<string, unknown>) => void;
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

const isCredentialRejection = (error: unknown): boolean =>
	error instanceof XrpcError &&
	[
		"AuthenticationRequired",
		"InvalidPassword",
		"AuthFactorTokenRequired",
		"AccountNotFound",
	].includes(error.code);

export class CommunityCredentials {
	private readonly sessions = new Map<string, Promise<PdsSession>>();
	private readonly nextAttemptAt = new Map<string, number>();
	private readonly now: () => Date;

	constructor(private readonly deps: CredentialStoreDeps) {
		this.now = deps.now ?? (() => new Date());
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
		this.sessions.delete(credentials.community);
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
		this.sessions.delete(community);
		await this.deps.db
			.delete(this.deps.tables.communityCredentials)
			.where(eq(this.deps.tables.communityCredentials.community, community));
	}

	session(community: string): Promise<PdsSession> {
		const existing = this.sessions.get(community);
		if (existing) return existing;
		const pending = this.openSession(community).catch((error: unknown) => {
			this.sessions.delete(community);
			throw error;
		});
		this.sessions.set(community, pending);
		return pending;
	}

	private async openSession(community: string): Promise<PdsSession> {
		const stored = await this.load(community);
		if (!stored) {
			const recovered = await this.recover(community);
			return this.deps.pds.login({
				identifier: recovered.identifier,
				password: recovered.password,
			});
		}

		try {
			return await this.deps.pds.login({
				identifier: stored.identifier,
				password: stored.password,
			});
		} catch (error) {
			if (!isCredentialRejection(error)) throw error;
			this.deps.log?.("credentials.rejected", { community });
			const recovered = await this.recover(community, stored);
			return this.deps.pds.login({
				identifier: recovered.identifier,
				password: recovered.password,
			});
		}
	}

	async recover(community: string, stored?: StoredCredentials): Promise<StoredCredentials> {
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
