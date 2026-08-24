import { availableParallelism } from "node:os";
import { createWorker } from "mediasoup";
import type { Router, RouterOptions, Worker, WorkerSettings } from "mediasoup/types";
import { TypedEmitter } from "./typed-emitter.js";

export type WorkerFactory = (settings?: WorkerSettings) => Promise<Worker>;

export interface RouterProvider {
	createRouter(options: RouterOptions): Promise<Router>;
}

export interface WorkerPoolLike extends RouterProvider {
	close(): Promise<void>;
}

export type WorkerPoolEvents = {
	"worker-died": [{ pid: number; error: Error }];
	"worker-restarted": [{ pid: number }];
	"worker-close-timeout": [{ pid: number }];
};

export type WorkerPoolOptions = {
	workerCount?: number;
	workerSettings?: WorkerSettings;
	createWorker?: WorkerFactory;
	subprocessExitTimeoutMs?: number;
};

export const DEFAULT_SUBPROCESS_EXIT_TIMEOUT_MS = 5_000;

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
	private workers: Worker[];
	private nextWorkerIndex = 0;
	private closed = false;

	private readonly workerSettings: WorkerSettings;
	private readonly createWorkerFn: WorkerFactory;
	private readonly subprocessExitTimeoutMs: number;

	private constructor(
		workers: Worker[],
		workerSettings: WorkerSettings,
		createWorkerFn: WorkerFactory,
		subprocessExitTimeoutMs: number,
	) {
		super();
		this.workers = workers;
		this.workerSettings = workerSettings;
		this.createWorkerFn = createWorkerFn;
		this.subprocessExitTimeoutMs = subprocessExitTimeoutMs;
		for (const worker of workers) {
			this.attachWorkerListeners(worker);
		}
	}

	static async create(options: WorkerPoolOptions = {}): Promise<WorkerPool> {
		const count = options.workerCount ?? availableParallelism();
		const workerSettings = options.workerSettings ?? {};
		const createWorkerFn = options.createWorker ?? createWorker;
		const subprocessExitTimeoutMs =
			options.subprocessExitTimeoutMs ?? DEFAULT_SUBPROCESS_EXIT_TIMEOUT_MS;
		const workers = await Promise.all(
			Array.from({ length: count }, () => createWorkerFn(workerSettings)),
		);
		return new WorkerPool(workers, workerSettings, createWorkerFn, subprocessExitTimeoutMs);
	}

	get size(): number {
		return this.workers.length;
	}

	async createRouter(options: RouterOptions): Promise<Router> {
		if (this.closed) {
			throw new Error("worker pool is closed");
		}
		const worker = this.pickWorker();
		return worker.createRouter(options);
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const workers = this.workers;
		this.workers = [];
		await Promise.all(workers.map((worker) => this.terminate(worker)));
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
				this.emit("worker-close-timeout", { pid: worker.pid });
				killSubprocess(worker.pid);
				resolve();
			}, this.subprocessExitTimeoutMs);
			timer.unref?.();

			worker.once("subprocessclose", settle);
		});
	}

	private pickWorker(): Worker {
		const worker = this.workers[this.nextWorkerIndex % this.workers.length];
		this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
		if (!worker) {
			throw new Error("worker pool has no workers");
		}
		return worker;
	}

	private attachWorkerListeners(worker: Worker): void {
		worker.on("died", (error) => {
			void this.handleWorkerDeath(worker, error);
		});
	}

	private async handleWorkerDeath(worker: Worker, error: Error): Promise<void> {
		const index = this.workers.indexOf(worker);
		if (index === -1) {
			return;
		}

		this.emit("worker-died", { pid: worker.pid, error });

		if (this.closed) {
			return;
		}

		try {
			const replacement = await this.createWorkerFn(this.workerSettings);
			this.workers[index] = replacement;
			this.attachWorkerListeners(replacement);
			this.emit("worker-restarted", { pid: replacement.pid });
		} catch (restartError) {
			this.emit("worker-died", { pid: worker.pid, error: restartError as Error });
		}
	}
}
