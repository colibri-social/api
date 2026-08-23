import { COLLECTIONS } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";
import type { AppContext } from "./context.js";
import { JETSTREAM_SUBPROTOCOL, jetstreamEndpoint } from "./jetstream-url.js";

const CURSOR_KEY = "jetstream.cursor";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const EVENTS_PER_CURSOR_SAVE = 500;

const EVENT_TYPE_PREFIX = "network.bsky.jetstream.subscribeEvents#";
const WANTED_KINDS = ["commit", "identity", "account"] as const;
const BSKY_PROFILE = "app.bsky.actor.profile";
const WANTED_COLLECTIONS = [COLLECTIONS.profile, BSKY_PROFILE] as const;

type IdentityPayload = {
	seq: number;
	did: string;
	identity?: { handle?: string; seq?: number; time?: string };
};

type AccountPayload = {
	seq: number;
	did: string;
	account?: { active: boolean; status?: string; seq?: number; time?: string };
};

type CommitPayload = {
	seq: number;
	did: string;
	operation?: string;
	collection?: string;
	rkey?: string;
	record?: Record<string, unknown>;
};

type InfoPayload = { name: string; message?: string };

type Payload = { $type?: string; seq?: number; did?: string } & Partial<
	IdentityPayload & AccountPayload & CommitPayload & InfoPayload
>;

type Frame = {
	$type?: string;
	payload?: Payload;
	error?: string;
	message?: string;
};

const payloadKind = (payload: Payload): string | null => {
	const type = payload.$type;
	if (typeof type !== "string" || !type.startsWith(EVENT_TYPE_PREFIX)) return null;
	return type.slice(EVENT_TYPE_PREFIX.length);
};

export type JetstreamOptions = {
	onIdentity?: (did: string) => void;
	onAccountGone?: (did: string) => void;
};

export class Jetstream {
	private socket: WebSocket | null = null;
	private cursor: number | null = null;
	private savedCursor: number | null = null;
	private sinceSave = 0;
	private attempt = 0;
	private stopped = false;
	private reconnectTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly ctx: AppContext,
		private readonly options: JetstreamOptions = {},
	) {}

	async start(): Promise<void> {
		if (!this.ctx.config.JETSTREAM_ENABLED) {
			this.ctx.log.info("jetstream disabled, identity changes resolve on demand only");
			return;
		}
		this.stopped = false;
		this.cursor = await this.loadCursor();
		this.savedCursor = this.cursor;
		this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.socket?.close();
		this.socket = null;
		await this.flushCursor();
	}

	private async loadCursor(): Promise<number | null> {
		const [row] = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.serviceState)
			.where(eq(this.ctx.database.tables.serviceState.key, CURSOR_KEY))
			.limit(1);
		const parsed = row ? Number(row.value) : Number.NaN;
		return Number.isFinite(parsed) ? parsed : null;
	}

	private async flushCursor(): Promise<void> {
		const cursor = this.cursor;
		if (cursor === null || cursor === this.savedCursor) return;

		const row = {
			key: CURSOR_KEY,
			value: String(cursor),
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.database.db
			.insert(this.ctx.database.tables.serviceState)
			.values(row)
			.onConflictDoUpdate({
				target: this.ctx.database.tables.serviceState.key,
				set: row,
			});
		this.savedCursor = cursor;
		this.sinceSave = 0;
	}

	private url(): string {
		const url = jetstreamEndpoint(this.ctx.config.JETSTREAM_URL);
		for (const kind of WANTED_KINDS) url.searchParams.append("kinds", kind);
		for (const collection of WANTED_COLLECTIONS) url.searchParams.append("collections", collection);
		if (this.cursor !== null) url.searchParams.set("cursor", String(this.cursor));
		return url.toString();
	}

	private connect(): void {
		if (this.stopped) return;

		const socket = new WebSocket(this.url(), [JETSTREAM_SUBPROTOCOL]);
		this.socket = socket;

		socket.on("open", () => {
			this.attempt = 0;
			this.ctx.log.info({ cursor: this.cursor }, "jetstream.connected");
		});

		socket.on("message", (raw) => {
			void this.receive(raw.toString()).catch((error) =>
				this.ctx.log.warn({ error }, "jetstream.eventFailed"),
			);
		});

		socket.on("close", () => {
			void this.flushCursor().catch((error) =>
				this.ctx.log.warn({ error }, "jetstream.cursorSaveFailed"),
			);
			this.scheduleReconnect();
		});
		socket.on("error", (error) => {
			this.ctx.log.warn({ error: error.message }, "jetstream.error");
			socket.close();
		});
	}

	private scheduleReconnect(): void {
		if (this.stopped) return;
		this.attempt += 1;
		const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.attempt, 6));
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
		this.reconnectTimer.unref?.();
	}

	private async receive(raw: string): Promise<void> {
		let frame: Frame;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}

		if (frame.$type === "error") {
			this.ctx.log.warn({ error: frame.error, detail: frame.message }, "jetstream.streamError");
			return;
		}
		if (frame.$type !== "message" || !frame.payload) return;

		const payload = frame.payload;
		const kind = payloadKind(payload);

		if (kind === "info") {
			this.ctx.log.warn({ name: payload.name, detail: payload.message }, "jetstream.info");
			return;
		}

		if (typeof payload.seq === "number") await this.advance(payload.seq);
		if (typeof payload.did !== "string") return;

		if (kind === "identity") {
			await this.forgetIdentity(payload.did);
			this.options.onIdentity?.(payload.did);
			return;
		}

		if (kind === "commit") {
			await this.refreshProfile(payload);
			return;
		}

		if (kind === "account" && payload.account && !payload.account.active) {
			this.ctx.log.info(
				{ did: payload.did, status: payload.account.status },
				"jetstream.accountGone",
			);
			this.options.onAccountGone?.(payload.did);
		}
	}

	private async advance(seq: number): Promise<void> {
		this.cursor = seq;
		this.sinceSave += 1;
		if (this.sinceSave >= EVENTS_PER_CURSOR_SAVE) await this.flushCursor();
	}

	private async refreshProfile(payload: Payload): Promise<void> {
		const did = payload.did as string;
		if (payload.collection !== COLLECTIONS.profile && payload.collection !== BSKY_PROFILE) return;

		const deleted = payload.operation === "delete";
		if (!deleted && !payload.record) return;
		const value = deleted ? null : (payload.record as Record<string, unknown>);

		await this.ctx.database.db
			.update(this.ctx.database.tables.profileCache)
			.set({
				...(payload.collection === COLLECTIONS.profile ? { colibri: value } : { bsky: value }),
				fetchedAt: new Date().toISOString(),
			})
			.where(eq(this.ctx.database.tables.profileCache.did, did));
	}

	private async forgetIdentity(did: string): Promise<void> {
		await this.ctx.database.db
			.delete(this.ctx.database.tables.identityCache)
			.where(eq(this.ctx.database.tables.identityCache.did, did));
		await this.ctx.database.db
			.delete(this.ctx.database.tables.profileCache)
			.where(eq(this.ctx.database.tables.profileCache.did, did));
	}
}
