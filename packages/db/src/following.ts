import pg from "pg";
import { hostUrls, pickPrimary, probeHost } from "./hosts.js";

export const RECHECK_MS = 10_000;

const RETRY_CODES: ReadonlySet<string> = new Set([
	"25006",
	"57P01",
	"57P02",
	"57P03",
	"08000",
	"08001",
	"08003",
	"08006",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
]);

export type FollowingPoolOptions = {
	url: string;
	urls?: string[];
	max: number;
	recheckMs?: number;
	probe?: typeof probeHost;
};

const codeOf = (error: unknown): string | null => {
	const code = (error as { code?: unknown } | null)?.code;

	return typeof code === "string" ? code : null;
};

export const switchesPrimary = (error: unknown): boolean => {
	const code = codeOf(error);

	if (code !== null) {
		return RETRY_CODES.has(code);
	}

	const message = error instanceof Error ? error.message : "";

	return /Connection terminated|terminating connection|ECONNRESET|socket hang up/i.test(message);
};

export class FollowingPool extends pg.Pool {
	private readonly urls: string[];
	private readonly max: number;
	private readonly probe: typeof probeHost;
	private readonly switchListeners = new Set<(url: string) => void>();
	private readonly recheckTimer: ReturnType<typeof setInterval>;
	private current: { url: string; pool: pg.Pool } | null = null;
	private resolving: Promise<{ url: string; pool: pg.Pool }> | null = null;
	private lastUrl: string | null = null;
	private closed = false;

	constructor(options: FollowingPoolOptions) {
		super({ max: 1 });
		this.urls = options.urls ?? hostUrls(options.url);
		this.max = options.max;
		this.probe = options.probe ?? probeHost;
		this.query = ((...args: unknown[]) => this.followQuery(...args)) as pg.Pool["query"];
		this.recheckTimer = setInterval(() => void this.recheck(), options.recheckMs ?? RECHECK_MS);
		this.recheckTimer.unref?.();
	}

	get currentUrl(): string | null {
		return this.current?.url ?? null;
	}

	onSwitch(listener: (url: string) => void): () => void {
		this.switchListeners.add(listener);

		return () => this.switchListeners.delete(listener);
	}

	async primaryUrl(): Promise<string> {
		return (await this.active()).url;
	}

	override connect(): Promise<pg.PoolClient>;
	override connect(
		callback: (
			error: Error | undefined,
			client: pg.PoolClient | undefined,
			done: () => void,
		) => void,
	): void;
	override connect(
		callback?: (
			error: Error | undefined,
			client: pg.PoolClient | undefined,
			done: () => void,
		) => void,
	): Promise<pg.PoolClient> | undefined {
		const work = this.connectFollowing();

		if (callback) {
			work.then(
				(client) => callback(undefined, client, () => client.release()),
				(error: Error) => callback(error, undefined, () => {}),
			);

			return undefined;
		}

		return work;
	}

	private followQuery(...args: unknown[]): Promise<pg.QueryResult> | undefined {
		const last = args.at(-1);
		const callback = typeof last === "function" ? (last as (...values: unknown[]) => void) : null;
		const work = this.queryFollowing(callback ? args.slice(0, -1) : args);

		if (callback) {
			work.then(
				(result) => callback(undefined, result),
				(error: unknown) => callback(error),
			);

			return undefined;
		}

		return work;
	}

	override async end(): Promise<void> {
		this.closed = true;
		clearInterval(this.recheckTimer);

		const current = this.current;

		this.current = null;
		await current?.pool.end().catch(() => {});
		await super.end().catch(() => {});
	}

	private async connectFollowing(): Promise<pg.PoolClient> {
		const target = await this.active();

		try {
			return await target.pool.connect();
		} catch (error) {
			if (!switchesPrimary(error)) throw error;

			this.drop(target.url);

			return (await this.active()).pool.connect();
		}
	}

	private async queryFollowing(args: unknown[]): Promise<pg.QueryResult> {
		const run = async () => {
			const target = await this.active();

			try {
				return await (target.pool.query as (...values: unknown[]) => Promise<pg.QueryResult>)(
					...args,
				);
			} catch (error) {
				if (switchesPrimary(error)) this.drop(target.url);

				throw error;
			}
		};

		try {
			return await run();
		} catch (error) {
			const code = codeOf(error);

			if (code === "25006" || code === "ECONNREFUSED" || code === "57P03") {
				return run();
			}

			throw error;
		}
	}

	private drop(url: string): void {
		if (this.current?.url !== url) {
			return;
		}

		const stale = this.current.pool;

		this.current = null;
		void stale.end().catch(() => {});
	}

	private async active(): Promise<{ url: string; pool: pg.Pool }> {
		if (this.closed) {
			throw new Error("the pool is closed");
		}

		if (this.current) {
			return this.current;
		}

		this.resolving ??= this.resolve().finally(() => {
			this.resolving = null;
		});

		return this.resolving;
	}

	private async resolve(): Promise<{ url: string; pool: pg.Pool }> {
		const primary = pickPrimary(await Promise.all(this.urls.map((url) => this.probe(url))));

		if (!primary) {
			throw Object.assign(new Error("no host in DATABASE_URL accepts writes"), { code: "57P03" });
		}

		const pool = new pg.Pool({ connectionString: primary.url, max: this.max });

		pool.on("error", (error) => this.emit("error", error));

		const previous = this.lastUrl;

		this.current = { url: primary.url, pool };
		this.lastUrl = primary.url;

		if (previous !== null && previous !== primary.url) {
			for (const listener of this.switchListeners) listener(primary.url);
		}

		return this.current;
	}

	private async recheck(): Promise<void> {
		if (this.closed || !this.current || this.resolving) {
			return;
		}

		const best = pickPrimary(await Promise.all(this.urls.map((url) => this.probe(url))));

		if (best && best.url !== this.current?.url) {
			this.drop(this.current?.url ?? "");
			await this.active().catch(() => undefined);
		}
	}
}
