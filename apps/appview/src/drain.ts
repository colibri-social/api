import type { Database } from "@colibri-social/appview-db";
import { and, eq, gt, ne } from "drizzle-orm";

export const SOLO_DRAIN_MS = 15_000;

export const PEER_HEARTBEAT_WINDOW_MS = 90_000;

export type DrainReason = "update" | "maintenance" | "retire";

export type DrainState = {
	readonly draining: boolean;
	readonly deadline: Date | null;
	begin: (deadline: Date) => void;
};

export type DrainOutcome = "empty" | "deadline" | "skipped";

export type WaitForConnectionsOptions = {
	count: () => number;
	deadline: Date;
	skip: Promise<void>;
	pollMs?: number;
	now?: () => number;
};

export const createDrainState = (): DrainState => {
	let deadline: Date | null = null;

	return {
		get draining() {
			return deadline !== null;
		},
		get deadline() {
			return deadline;
		},
		begin: (at) => {
			deadline ??= at;
		},
	};
};

export const hasPeers = async (
	{ db, tables }: Database,
	nodeId: string | undefined,
	now: Date = new Date(),
): Promise<boolean> => {
	const since = new Date(now.getTime() - PEER_HEARTBEAT_WINDOW_MS).toISOString();
	const others = nodeId ? ne(tables.nodes.id, nodeId) : undefined;
	const rows = await db
		.select({ id: tables.nodes.id })
		.from(tables.nodes)
		.where(and(eq(tables.nodes.state, "active"), gt(tables.nodes.heartbeatAt, since), others))
		.limit(1);

	return rows.length > 0;
};

export const drainGraceMs = (graceMinutes: number, peers: boolean): number => {
	return peers ? graceMinutes * 60_000 : Math.min(SOLO_DRAIN_MS, graceMinutes * 60_000);
};

export const waitForConnections = ({
	count,
	deadline,
	skip,
	pollMs = 1_000,
	now = Date.now,
}: WaitForConnectionsOptions): Promise<DrainOutcome> => {
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | null = null;
		let settled = false;

		const settle = (outcome: DrainOutcome) => {
			if (settled) {
				return;
			}

			settled = true;

			if (timer) {
				clearTimeout(timer);
			}

			resolve(outcome);
		};

		const check = () => {
			if (count() === 0) {
				settle("empty");

				return;
			}

			const remaining = deadline.getTime() - now();

			if (remaining <= 0) {
				settle("deadline");

				return;
			}

			timer = setTimeout(check, Math.min(pollMs, remaining));
		};

		void skip.then(() => settle("skipped"));

		check();
	});
};
