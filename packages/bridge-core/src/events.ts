import WebSocket from "ws";
import type { ColibriClient } from "./client.js";

export type ServerFrame = { $type: string } & Record<string, unknown>;

export type EventStreamOptions = {
	client: ColibriClient;
	onFrame: (frame: ServerFrame) => void;
	onOpen?: () => void;
	onClose?: (reason: string) => void;
	heartbeatMs?: number;
	maxBackoffMs?: number;
	createSocket?: (url: string, token: string) => WebSocket;
};

const SUBSCRIBE_LXM = "social.colibri.beta.sync.subscribeEvents";
const FRAME_PREFIX = "social.colibri.beta.sync.defs#";

export class EventStream {
	private socket: WebSocket | null = null;
	private channels = new Set<string>();
	private heartbeat: NodeJS.Timeout | null = null;
	private reconnect: NodeJS.Timeout | null = null;
	private attempts = 0;
	private stopped = true;

	constructor(private readonly options: EventStreamOptions) {}

	start(): void {
		this.stopped = false;
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnect) clearTimeout(this.reconnect);
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.socket?.close(1000, "bridge stopping");
		this.socket = null;
	}

	setChannels(channels: Iterable<string>): void {
		const next = new Set(channels);
		const added = [...next].filter((channel) => !this.channels.has(channel));
		const removed = [...this.channels].filter((channel) => !next.has(channel));
		this.channels = next;
		if (removed.length > 0) this.send({ $type: `${FRAME_PREFIX}unsubscribe`, channels: removed });
		if (added.length > 0) this.send({ $type: `${FRAME_PREFIX}subscribe`, channels: added });
	}

	private send(frame: ServerFrame): void {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		const url = new URL(`/xrpc/${SUBSCRIBE_LXM}`, this.options.client.appviewUrl);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

		let socket: WebSocket;
		try {
			const token = await this.options.client.token(SUBSCRIBE_LXM);
			socket = this.options.createSocket
				? this.options.createSocket(url.toString(), token)
				: new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
		} catch (error) {
			this.scheduleReconnect(error instanceof Error ? error.message : String(error));
			return;
		}
		this.socket = socket;

		socket.on("open", () => {
			this.attempts = 0;
			if (this.channels.size > 0) {
				this.send({ $type: `${FRAME_PREFIX}subscribe`, channels: [...this.channels] });
			}
			this.heartbeat = setInterval(
				() => this.send({ $type: `${FRAME_PREFIX}heartbeat` }),
				this.options.heartbeatMs ?? 25_000,
			);
			this.options.onOpen?.();
		});

		socket.on("message", (raw) => {
			let frame: unknown;
			try {
				frame = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (frame && typeof frame === "object" && typeof (frame as ServerFrame).$type === "string") {
				this.options.onFrame(frame as ServerFrame);
			}
		});

		socket.on("close", (code, reason) => {
			if (this.heartbeat) clearInterval(this.heartbeat);
			this.heartbeat = null;
			if (this.socket === socket) this.socket = null;
			this.scheduleReconnect(`closed with ${code} ${reason.toString()}`.trim());
		});

		socket.on("error", () => socket.close());
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

export const frameKind = (frame: ServerFrame): string | null =>
	frame.$type.startsWith(FRAME_PREFIX) ? frame.$type.slice(FRAME_PREFIX.length) : null;
