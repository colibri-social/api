import { parseSpaceToken } from "@atproto/space";
import { DpopKey } from "./dpop.js";
import { SpaceCredentialError, XrpcError } from "./errors.js";
import type { SpaceHostResolver } from "./host.js";
import { XrpcClient } from "./http.js";
import { parseSpaceRef, type SpaceRefString } from "./space-ref.js";

export type SpaceCredential = {
	credential: string;
	key: DpopKey;
	expiresAt: Date;
};

export type StoredCredential = {
	credential: string;
	privateJwk: string;
	thumbprint: string;
	expiresAt: Date;
};

export type CredentialStorage = {
	load(space: SpaceRefString): Promise<StoredCredential | null>;
	save(space: SpaceRefString, credential: StoredCredential): Promise<void>;
	forget(space: SpaceRefString): Promise<void>;
};

export const inMemoryCredentialStorage = (): CredentialStorage => {
	const held = new Map<string, StoredCredential>();
	return {
		load: async (space) => held.get(space) ?? null,
		save: async (space, credential) => void held.set(space, credential),
		forget: async (space) => void held.delete(space),
	};
};

export type DelegationTokenProvider = (space: SpaceRefString) => Promise<string | null>;

export type SpaceCredentialsOptions = {
	hosts: SpaceHostResolver;
	delegation: DelegationTokenProvider;
	storage?: CredentialStorage;
	clientAttestation?: (space: SpaceRefString) => Promise<string | undefined>;
	renewBeforeSeconds?: number;
	fetch?: typeof globalThis.fetch;
};

const GET_SPACE_CREDENTIAL = "com.atproto.space.getSpaceCredential";

export class SpaceCredentials {
	private readonly storage: CredentialStorage;
	private readonly renewBeforeMs: number;
	private readonly inFlight = new Map<string, Promise<SpaceCredential>>();

	constructor(private readonly options: SpaceCredentialsOptions) {
		this.storage = options.storage ?? inMemoryCredentialStorage();
		this.renewBeforeMs = (options.renewBeforeSeconds ?? 300) * 1000;
	}

	async acquire(space: SpaceRefString): Promise<SpaceCredential> {
		const existing = this.inFlight.get(space);
		if (existing) return existing;

		const pending = this.resolve(space).finally(() => this.inFlight.delete(space));
		this.inFlight.set(space, pending);
		return pending;
	}

	async acquireWith(space: SpaceRefString, delegationToken: string): Promise<SpaceCredential> {
		return this.mint(space, delegationToken);
	}

	async invalidate(space: SpaceRefString): Promise<void> {
		await this.storage.forget(space);
	}

	private async resolve(space: SpaceRefString): Promise<SpaceCredential> {
		const stored = await this.storage.load(space);
		if (stored && stored.expiresAt.getTime() - Date.now() > this.renewBeforeMs) {
			return {
				credential: stored.credential,
				key: await DpopKey.fromJwk(stored.privateJwk),
				expiresAt: stored.expiresAt,
			};
		}
		return this.mint(space);
	}

	private async mint(space: SpaceRefString, delegationToken?: string): Promise<SpaceCredential> {
		try {
			return await this.exchange(space, delegationToken);
		} catch (error) {
			const replayable =
				delegationToken === undefined &&
				error instanceof SpaceCredentialError &&
				error.reason === "invalidDelegationToken";
			if (!replayable) throw error;
			return this.exchange(space);
		}
	}

	private async exchange(
		space: SpaceRefString,
		delegationToken?: string,
	): Promise<SpaceCredential> {
		const token = delegationToken ?? (await this.options.delegation(space));
		if (!token) {
			throw new SpaceCredentialError(
				space,
				"noDelegationToken",
				`no session can mint a delegation token for ${space}`,
			);
		}

		const { authority } = parseSpaceRef(space);
		const host = await this.options.hosts.hostFor(authority);
		const key = await DpopKey.generate();
		const client = new XrpcClient({ service: host, fetch: this.options.fetch });
		const clientAttestation = await this.options.clientAttestation?.(space);

		const response = await client
			.procedure<{ credential: string }>(
				GET_SPACE_CREDENTIAL,
				clientAttestation ? { space, clientAttestation } : { space },
				{ kind: "dpopGrant", token, key },
			)
			.catch((cause: unknown) => {
				throw toCredentialError(space, cause);
			});

		const expiresAt = expiryOf(space, response.credential);
		await this.storage.save(space, {
			credential: response.credential,
			privateJwk: key.exportJwk(),
			thumbprint: key.thumbprint,
			expiresAt,
		});

		return { credential: response.credential, key, expiresAt };
	}
}

const expiryOf = (space: SpaceRefString, credential: string): Date => {
	try {
		return new Date(parseSpaceToken("credential", credential).payload.exp * 1000);
	} catch (cause) {
		throw new SpaceCredentialError(
			space,
			"upstream",
			"space host returned an unreadable credential",
			{
				cause,
			},
		);
	}
};

const toCredentialError = (space: SpaceRefString, cause: unknown): SpaceCredentialError => {
	if (cause instanceof XrpcError) {
		if (cause.isSpaceDeleted) {
			return new SpaceCredentialError(space, "spaceDeleted", `${space} has been deleted`, {
				cause,
			});
		}
		if (cause.code === "InvalidDelegationToken") {
			return new SpaceCredentialError(
				space,
				"invalidDelegationToken",
				`the authority rejected the delegation token for ${space}`,
				{ cause },
			);
		}
		if (
			cause.code === "UserNotAuthorized" ||
			cause.code === "AppNotAuthorized" ||
			cause.code === "NotAuthorized"
		) {
			return new SpaceCredentialError(
				space,
				"refused",
				`the authority refused access to ${space}`,
				{
					cause,
				},
			);
		}
	}
	return new SpaceCredentialError(space, "upstream", `could not obtain a credential for ${space}`, {
		cause,
	});
};
