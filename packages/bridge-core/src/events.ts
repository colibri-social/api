import WebSocket from "ws";
import type { ColibriClient, WriteMode } from "./client.js";
import { NodeDirectory } from "./nodes.js";

export type ServerFrame = { $type: string } & Record<string, unknown>;

export type EventStreamNodes = Pick<NodeDirectory, "refresh" | "refreshIfStale" | "endpointFor">;

export type EventStreamOptions = {
	client: ColibriClient;
	onFrame: (frame: ServerFrame) => void;
	onOpen?: () => void;
	onClose?: (reason: string) => void;
	onMove?: (move: { from: string; to: string; reason: string }) => void;
	nodes?: EventStreamNodes | null;
	heartbeatMs?: number;
	maxBackoffMs?: number;
	handoverTimeoutMs?: number;
	overlapMs?: number;
	createSocket?: (url: string, token: string) => WebSocket;
};

type Link = {
	socket: WebSocket;
	endpoint: string;
	mode: WriteMode | null;
};

const SUBSCRIBE_LXM = "social.colibri.beta.sync.subscribeEvents";
const FRAME_PREFIX = "social.colibri.beta.sync.defs#";
const WRITE_MODES: ReadonlySet<string> = new Set(["normal", "queued", "readOnly"]);
const DRAIN_FALLBACK_MS = 60_000;
const MOVE_RETRY_MS = 5_000;
const RECENT_LIMIT = 1_000;

export const frameKind = (frame: ServerFrame): string | null => {
	return frame.$type.startsWith(FRAME_PREFIX) ? frame.$type.slice(FRAME_PREFIX.length) : null;
};

const originOf = (url: string): string => {
	return new URL(url).origin;
};

const socketUrl = (endpoint: string): string => {
	const url = new URL(`/xrpc/${SUBSCRIBE_LXM}`, endpoint);

	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

	return url.toString();
};

export class EventStream {
	private readonly nodes: EventStreamNodes | null;
	private readonly steering: string;
	private readonly draining = new Map<string, number>();
	private readonly recent = new Set<string>();
	private active: Link | null = null;
	private pending: Link | null = null;
	private retiring: Link | null = null;
	private channels = new Set<string>();
	private heartbeat: NodeJS.Timeout | null = null;
	private reconnect: NodeJS.Timeout | null = null;
	private moveTimer: NodeJS.Timeout | null = null;
	private handoverTimer: NodeJS.Timeout | null = null;
	private retireTimer: NodeJS.Timeout | null = null;
	private attempts = 0;
	private moveAttempts = 0;
	private stopped = true;

	constructor(private readonly options: EventStreamOptions) {
		this.steering = originOf(options.client.appviewUrl);
		this.nodes =
			options.nodes === undefined
				? new NodeDirectory({ appviewUrl: options.client.appviewUrl })
				: options.nodes;
	}

	get endpoint(): string | null {
		return this.active?.endpoint ?? null;
	}

	start(): void {
		this.stopped = false;
		void this.connect();
	}

	stop(): void {
		this.stopped = true;

		for (const timer of [this.reconnect, this.moveTimer, this.handoverTimer, this.retireTimer]) {
			if (timer) clearTimeout(timer);
		}

		if (this.heartbeat) clearInterval(this.heartbeat);

		for (const link of [this.active, this.pending, this.retiring]) {
			link?.socket.close(1000, "bridge stopping");
		}

		this.active = null;
		this.pending = null;
		this.retiring = null;
	}

	setChannels(channels: Iterable<string>): void {
		const next = new Set(channels);
		const added = [...next].filter((channel) => !this.channels.has(channel));
		const removed = [...this.channels].filter((channel) => !next.has(channel));

		this.channels = next;

		for (const link of [this.active, this.pending]) {
			if (!link) continue;

			if (removed.length > 0) {
				this.send(link, { $type: `${FRAME_PREFIX}unsubscribe`, channels: removed });
			}

			if (added.length > 0) {
				this.send(link, { $type: `${FRAME_PREFIX}subscribe`, channels: added });
			}
		}
	}

	private send(link: Link, frame: ServerFrame): void {
		if (link.socket.readyState === WebSocket.OPEN) link.socket.send(JSON.stringify(frame));
	}

	private subscribeAll(link: Link): void {
		if (this.channels.size > 0) {
			this.send(link, { $type: `${FRAME_PREFIX}subscribe`, channels: [...this.channels] });
		}
	}

	private avoided(): Set<string> {
		const now = Date.now();

		for (const [endpoint, until] of this.draining) {
			if (until <= now) this.draining.delete(endpoint);
		}

		return new Set(this.draining.keys());
	}

	private pick(): string {
		return this.nodes?.endpointFor("live", this.avoided()) ?? this.steering;
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;

		await this.nodes?.refreshIfStale().catch(() => undefined);

		const link = await this.open(this.pick()).catch((error: unknown) => {
			this.scheduleReconnect(error instanceof Error ? error.message : String(error));

			return null;
		});

		if (!link) return;

		if (this.stopped) {
			link.socket.close(1000, "bridge stopping");

			return;
		}

		this.active = link;
	}

	private async open(endpoint: string): Promise<Link> {
		const url = socketUrl(endpoint);
		const token = await this.options.client.token(SUBSCRIBE_LXM);
		const socket = this.options.createSocket
			? this.options.createSocket(url, token)
			: new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
		const link: Link = { socket, endpoint, mode: null };

		socket.on("open", () => this.onLinkOpen(link));
		socket.on("message", (raw) => this.onLinkMessage(link, raw.toString()));
		socket.on("close", (code, reason) => this.onLinkClose(link, code, reason.toString()));
		socket.on("error", () => socket.close());

		return link;
	}

	private onLinkOpen(link: Link): void {
		if (link === this.pending) {
			this.subscribeAll(link);

			if (this.channels.size === 0) this.promote(link);

			return;
		}

		if (link !== this.active) return;

		this.attempts = 0;
		this.subscribeAll(link);
		this.startHeartbeat();
		this.options.onOpen?.();
	}

	private onLinkMessage(link: Link, raw: string): void {
		let frame: unknown;

		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}

		if (!frame || typeof frame !== "object" || typeof (frame as ServerFrame).$type !== "string") {
			return;
		}

		const parsed = frame as ServerFrame;
		const kind = frameKind(parsed);

		if (kind === "drainNotice") {
			this.onDrain(link, parsed);

			return;
		}

		if (kind === "writeState") {
			this.onWriteState(link, parsed);

			return;
		}

		if (link === this.pending) {
			if (kind === "subscribed") this.promote(link);

			return;
		}

		if (this.isRepeat(raw)) return;

		this.options.onFrame(parsed);
	}

	private onWriteState(link: Link, frame: ServerFrame): void {
		if (!WRITE_MODES.has(String(frame.mode))) return;

		link.mode = frame.mode as WriteMode;

		if (link === this.active) this.options.client.setWriteMode(link.mode);
	}

	private isRepeat(raw: string): boolean {
		if (!this.retiring) {
			this.recent.clear();

			return false;
		}

		if (this.recent.has(raw)) return true;

		this.recent.add(raw);

		if (this.recent.size > RECENT_LIMIT) {
			const [oldest] = this.recent;

			if (oldest !== undefined) this.recent.delete(oldest);
		}

		return false;
	}

	private onLinkClose(link: Link, code: number, reason: string): void {
		if (link === this.retiring) {
			this.retiring = null;
			this.recent.clear();

			return;
		}

		if (link === this.pending) {
			this.pending = null;

			if (this.handoverTimer) clearTimeout(this.handoverTimer);

			this.handoverTimer = null;

			if (this.active) {
				this.scheduleMove();
			} else {
				this.scheduleReconnect(`closed with ${code} ${reason}`.trim());
			}

			return;
		}

		if (link !== this.active) return;

		this.active = null;

		if (this.heartbeat) clearInterval(this.heartbeat);

		this.heartbeat = null;

		if (!this.pending) {
			this.scheduleReconnect(`closed with ${code} ${reason}`.trim());
		}
	}

	private onDrain(link: Link, frame: ServerFrame): void {
		const at = Date.parse(String(frame.deadline));
		const until = Number.isFinite(at) ? at : Date.now() + DRAIN_FALLBACK_MS;

		if (link.endpoint !== this.steering) {
			this.draining.set(link.endpoint, until);
		}

		if (link === this.pending) {
			link.socket.close(1000, "node draining");

			return;
		}

		if (link === this.active) {
			this.moveAttempts = 0;
			void this.move(typeof frame.reason === "string" ? frame.reason : "drain");
		}
	}

	private async move(reason: string): Promise<void> {
		const from = this.active;

		if (this.stopped || !from || this.pending) return;

		await this.nodes?.refresh().catch(() => undefined);

		if (this.stopped || this.active !== from || this.pending) return;

		const target = this.pick();

		if (target === from.endpoint && target !== this.steering) {
			this.options.onClose?.(`${from.endpoint} is draining and no other node is available`);

			return;
		}

		const link = await this.open(target).catch(() => null);

		if (!link) {
			this.scheduleMove();

			return;
		}

		if (this.stopped || this.active !== from || this.pending) {
			link.socket.close(1000, "move abandoned");

			return;
		}

		this.pending = link;
		this.options.onMove?.({ from: from.endpoint, to: target, reason });
		this.handoverTimer = setTimeout(
			() => link.socket.close(1000, "handover timed out"),
			this.options.handoverTimeoutMs ?? 10_000,
		);
	}

	private scheduleMove(): void {
		const active = this.active;

		if (this.stopped || !active || this.moveTimer) return;

		const until = this.draining.get(active.endpoint);

		if (active.endpoint !== this.steering && (until === undefined || until <= Date.now())) {
			return;
		}

		const delay = Math.min(
			MOVE_RETRY_MS * 2 ** this.moveAttempts,
			this.options.maxBackoffMs ?? 60_000,
		);

		this.moveAttempts += 1;
		this.moveTimer = setTimeout(() => {
			this.moveTimer = null;
			void this.move("drain");
		}, delay);
	}

	private promote(link: Link): void {
		const previous = this.active;

		if (this.handoverTimer) clearTimeout(this.handoverTimer);

		this.handoverTimer = null;
		this.pending = null;
		this.active = link;
		this.attempts = 0;
		this.moveAttempts = 0;
		this.startHeartbeat();

		if (link.mode) this.options.client.setWriteMode(link.mode);

		if (previous && previous.socket.readyState === WebSocket.OPEN) {
			this.retiring = previous;
			this.retireTimer = setTimeout(() => {
				this.retireTimer = null;
				previous.socket.close(1000, "moved to another node");
			}, this.options.overlapMs ?? 2_000);
		}

		this.options.onOpen?.();
	}

	private startHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);

		this.heartbeat = setInterval(() => {
			if (this.active) this.send(this.active, { $type: `${FRAME_PREFIX}heartbeat` });
		}, this.options.heartbeatMs ?? 25_000);
	}

	private scheduleReconnect(reason: string): void {
		this.options.onClose?.(reason);

		if (this.stopped || this.reconnect) return;

		const delay = Math.min(1000 * 2 ** this.attempts, this.options.maxBackoffMs ?? 60_000);

		this.attempts += 1;
		this.reconnect = setTimeout(() => {
			this.reconnect = null;
			void this.connect();
		}, delay);
	}
}
