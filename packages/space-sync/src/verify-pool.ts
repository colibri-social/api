import { Worker } from "node:worker_threads";
import type {
	AdvanceJob,
	AdvanceResult,
	RepoJob,
	RepoResult,
	VerifyResult,
} from "./verify-jobs.js";
import { runAdvance, runRepo } from "./verify-jobs.js";

export type AdvanceRequest = Omit<AdvanceJob, "kind">;
export type RepoRequest = Omit<RepoJob, "kind">;

export type Verifier = {
	advance(request: AdvanceRequest): Promise<AdvanceResult>;
	repo(request: RepoRequest): Promise<RepoResult>;
	close(): Promise<void>;
};

export const inlineVerifier = (): Verifier => ({
	advance: (request) => runAdvance({ ...request, kind: "advance" }),
	repo: (request) => runRepo({ ...request, kind: "repo" }),
	close: async () => undefined,
});

const WORKER_ENTRY = new URL("./verify-worker.js", import.meta.url);

type Reply = { id: number; result?: VerifyResult; failure?: string };

type Pending = {
	worker: number;
	resolve: (result: VerifyResult) => void;
	reject: (error: Error) => void;
};

export type VerifierPoolOptions = {
	size: number;
	entry?: URL;
	onWorkerDied?: (error: Error) => void;
};

export class VerifierPool implements Verifier {
	private readonly workers: Worker[] = [];
	private readonly pending = new Map<number, Pending>();
	private readonly entry: URL;
	private nextWorker = 0;
	private nextId = 0;
	private closed = false;

	constructor(private readonly options: VerifierPoolOptions) {
		this.entry = options.entry ?? WORKER_ENTRY;
		for (let index = 0; index < options.size; index += 1) {
			this.workers.push(this.spawn(index));
		}
	}

	get size(): number {
		return this.workers.length;
	}

	advance(request: AdvanceRequest): Promise<AdvanceResult> {
		return this.dispatch({ ...request, kind: "advance" }) as Promise<AdvanceResult>;
	}

	repo(request: RepoRequest): Promise<RepoResult> {
		return this.dispatch({ ...request, kind: "repo" }, [
			request.car.buffer as ArrayBuffer,
		]) as Promise<RepoResult>;
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const [id, pending] of this.pending) {
			pending.reject(new Error("the verify pool closed before this job finished"));
			this.pending.delete(id);
		}
		await Promise.all(this.workers.map((worker) => worker.terminate()));
		this.workers.length = 0;
	}

	private spawn(index: number): Worker {
		const worker = new Worker(this.entry);
		worker.unref();
		worker.on("message", (reply: Reply) => this.settle(reply));
		worker.on("error", (error: Error) => this.replace(index, error));
		worker.on("exit", (code: number) => {
			if (code === 0 || this.closed) return;
			this.replace(index, new Error(`verify worker exited with code ${code}`));
		});
		return worker;
	}

	private replace(index: number, error: Error): void {
		if (this.closed) return;
		for (const [id, pending] of this.pending) {
			if (pending.worker !== index) continue;
			pending.reject(error);
			this.pending.delete(id);
		}
		this.options.onWorkerDied?.(error);
		this.workers[index] = this.spawn(index);
	}

	private settle(reply: Reply): void {
		const pending = this.pending.get(reply.id);
		if (!pending) return;
		this.pending.delete(reply.id);
		if (reply.failure !== undefined) {
			pending.reject(new Error(reply.failure));
			return;
		}
		pending.resolve(reply.result as VerifyResult);
	}

	private dispatch(job: AdvanceJob | RepoJob, transfer: ArrayBuffer[] = []): Promise<VerifyResult> {
		if (this.closed || this.workers.length === 0) {
			return Promise.reject(new Error("the verify pool is not accepting jobs"));
		}

		const index = this.nextWorker;
		this.nextWorker = (this.nextWorker + 1) % this.workers.length;
		this.nextId += 1;
		const id = this.nextId;

		return new Promise<VerifyResult>((resolve, reject) => {
			this.pending.set(id, { worker: index, resolve, reject });
			this.workers[index]?.postMessage({ id, job }, transfer);
		});
	}
}
