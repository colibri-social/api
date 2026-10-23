import type { CredentialSource, Queryable, Schema } from "@colibri-social/appview-db";
import type { HostSession, PdsAdmin } from "@colibri-social/space";
import { PdsClient, XrpcError } from "@colibri-social/space";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { generatePassword, type SecretBox } from "./crypto.js";

export type CredentialFailure =
	| "notProvisioned"
	| "rejected"
	| "unrecoverable"
	| "recoveryUnavailable"
	| "reauthRequired"
	| "handOverUnavailable";

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

export class HostAuthorizationLost extends Error {
	constructor(
		readonly community: string,
		options?: { cause?: unknown },
	) {
		super(`the authorization to act as ${community} is gone`, options);
		this.name = "HostAuthorizationLost";
	}
}

export type CommunityHost = {
	pds: PdsClient;
	session: HostSession;
};

export type OAuthHosts = {
	open(community: string): Promise<CommunityHost>;
	revoke?(community: string): Promise<void>;
};

export type CredentialStoreDeps = {
	db: Queryable;
	tables: Schema;
	secrets: SecretBox;
	pds: PdsClient;
	admin: PdsAdmin | null;
	oauth?: OAuthHosts;
	currentHost?: (community: string) => Promise<string>;
	clientFor?: (endpoint: string) => PdsClient;
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

export type OAuthCredentials = {
	community: string;
	pdsEndpoint: string;
	identifier: string;
	connectedBy: string;
};

export type HandOverState = {
	handedOverBy: string;
	expiresAt: string;
};

export type CredentialRecord = {
	community: string;
	pdsEndpoint: string;
	identifier: string;
	source: CredentialSource;
	connectedBy: string | null;
	needsReauthAt: string | null;
	handOver: HandOverState | null;
	createdAt: string;
};

export type HandOverResult = {
	password: string;
	identifier: string;
	expiresAt: string;
};

export type ExpiredHandOvers = {
	reset: string[];
	moved: string[];
};

const RECOVERY_COOLDOWN_MS = 30_000;
const UNRECOVERABLE_BACKOFF_MS = 10 * 60 * 1000;

export const HAND_OVER_TTL_MS = 60 * 60 * 1000;

export const isCredentialRejection = (error: unknown): boolean =>
	error instanceof XrpcError &&
	[
		"AuthenticationRequired",
		"InvalidPassword",
		"AuthFactorTokenRequired",
		"AccountNotFound",
	].includes(error.code);

const sameEndpoint = (a: string, b: string): boolean =>
	a.replace(/\/$/, "") === b.replace(/\/$/, "");

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

	async store(
		credentials: StoredCredentials,
		extras: { handOver?: HandOverState } = {},
	): Promise<void> {
		const sealed = await this.deps.secrets.seal(credentials.password);
		const row = {
			community: credentials.community,
			pdsEndpoint: credentials.pdsEndpoint,
			identifier: credentials.identifier,
			passwordCiphertextBase64: sealed.ciphertextBase64,
			passwordNonceBase64: sealed.nonceBase64,
			source: credentials.source,
			connectedBy: null,
			needsReauthAt: null,
			handedOverBy: extras.handOver?.handedOverBy ?? null,
			handOverExpiresAt: extras.handOver?.expiresAt ?? null,
			createdAt: this.now().toISOString(),
		};
		await this.deps.db
			.insert(this.deps.tables.communityCredentials)
			.values(row)
			.onConflictDoUpdate({ target: this.deps.tables.communityCredentials.community, set: row });
		this.hosts.delete(credentials.community);
	}

	async storeOAuth(credentials: OAuthCredentials): Promise<void> {
		const row = {
			community: credentials.community,
			pdsEndpoint: credentials.pdsEndpoint,
			identifier: credentials.identifier,
			passwordCiphertextBase64: null,
			passwordNonceBase64: null,
			source: "oauth" as const,
			connectedBy: credentials.connectedBy,
			needsReauthAt: null,
			handedOverBy: null,
			handOverExpiresAt: null,
			createdAt: this.now().toISOString(),
		};
		await this.deps.db
			.insert(this.deps.tables.communityCredentials)
			.values(row)
			.onConflictDoUpdate({ target: this.deps.tables.communityCredentials.community, set: row });
		this.hosts.delete(credentials.community);
	}

	async describe(community: string): Promise<CredentialRecord | null> {
		const table = this.deps.tables.communityCredentials;
		const [row] = await this.deps.db
			.select()
			.from(table)
			.where(eq(table.community, community))
			.limit(1);
		if (!row) return null;
		return {
			community: row.community,
			pdsEndpoint: row.pdsEndpoint,
			identifier: row.identifier,
			source: row.source,
			connectedBy: row.connectedBy,
			needsReauthAt: row.needsReauthAt,
			handOver:
				row.handedOverBy && row.handOverExpiresAt
					? { handedOverBy: row.handedOverBy, expiresAt: row.handOverExpiresAt }
					: null,
			createdAt: row.createdAt,
		};
	}

	async has(community: string): Promise<boolean> {
		return (await this.describe(community)) !== null;
	}

	async load(community: string): Promise<StoredCredentials | null> {
		const table = this.deps.tables.communityCredentials;
		const [row] = await this.deps.db
			.select()
			.from(table)
			.where(eq(table.community, community))
			.limit(1);
		if (!row || row.source === "oauth") return null;
		if (!row.passwordCiphertextBase64 || !row.passwordNonceBase64) return null;
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
		const record = await this.describe(community);
		if (record?.source === "oauth") {
			await this.deps.oauth?.revoke?.(community).catch(() => undefined);
		}
		await this.deps.db
			.delete(this.deps.tables.communityCredentials)
			.where(eq(this.deps.tables.communityCredentials.community, community));
	}

	evict(community: string): void {
		this.hosts.delete(community);
	}

	async markNeedsReauth(community: string): Promise<void> {
		this.hosts.delete(community);
		const table = this.deps.tables.communityCredentials;
		await this.deps.db
			.update(table)
			.set({ needsReauthAt: this.now().toISOString() })
			.where(eq(table.community, community));
		this.deps.log?.("credentials.needsReauth", { community });
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

	async session(community: string): Promise<HostSession> {
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

	private reauthRequired(community: string, cause?: unknown): CommunityCredentialError {
		return new CommunityCredentialError(
			community,
			"reauthRequired",
			`${community} needs its owner to sign in again before the AppView can act for it`,
			cause === undefined ? undefined : { cause },
		);
	}

	private async openOAuth(record: CredentialRecord): Promise<CommunityHost> {
		if (record.needsReauthAt) throw this.reauthRequired(record.community);
		if (!this.deps.oauth) {
			throw new CommunityCredentialError(
				record.community,
				"recoveryUnavailable",
				"host sign-in is not configured on this AppView, so it cannot act for this community",
			);
		}
		try {
			return await this.deps.oauth.open(record.community);
		} catch (error) {
			if (!(error instanceof HostAuthorizationLost)) throw error;
			await this.markNeedsReauth(record.community);
			throw this.reauthRequired(record.community, error);
		}
	}

	private async openHost(community: string): Promise<CommunityHost> {
		const record = await this.describe(community);
		if (record?.source === "oauth") return this.openOAuth(record);
		if (record?.needsReauthAt) throw this.reauthRequired(community);

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

	private async movedAway(community: string): Promise<boolean> {
		if (!this.deps.currentHost) return false;
		const current = await this.deps.currentHost(community).catch(() => null);
		return current !== null && !sameEndpoint(current, this.deps.pds.service);
	}

	async recover(community: string, stored?: StoredCredentials): Promise<StoredCredentials> {
		if (stored && stored.pdsEndpoint !== this.deps.pds.service) {
			throw new CommunityCredentialError(
				community,
				"recoveryUnavailable",
				`${community} is hosted on ${stored.pdsEndpoint}, so this AppView cannot reset its password`,
			);
		}

		if (await this.movedAway(community)) {
			await this.markNeedsReauth(community);
			throw this.reauthRequired(community);
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

	async handOver(
		community: string,
		request: { email: string; handedOverBy: string; ttlMs?: number },
	): Promise<HandOverResult> {
		const unavailable = (message: string) =>
			new CommunityCredentialError(community, "handOverUnavailable", message);
		const admin = this.deps.admin;
		if (!admin) throw unavailable("no PDS admin password is configured on this AppView");
		const stored = await this.load(community);
		if (!stored || !sameEndpoint(stored.pdsEndpoint, this.deps.pds.service)) {
			throw unavailable(`${community} is not hosted on this AppView's PDS`);
		}
		if (await this.movedAway(community)) {
			throw unavailable(`${community} already lives on another server`);
		}

		await admin.updateAccountEmail(community, request.email);
		const password = generatePassword();
		await admin.updateAccountPassword(community, password);
		const expiresAt = new Date(
			this.now().getTime() + (request.ttlMs ?? HAND_OVER_TTL_MS),
		).toISOString();
		await this.store(
			{ ...stored, password },
			{ handOver: { handedOverBy: request.handedOverBy, expiresAt } },
		);
		this.deps.log?.("credentials.handedOver", { community, expiresAt });
		return { password, identifier: stored.identifier, expiresAt };
	}

	async expireHandOvers(): Promise<ExpiredHandOvers> {
		const table = this.deps.tables.communityCredentials;
		const due = await this.deps.db
			.select({ community: table.community })
			.from(table)
			.where(
				and(
					isNotNull(table.handOverExpiresAt),
					lte(table.handOverExpiresAt, this.now().toISOString()),
				),
			);
		const result: ExpiredHandOvers = { reset: [], moved: [] };
		for (const { community } of due) {
			if (await this.movedAway(community)) {
				await this.deps.db
					.update(table)
					.set({
						handedOverBy: null,
						handOverExpiresAt: null,
						needsReauthAt: this.now().toISOString(),
					})
					.where(eq(table.community, community));
				this.hosts.delete(community);
				result.moved.push(community);
				continue;
			}
			const stored = await this.load(community);
			const admin = this.deps.admin;
			if (!stored || !admin) continue;
			const password = generatePassword();
			await admin.updateAccountPassword(community, password);
			await this.store({ ...stored, password });
			this.deps.log?.("credentials.handOverExpired", { community });
			result.reset.push(community);
		}
		return result;
	}

	async hostChanged(community: string): Promise<boolean> {
		const record = await this.describe(community);
		if (!record || !this.deps.currentHost) return false;
		const current = await this.deps.currentHost(community).catch(() => null);
		this.hosts.delete(community);
		if (current === null || sameEndpoint(current, record.pdsEndpoint)) return false;
		await this.markNeedsReauth(community);
		this.deps.log?.("credentials.hostChanged", {
			community,
			from: record.pdsEndpoint,
			to: current,
		});
		return true;
	}
}
