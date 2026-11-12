import { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import {
	CONTROL_PATH,
	CONTROL_PING_MS,
	linkErrorCode,
	type MainFrame,
	mainFrameSchema,
	NODE_ID_HEADER,
	NODE_SECRET_HEADER,
	type NodeFrame,
	parseFrame,
} from "./protocol.js";

const RETRY_MIN_MS = 1_000;

const RETRY_MAX_MS = 30_000;

export const HANDSHAKE_TIMEOUT_MS = 10_000;

export const LINK_IDLE_MS = 2 * CONTROL_PING_MS;

export const MAIN_CHECK_MS = 60_000;

export type ControlClientDeps = {
	nodeId: string;
	secret: string;
	mainUrl: () => Promise<string | null>;
	log: Pick<Logger, "info" | "warn">;
	onFrame: (frame: MainFrame) => void;
	handshakeTimeoutMs?: number;
	idleMs?: number;
	mainCheckMs?: number;
};

const controlUrl = (base: string): string => {
	const url = new URL(CONTROL_PATH, base);

	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

	return url.toString();
};

export class ControlClient {
	private socket: WebSocket | null = null;
	private retryMs = RETRY_MIN_MS;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private mainCheck: ReturnType<typeof setInterval> | null = null;
	private stopped = false;

	constructor(private readonly deps: ControlClientDeps) {}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	start(): void {
		void this.connect();
	}

	send(frame: NodeFrame): boolean {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return false;
		}

		this.socket.send(JSON.stringify(frame));

		return true;
	}

	stop(): void {
		this.stopped = true;

		if (this.timer) clearTimeout(this.timer);

		this.clearWatch();
		this.socket?.close(1001, "shutting down");
		this.socket = null;
	}

	private async connect(): Promise<void> {
		if (this.stopped) {
			return;
		}

		const base = await this.deps.mainUrl().catch(() => null);

		if (!base) {
			this.retry(null, "noMain");

			return;
		}

		const socket = new WebSocket(controlUrl(base), {
			headers: {
				[NODE_ID_HEADER]: this.deps.nodeId,
				[NODE_SECRET_HEADER]: this.deps.secret,
			},
			handshakeTimeout: this.deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
		});

		this.socket = socket;

		socket.on("open", () => {
			this.retryMs = RETRY_MIN_MS;
			this.deps.log.info({ main: base }, "cluster.linkOpen");
			this.watch(socket, base);
		});

		socket.on("ping", () => {
			this.resetIdle(socket, base);
		});

		socket.on("message", (raw) => {
			this.resetIdle(socket, base);

			const frame = parseFrame(mainFrameSchema, raw.toString());

			if (frame) {
				this.deps.onFrame(frame);
			}
		});

		socket.on("unexpected-response", (_request, response) => {
			this.deps.log.warn({ main: base, status: response.statusCode }, "cluster.linkRefused");
			socket.terminate();
		});

		socket.on("error", (error) => {
			this.deps.log.warn(
				{ main: base, code: linkErrorCode(error), message: error.message },
				"cluster.linkError",
			);
		});

		socket.on("close", (code, reason) => {
			if (this.socket !== socket) {
				return;
			}

			this.socket = null;
			this.clearWatch();
			this.deps.log.warn({ main: base, code, reason: reason.toString() }, "cluster.linkClosed");
			this.retry(base, "closed");
		});
	}

	private watch(socket: WebSocket, base: string): void {
		this.clearWatch();
		this.resetIdle(socket, base);

		this.mainCheck = setInterval(
			() => void this.checkMain(socket, base),
			this.deps.mainCheckMs ?? MAIN_CHECK_MS,
		);
		this.mainCheck.unref?.();
	}

	private resetIdle(socket: WebSocket, base: string): void {
		if (this.socket !== socket) {
			return;
		}

		if (this.idleTimer) clearTimeout(this.idleTimer);

		const idleMs = this.deps.idleMs ?? LINK_IDLE_MS;

		this.idleTimer = setTimeout(() => {
			if (this.socket !== socket) {
				return;
			}

			this.deps.log.warn({ main: base, idleMs }, "cluster.linkIdle");
			socket.terminate();
		}, idleMs);
		this.idleTimer.unref?.();
	}

	private async checkMain(socket: WebSocket, base: string): Promise<void> {
		const current = await this.deps.mainUrl().catch(() => null);

		if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
			return;
		}

		if (!current || current === base) {
			return;
		}

		this.deps.log.warn({ connected: base, main: current }, "cluster.linkStale");
		socket.terminate();
	}

	private clearWatch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.mainCheck) clearInterval(this.mainCheck);

		this.idleTimer = null;
		this.mainCheck = null;
	}

	private retry(main: string | null, reason: "noMain" | "closed"): void {
		if (this.stopped) {
			return;
		}

		const delay = this.retryMs;

		this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
		this.deps.log.info({ main, reason, delayMs: delay }, "cluster.linkRetry");
		this.timer = setTimeout(() => void this.connect(), delay);
		this.timer.unref?.();
	}
}
