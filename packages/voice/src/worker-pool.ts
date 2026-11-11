import { availableParallelism } from "node:os";
import { createWorker } from "mediasoup";
import type {
	Router,
	RouterOptions,
	WebRtcServer,
	WebRtcServerOptions,
	Worker,
	WorkerSettings,
} from "mediasoup/types";
import { TypedEmitter } from "./typed-emitter.js";

export type WorkerFactory = (settings?: WorkerSettings) => Promise<Worker>;

export type PooledRouter = {
	router: Router;
	webRtcServer?: WebRtcServer;
	worker?: number;
};

export type RouterPlacement = {
	avoid?: readonly number[];
};

export interface RouterProvider {
	readonly size?: number;
	createRouter(options: RouterOptions, placement?: RouterPlacement): Promise<PooledRouter>;
}

export type WorkerUsage = {
	worker: number;
	cpuSeconds: number;
};

export interface WorkerPoolLike extends RouterProvider {
	close(): Promise<void>;
	usage?(): Promise<WorkerUsage[]>;
}

export type WorkerPoolEvents = {
	"worker-died": [{ pid: number; error: Error }];
	"worker-restarted": [{ pid: number }];
};

export type WebRtcServerListen = {
	listenIp: string;
	announcedIp?: string;
	basePort: number;
};

export type WorkerPoolOptions = {
	workerCount?: number;
	webRtcServer?: WebRtcServerListen;
	workerSettings?: WorkerSettings;
	createWorker?: WorkerFactory;
	subprocessExitTimeoutMs?: number;
};

type WorkerSlot = {
	worker: Worker;
	webRtcServer?: WebRtcServer;
	routers: number;
};

export const DEFAULT_SUBPROCESS_EXIT_TIMEOUT_MS = 5_000;

export function webRtcServerOptions(
	listen: WebRtcServerListen,
	index: number,
): WebRtcServerOptions {
	const base = {
		ip: listen.listenIp,
		announcedAddress: listen.announcedIp,
		port: listen.basePort + index,
	};

	return {
		listenInfos: [
			{ ...base, protocol: "udp" },
			{ ...base, protocol: "tcp" },
		],
		appData: { index },
	};
}

function killSubprocess(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		return;
	}
}

export class WorkerPool extends TypedEmitter<WorkerPoolEvents> implements WorkerPoolLike {
	private slots: WorkerSlot[];
	private nextWorkerIndex = 0;
	private closed = false;

	private readonly workerSettings: WorkerSettings;
	private readonly createWorkerFn: WorkerFactory;
	private readonly subprocessExitTimeoutMs: number;
	private readonly listen: WebRtcServerListen | undefined;

	private constructor(
		slots: WorkerSlot[],
		options: Required<Pick<WorkerPoolOptions, "workerSettings" | "subprocessExitTimeoutMs">> & {
			createWorker: WorkerFactory;
			webRtcServer?: WebRtcServerListen;
		},
	) {
		super();
		this.slots = slots;
		this.workerSettings = options.workerSettings;
		this.createWorkerFn = options.createWorker;
		this.subprocessExitTimeoutMs = options.subprocessExitTimeoutMs;
		this.listen = options.webRtcServer;
		for (const slot of slots) {
			this.attachWorkerListeners(slot.worker);
		}
	}

	static async create(options: WorkerPoolOptions = {}): Promise<WorkerPool> {
		const count = options.workerCount ?? availableParallelism();
		const settings = {
			workerSettings: options.workerSettings ?? {},
			createWorker: options.createWorker ?? createWorker,
			subprocessExitTimeoutMs:
				options.subprocessExitTimeoutMs ?? DEFAULT_SUBPROCESS_EXIT_TIMEOUT_MS,
			...(options.webRtcServer ? { webRtcServer: options.webRtcServer } : {}),
		};
		const slots = await Promise.all(
			Array.from({ length: count }, (_, index) => WorkerPool.startSlot(settings, index)),
		);

		return new WorkerPool(slots, settings);
	}

	private static async startSlot(
		settings: {
			workerSettings: WorkerSettings;
			createWorker: WorkerFactory;
			webRtcServer?: WebRtcServerListen;
		},
		index: number,
	): Promise<WorkerSlot> {
		const worker = await settings.createWorker(settings.workerSettings);

		if (!settings.webRtcServer) {
			return { worker, routers: 0 };
		}

		try {
			const webRtcServer = await worker.createWebRtcServer(
				webRtcServerOptions(settings.webRtcServer, index),
			);

			return { worker, webRtcServer, routers: 0 };
		} catch (error) {
			worker.close();

			throw error;
		}
	}

	get size(): number {
		return this.slots.length;
	}

	get ports(): number[] {
		if (!this.listen) {
			return [];
		}

		const basePort = this.listen.basePort;

		return this.slots.map((_, index) => basePort + index);
	}

	async usage(): Promise<WorkerUsage[]> {
		const samples = await Promise.all(
			this.slots.map(async (slot, worker) => {
				const usage = await slot.worker.getResourceUsage().catch(() => null);

				return usage ? [{ worker, cpuSeconds: (usage.ru_utime + usage.ru_stime) / 1000 }] : [];
			}),
		);

		return samples.flat();
	}

	async createRouter(
		options: RouterOptions,
		placement: RouterPlacement = {},
	): Promise<PooledRouter> {
		if (this.closed) {
			throw new Error("worker pool is closed");
		}
		const index = this.pickSlot(placement.avoid ?? []);
		const slot = this.slots[index];
		if (!slot) {
			throw new Error("worker pool has no workers");
		}
		const router = await slot.worker.createRouter(options);

		slot.routers += 1;
		router.observer.once("close", () => {
			if (this.slots[index] === slot) slot.routers -= 1;
		});

		return {
			router,
			worker: index,
			...(slot.webRtcServer ? { webRtcServer: slot.webRtcServer } : {}),
		};
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const slots = this.slots;
		this.slots = [];
		await Promise.all(slots.map((slot) => this.terminate(slot.worker)));
	}

	private async terminate(worker: Worker): Promise<void> {
		const exited = this.subprocessExit(worker);
		worker.close();
		await exited;
	}

	private subprocessExit(worker: Worker): Promise<void> {
		if (worker.subprocessClosed) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			const settle = () => {
				clearTimeout(timer);
				resolve();
			};

			const timer = setTimeout(() => {
				worker.off("subprocessclose", settle);
				killSubprocess(worker.pid);
				resolve();
			}, this.subprocessExitTimeoutMs);
			timer.unref?.();

			worker.once("subprocessclose", settle);
		});
	}

	private pickSlot(avoid: readonly number[]): number {
		const indexes = this.slots.map((_, index) => index);
		const allowed = indexes.filter((index) => !avoid.includes(index));
		const pool = allowed.length > 0 ? allowed : indexes;
		const start = this.nextWorkerIndex % this.slots.length;

		this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.slots.length;

		let best: number | null = null;

		for (let offset = 0; offset < this.slots.length; offset += 1) {
			const index = (start + offset) % this.slots.length;

			if (!pool.includes(index)) continue;

			if (best === null || this.load(index) < this.load(best)) {
				best = index;
			}
		}

		return best ?? 0;
	}

	private load(index: number): number {
		return this.slots[index]?.routers ?? 0;
	}

	private attachWorkerListeners(worker: Worker): void {
		worker.on("died", (error) => {
			void this.handleWorkerDeath(worker, error);
		});
	}

	private async handleWorkerDeath(worker: Worker, error: Error): Promise<void> {
		const index = this.slots.findIndex((slot) => slot.worker === worker);
		if (index === -1) {
			return;
		}

		this.emit("worker-died", { pid: worker.pid, error });

		if (this.closed) {
			return;
		}

		try {
			const replacement = await WorkerPool.startSlot(
				{
					workerSettings: this.workerSettings,
					createWorker: this.createWorkerFn,
					...(this.listen ? { webRtcServer: this.listen } : {}),
				},
				index,
			);

			if (this.closed) {
				await this.terminate(replacement.worker);

				return;
			}

			this.slots[index] = replacement;
			this.attachWorkerListeners(replacement.worker);
			this.emit("worker-restarted", { pid: replacement.worker.pid });
		} catch (restartError) {
			this.emit("worker-died", { pid: worker.pid, error: restartError as Error });
		}
	}
}
