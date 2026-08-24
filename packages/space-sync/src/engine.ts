import type { SpaceClient, SpaceCredentials } from "@colibri-social/space";
import { SpaceCredentialError } from "@colibri-social/space";
import { Emitter } from "./emitter.js";
import { KeyedWorkQueue } from "./queue.js";
import { RepoSync } from "./repo-sync.js";
import type {
	ChangeTiming,
	RepoCursor,
	RepoHostResolver,
	SigningKeyResolver,
	SyncEvents,
	SyncLog,
	SyncStore,
	SyncTrigger,
} from "./types.js";
import { inlineVerifier, type Verifier, VerifierPool } from "./verify-pool.js";

export type NotifyWriteHint = {
	rev?: string;
	setHashBase64?: string;
	trigger?: SyncTrigger;
	notifiedAt?: number;
};

export type SyncEngineOptions = {
	client: SpaceClient;
	credentials: SpaceCredentials;
	store: SyncStore;
	hosts: RepoHostResolver;
	keys: SigningKeyResolver;
	syncerService: string;
	concurrency?: number;
	sweepIntervalMs?: number;
	maxBackoffMs?: number;
	pageLimit?: number;
	registrationRenewMarginMs?: number;
	maxChaseAttempts?: number;
	workerThreads?: number;
	verifier?: Verifier;
	repos?: Pick<RepoSync, "sync">;
	now?: () => Date;
	log?: SyncLog;
};

const KEY_SEPARATOR = " ";
const encodeKey = (space: string, author: string) => `${space}${KEY_SEPARATOR}${author}`;
const decodeKey = (key: string) => {
	const [space = "", author = ""] = key.split(KEY_SEPARATOR);
	return { space, author };
};

const REGISTRATION_TICK_MS = 30_000;
const REGISTRATION_RETRY_BASE_MS = 5_000;
const REGISTRATION_RETRY_MAX_MS = 60_000;
const DEFAULT_RENEW_MARGIN_MS = 120_000;
const DEFAULT_CHASE_ATTEMPTS = 3;

const backoffFor = (failures: number, maxMs: number) =>
	Math.min(maxMs, 2 ** Math.min(failures, 10) * 1000);

const laterRev = (a: string | null, b: string | null): string | null => {
	if (!a) return b;
	if (!b) return a;
	return a > b ? a : b;
};

type PendingTarget = {
	rev: string | null;
	setHashBase64: string | null;
	trigger: SyncTrigger;
	notifiedAt: number;
	attempts: number;
};

type RegistrationState = {
	expiresAt: Date | null;
	registeredAt: Date | null;
	retryAt: Date | null;
	failures: number;
};

export class SpaceSyncEngine {
	private readonly repos: Pick<RepoSync, "sync">;
	private readonly verifier: Verifier;
	private readonly ownsVerifier: boolean;
	private readonly queue: KeyedWorkQueue;
	private readonly events = new Emitter<SyncEvents>();
	private readonly targets = new Map<string, PendingTarget>();
	private readonly appliedRevs = new Map<string, string>();
	private readonly registrations = new Map<string, RegistrationState>();
	private readonly now: () => Date;
	private sweepTimer: NodeJS.Timeout | null = null;
	private registrationTimer: NodeJS.Timeout | null = null;
	private started = false;
	private sweeping = false;

	constructor(private readonly options: SyncEngineOptions) {
		this.now = options.now ?? (() => new Date());
		this.ownsVerifier = options.verifier === undefined;
		this.verifier =
			options.verifier ??
			(options.workerThreads
				? new VerifierPool({
						size: options.workerThreads,
						onWorkerDied: (error) => this.log("verify.workerDied", { error }),
					})
				: inlineVerifier());
		this.repos =
			options.repos ??
			new RepoSync({
				client: options.client,
				store: options.store,
				hosts: options.hosts,
				keys: options.keys,
				verifier: this.verifier,
				...(options.pageLimit === undefined ? {} : { pageLimit: options.pageLimit }),
			});
		this.queue = new KeyedWorkQueue((key) => this.syncOne(key), {
			concurrency: options.concurrency ?? 16,
			onError: (key, error) => {
				const { space, author } = decodeKey(key);
				this.emit("failed", space, author, error);
			},
		});
	}

	on<K extends keyof SyncEvents>(event: K, listener: SyncEvents[K]): () => void {
		return this.events.on(event, listener);
	}

	private emit<K extends keyof SyncEvents>(event: K, ...args: Parameters<SyncEvents[K]>): void {
		this.events.emit(event, ...args);
	}

	private log(
		event: string,
		detail: Record<string, unknown>,
		level: "debug" | "warn" = "warn",
	): void {
		this.options.log?.(event, detail, level);
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		await this.loadRegistrations();
		await this.sweep();
		const interval = this.options.sweepIntervalMs ?? 300_000;
		this.sweepTimer = setInterval(() => void this.sweep(), interval);
		this.sweepTimer.unref?.();
		this.registrationTimer = setInterval(
			() => void this.renewRegistrations(),
			REGISTRATION_TICK_MS,
		);
		this.registrationTimer.unref?.();
	}

	async stop(): Promise<void> {
		this.started = false;
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		if (this.registrationTimer) clearInterval(this.registrationTimer);
		this.registrationTimer = null;
		this.queue.stop();
		if (this.ownsVerifier) await this.verifier.close();
	}

	notifyWrite(space: string, author: string, hint: NotifyWriteHint = {}): void {
		const key = encodeKey(space, author);
		const rev = hint.rev ?? null;

		if (rev && this.isApplied(key, rev)) {
			this.log("repo.notifySkipped", { space, author, rev }, "debug");
			return;
		}

		const existing = this.targets.get(key);
		this.targets.set(key, {
			rev: laterRev(existing?.rev ?? null, rev),
			setHashBase64: hint.setHashBase64 ?? existing?.setHashBase64 ?? null,
			trigger: existing?.trigger ?? hint.trigger ?? "notify",
			notifiedAt: existing?.notifiedAt ?? hint.notifiedAt ?? Date.now(),
			attempts: existing?.attempts ?? 0,
		});

		this.queue.push(key);
	}

	notifySpaceDeleted(space: string): void {
		void this.dropSpace(space).catch((error: unknown) =>
			this.log("dropSpace.failed", { space, error }),
		);
	}

	async drain(): Promise<void> {
		await this.queue.onIdle();
	}

	async sweep(): Promise<void> {
		if (this.sweeping) {
			this.log("sweep.skipped", {}, "debug");
			return;
		}
		this.sweeping = true;
		try {
			const spaces = await this.options.store.listSpaces();
			for (const space of spaces) {
				await this.sweepSpace(space.uri).catch((error) =>
					this.log("sweep.failed", { space: space.uri, error }),
				);
			}
		} finally {
			this.sweeping = false;
		}
	}

	async sweepSpace(space: string): Promise<void> {
		await this.ensureRegistered(space);

		const cursors = new Map<string, RepoCursor>();
		for (const cursor of await this.options.store.listCursors(space)) {
			cursors.set(cursor.author, cursor);
			if (cursor.appliedRev) {
				this.appliedRevs.set(encodeKey(space, cursor.author), cursor.appliedRev);
			}
		}

		const seen = new Set<string>();
		const stale: string[] = [];

		try {
			for await (const repo of this.options.client.allRepos(space)) {
				seen.add(repo.did);
				const cursor = cursors.get(repo.did);
				if (this.shouldSync(cursor, repo.rev)) stale.push(encodeKey(space, repo.did));
			}
		} catch (error) {
			if (error instanceof SpaceCredentialError && error.reason === "spaceDeleted") {
				await this.dropSpace(space);
				return;
			}
			throw error;
		}

		const expected = new Set(await this.expectedRepos(space));
		for (const repo of expected) {
			if (seen.has(repo)) continue;
			if (!this.mayHaveAdvanced(cursors.get(repo))) continue;
			stale.push(encodeKey(space, repo));
		}

		for (const [author, cursor] of cursors) {
			if (seen.has(author) || expected.has(author) || cursor.state === "gone") continue;
			await this.options.store.dropRepo(space, author);
			this.forgetRepo(space, author);
			this.emit("repoGone", space, author);
		}

		this.queue.pushAll(stale);
	}

	private async expectedRepos(space: string): Promise<string[]> {
		if (!this.options.store.expectedRepos) return [];
		return this.options.store.expectedRepos(space).catch((error: unknown) => {
			this.log("expectedRepos.failed", { space, error });
			return [];
		});
	}

	private mayHaveAdvanced(cursor: RepoCursor | undefined): boolean {
		if (!cursor) return true;
		if (cursor.state === "gone") return false;
		return !cursor.retryAfter || cursor.retryAfter <= this.now();
	}

	private shouldSync(cursor: RepoCursor | undefined, remoteRev: string): boolean {
		if (!cursor) return true;
		if (cursor.state === "gone") return false;
		if (cursor.retryAfter && cursor.retryAfter > this.now()) return false;
		if (cursor.appliedRev === null) return true;
		return cursor.appliedRev < remoteRev;
	}

	private isApplied(key: string, rev: string): boolean {
		const applied = this.appliedRevs.get(key);
		return applied !== undefined && applied >= rev;
	}

	private forgetRepo(space: string, author: string): void {
		const key = encodeKey(space, author);
		this.targets.delete(key);
		this.appliedRevs.delete(key);
	}

	private async loadRegistrations(): Promise<void> {
		if (!this.options.store.listRegistrations) return;
		const rows = await this.options.store.listRegistrations().catch((error: unknown) => {
			this.log("listRegistrations.failed", { error });
			return [];
		});
		for (const row of rows) {
			if (row.service !== this.options.syncerService) continue;
			this.registrations.set(row.space, {
				expiresAt: row.expiresAt,
				registeredAt: null,
				retryAt: null,
				failures: 0,
			});
		}
	}

	private async ensureRegistered(space: string): Promise<void> {
		const state = this.trackSpace(space);
		if (!this.registrationDue(state, this.now())) return;
		await this.register(space, state);
	}

	private trackSpace(space: string): RegistrationState {
		const existing = this.registrations.get(space);
		if (existing) return existing;
		const fresh: RegistrationState = {
			expiresAt: null,
			registeredAt: null,
			retryAt: null,
			failures: 0,
		};
		this.registrations.set(space, fresh);
		return fresh;
	}

	private renewMarginFor(state: RegistrationState): number {
		const configured =
			this.options.registrationRenewMarginMs ??
			Math.max(2 * (this.options.sweepIntervalMs ?? 300_000), DEFAULT_RENEW_MARGIN_MS);
		if (!state.expiresAt || !state.registeredAt) return configured;
		const lifetime = state.expiresAt.getTime() - state.registeredAt.getTime();
		if (lifetime <= 0) return configured;
		return Math.min(configured, lifetime / 2);
	}

	private registrationDue(state: RegistrationState, now: Date): boolean {
		if (state.retryAt) return state.retryAt <= now;
		if (!state.expiresAt) return true;
		return now.getTime() >= state.expiresAt.getTime() - this.renewMarginFor(state);
	}

	private async renewRegistrations(): Promise<void> {
		const now = this.now();
		for (const [space, state] of this.registrations) {
			if (!this.registrationDue(state, now)) continue;
			await this.register(space, state);
		}
	}

	private async register(space: string, state: RegistrationState): Promise<void> {
		const now = this.now();
		if (state.expiresAt && state.expiresAt <= now) {
			this.log("registerNotify.lapsed", {
				space,
				downMs: now.getTime() - state.expiresAt.getTime(),
			});
		}

		try {
			const { expiresAt } = await this.options.client.registerNotify(
				space,
				this.options.syncerService,
			);
			state.expiresAt = expiresAt;
			state.registeredAt = now;
			state.retryAt = null;
			state.failures = 0;
			await this.options.store
				.saveRegistration?.({ space, service: this.options.syncerService, expiresAt })
				.catch((error: unknown) => this.log("saveRegistration.failed", { space, error }));
			this.log("registerNotify.renewed", { space, expiresAt: expiresAt.toISOString() }, "debug");
		} catch (error) {
			state.failures += 1;
			state.retryAt = new Date(
				now.getTime() +
					Math.min(
						REGISTRATION_RETRY_MAX_MS,
						REGISTRATION_RETRY_BASE_MS * 2 ** (state.failures - 1),
					),
			);
			this.log("registerNotify.failed", { space, failures: state.failures, error });
		}
	}

	private async dropSpace(space: string): Promise<void> {
		this.registrations.delete(space);
		for (const key of [...this.targets.keys()]) {
			if (decodeKey(key).space === space) this.targets.delete(key);
		}
		for (const key of [...this.appliedRevs.keys()]) {
			if (decodeKey(key).space === space) this.appliedRevs.delete(key);
		}
		await this.options.credentials.invalidate(space);
		await this.options.store.dropSpace(space);
		this.emit("spaceDeleted", space);
	}

	private async syncOne(key: string): Promise<void> {
		const { space, author } = decodeKey(key);
		const target = this.targets.get(key);
		const startedAt = Date.now();

		if (target?.rev && this.isApplied(key, target.rev)) {
			this.targets.delete(key);
			this.log("repo.notifySkipped", { space, author, rev: target.rev }, "debug");
			return;
		}

		try {
			const outcome = await this.repos.sync(space, author);
			const committedAt = Date.now();

			if (outcome.kind === "gone") {
				this.forgetRepo(space, author);
				this.emit("repoGone", space, author);
				return;
			}

			if (outcome.appliedRev) this.appliedRevs.set(key, outcome.appliedRev);

			if (outcome.kind === "advanced" || outcome.kind === "recovered") {
				this.emit("changed", {
					...outcome.change,
					timing: this.timingFor(target, startedAt, committedAt),
				});
			}

			this.log(
				"repo.synced",
				{
					space,
					author,
					trigger: target?.trigger ?? "sweep",
					outcome: outcome.kind,
					appliedRev: outcome.appliedRev,
					queueMs: target ? startedAt - target.notifiedAt : null,
					syncMs: committedAt - startedAt,
				},
				"debug",
			);

			this.settleTarget(key, outcome.appliedRev);
		} catch (error) {
			this.targets.delete(key);
			await this.recordFailure(space, author, error);
			throw error;
		}
	}

	private timingFor(
		target: PendingTarget | undefined,
		startedAt: number,
		committedAt: number,
	): ChangeTiming {
		return {
			trigger: target?.trigger ?? "sweep",
			notifiedAt: target?.notifiedAt ?? null,
			startedAt,
			committedAt,
		};
	}

	private settleTarget(key: string, appliedRev: string | null): void {
		const target = this.targets.get(key);
		if (!target) return;

		if (!target.rev || (appliedRev !== null && appliedRev >= target.rev)) {
			this.targets.delete(key);
			return;
		}

		const { space, author } = decodeKey(key);
		target.attempts += 1;
		if (target.attempts >= (this.options.maxChaseAttempts ?? DEFAULT_CHASE_ATTEMPTS)) {
			this.targets.delete(key);
			this.log("repo.chaseExhausted", { space, author, wanted: target.rev, appliedRev });
			return;
		}

		this.log(
			"repo.chasing",
			{ space, author, wanted: target.rev, appliedRev, attempt: target.attempts },
			"debug",
		);
		this.queue.push(key);
	}

	private async recordFailure(space: string, author: string, error: unknown): Promise<void> {
		const cursor = await this.options.store.loadCursor(space, author);
		const failures = (cursor?.consecutiveFailures ?? 0) + 1;
		await this.options.store.saveCursor({
			space,
			author,
			appliedRev: cursor?.appliedRev ?? null,
			setHashBase64: cursor?.setHashBase64 ?? null,
			state: "error",
			consecutiveFailures: failures,
			retryAfter: new Date(
				this.now().getTime() + backoffFor(failures, this.options.maxBackoffMs ?? 3_600_000),
			),
		});
		this.log("repo.syncFailed", { space, author, failures, error });
	}
}
