import { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import {
	CONTROL_PATH,
	type MainFrame,
	mainFrameSchema,
	NODE_ID_HEADER,
	NODE_SECRET_HEADER,
	type NodeFrame,
	parseFrame,
} from "./protocol.js";

const RETRY_MIN_MS = 1_000;

const RETRY_MAX_MS = 30_000;

export type ControlClientDeps = {
	nodeId: string;
	secret: string;
	mainUrl: () => Promise<string | null>;
	log: Pick<Logger, "info" | "warn">;
	onFrame: (frame: MainFrame) => void;
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

		this.socket?.close(1001, "shutting down");
		this.socket = null;
	}

	private async connect(): Promise<void> {
		if (this.stopped) {
			return;
		}

		const base = await this.deps.mainUrl().catch(() => null);

		if (!base) {
			this.retry();

			return;
		}

		const socket = new WebSocket(controlUrl(base), {
			headers: {
				[NODE_ID_HEADER]: this.deps.nodeId,
				[NODE_SECRET_HEADER]: this.deps.secret,
			},
		});

		this.socket = socket;

		socket.on("open", () => {
			this.retryMs = RETRY_MIN_MS;
			this.deps.log.info({ main: base }, "cluster.linkOpen");
		});

		socket.on("message", (raw) => {
			const frame = parseFrame(mainFrameSchema, raw.toString());

			if (frame) {
				this.deps.onFrame(frame);
			}
		});

		socket.on("unexpected-response", (_request, response) => {
			this.deps.log.warn(
				{ main: base, status: response.statusCode },
				"cluster.linkRefused",
			);
		});

		socket.on("error", () => {});

		socket.on("close", () => {
			if (this.socket === socket) {
				this.socket = null;
				this.retry();
			}
		});
	}

	private retry(): void {
		if (this.stopped) {
			return;
		}

		const delay = this.retryMs;

		this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
		this.timer = setTimeout(() => void this.connect(), delay);
		this.timer.unref?.();
	}
}
