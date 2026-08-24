import { parentPort } from "node:worker_threads";
import { runVerifyJob, type VerifyJob } from "./verify-jobs.js";

const port = parentPort;
if (!port) throw new Error("the verify worker can only run on a worker thread");

port.on("message", (message: { id: number; job: VerifyJob }) => {
	void runVerifyJob(message.job)
		.then((result) => port.postMessage({ id: message.id, result }))
		.catch((error: unknown) =>
			port.postMessage({
				id: message.id,
				failure: error instanceof Error ? error.message : String(error),
			}),
		);
});
