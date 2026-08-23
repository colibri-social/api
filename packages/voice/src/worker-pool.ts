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
};

export type WorkerPoolOptions = {
	workerCount?: number;
	workerSettings?: WorkerSettings;
	createWorker?: WorkerFactory;
};

export class WorkerPool extends TypedEmitter<WorkerPoolEvents> implements WorkerPoolLike {
	private workers: Worker[];
	private nextWorkerIndex = 0;
	private closed = false;

	private readonly workerSettings: WorkerSettings;
	private readonly createWorkerFn: WorkerFactory;

	private constructor(
		workers: Worker[],
		workerSettings: WorkerSettings,
		createWorkerFn: WorkerFactory,
	) {
		super();
		this.workers = workers;
		this.workerSettings = workerSettings;
		this.createWorkerFn = createWorkerFn;
		for (const worker of workers) {
			this.attachWorkerListeners(worker);
		}
	}

	static async create(options: WorkerPoolOptions = {}): Promise<WorkerPool> {
		const count = options.workerCount ?? availableParallelism();
		const workerSettings = options.workerSettings ?? {};
		const createWorkerFn = options.createWorker ?? createWorker;
		const workers = await Promise.all(
			Array.from({ length: count }, () => createWorkerFn(workerSettings)),
		);
		return new WorkerPool(workers, workerSettings, createWorkerFn);
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
		for (const worker of this.workers) {
			worker.close();
		}
		this.workers = [];
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
