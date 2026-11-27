import { randomUUID } from "node:crypto";
import type { Database } from "@colibri-social/appview-db";
import { and, asc, eq, lte } from "drizzle-orm";
import type { DeclaredAppviews } from "./declared.js";
import { type Forwarder, ForwardRefused } from "./forward.js";

export const DELIVERY_CUTOFF_MS = 24 * 60 * 60 * 1000;
export const DELIVERY_BATCH = 50;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const DELIVERY_LEASE_MS = DELIVERY_TIMEOUT_MS + 60_000;

export const DELIVERY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];

const RETRIED_ERRORS = new Set(["AuthRequired", "RateLimitExceeded", "NotDeclared", "NotJoined"]);

export type DeliveryMethod =
	| "social.colibri.beta.federation.deliverNotification"
	| "social.colibri.beta.federation.deliverRead"
	| "social.colibri.beta.federation.retract";

export type DeliveryDeps = {
	enabled: boolean;
	self: readonly string[];
	database: Database;
	declared: Pick<DeclaredAppviews, "list">;
	endpointFor: (appview: string) => Promise<string | undefined>;
	forward: Forwarder;
	now?: () => Date;
	onDropped?: (target: string, method: string, reason: string) => void;
};

type DeliveryRow = Database["tables"]["federationDeliveries"]["$inferSelect"];

type Outcome = "delivered" | "retry" | "dropped";

export const deliveryDelay = (attempts: number): number => {
	const last = DELIVERY_BACKOFF_MS.length - 1;

	return DELIVERY_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), last)] ?? 3_600_000;
};

const errorOf = (body: Buffer): string | undefined => {
	try {
		const parsed = JSON.parse(body.toString("utf8")) as { error?: unknown };

		return typeof parsed.error === "string" ? parsed.error : undefined;
	} catch {
		return undefined;
	}
};

export const createDeliveries = (deps: DeliveryDeps) => {
	const { db, tables } = deps.database;
	const table = tables.federationDeliveries;
	const now = deps.now ?? (() => new Date());
	let running: Promise<number> | undefined;
	let pending = false;

	const otherTargets = async (recipient: string): Promise<string[]> => {
		const declared = await deps.declared.list(recipient).catch(() => []);

		return [...new Set(declared)].filter((target) => !deps.self.includes(target));
	};

	const elsewhere = async (dids: readonly string[]): Promise<ReadonlySet<string>> => {
		if (!deps.enabled) return new Set();

		const checked = await Promise.all(
			dids.map(async (did) => {
				return (await otherTargets(did)).length > 0 ? [did] : [];
			}),
		);

		return new Set(checked.flat());
	};

	const enqueue = async (
		recipient: string,
		method: DeliveryMethod,
		body: Record<string, unknown>,
	): Promise<number> => {
		if (!deps.enabled) return 0;

		const targets = await otherTargets(recipient);

		if (targets.length === 0) return 0;

		const at = now().toISOString();

		await db.insert(table).values(
			targets.map((target) => ({
				id: randomUUID(),
				target,
				method,
				recipient,
				body,
				attempts: 0,
				nextAttemptAt: at,
				createdAt: at,
			})),
		);

		return targets.length;
	};

	const send = async (row: DeliveryRow): Promise<Outcome> => {
		const endpoint = await deps.endpointFor(row.target).catch(() => undefined);

		if (!endpoint) return "retry";

		try {
			const answer = await deps.forward(
				{ managingApp: row.target, endpoint },
				{
					method: "POST",
					path: `/xrpc/${row.method}`,
					nsid: row.method,
					headers: { "content-type": "application/json" },
					body: Buffer.from(JSON.stringify(row.body)),
					actingFor: undefined,
					serviceAuth: true,
					timeoutMs: DELIVERY_TIMEOUT_MS,
				},
			);

			if (answer.status >= 200 && answer.status < 300) return "delivered";

			if (answer.status === 429 || answer.status >= 500) return "retry";

			const error = errorOf(answer.body);

			if (error && RETRIED_ERRORS.has(error)) return "retry";

			deps.onDropped?.(row.target, row.method, error ?? String(answer.status));

			return "dropped";
		} catch (error) {
			if (!(error instanceof ForwardRefused)) return "retry";

			deps.onDropped?.(row.target, row.method, "PrivateAddress");

			return "dropped";
		}
	};

	const settle = async (row: DeliveryRow, outcome: Outcome) => {
		const attempts = row.attempts + 1;
		const next = now().getTime() + deliveryDelay(attempts);
		const expired = next - Date.parse(row.createdAt) >= DELIVERY_CUTOFF_MS;

		if (outcome !== "retry" || expired) {
			if (outcome === "retry") {
				deps.onDropped?.(row.target, row.method, "expired");
			}

			await db.delete(table).where(eq(table.id, row.id));

			return;
		}

		await db
			.update(table)
			.set({ attempts, nextAttemptAt: new Date(next).toISOString() })
			.where(eq(table.id, row.id));
	};

	const claim = async (row: DeliveryRow): Promise<boolean> => {
		const leaseUntil = new Date(now().getTime() + DELIVERY_LEASE_MS).toISOString();

		const claimed = await db
			.update(table)
			.set({ nextAttemptAt: leaseUntil })
			.where(and(eq(table.id, row.id), eq(table.nextAttemptAt, row.nextAttemptAt)))
			.returning({ id: table.id });

		return claimed.length === 1;
	};

	const runBatch = async (): Promise<number> => {
		const due = await db
			.select()
			.from(table)
			.where(lte(table.nextAttemptAt, now().toISOString()))
			.orderBy(asc(table.nextAttemptAt))
			.limit(DELIVERY_BATCH);

		await Promise.all(
			due.map(async (row) => {
				if (await claim(row)) await settle(row, await send(row));
			}),
		);

		return due.length;
	};

	const drain = async (): Promise<number> => {
		let total = 0;
		let sent = 0;

		do {
			pending = false;
			sent = await runBatch();
			total += sent;
		} while (pending || sent === DELIVERY_BATCH);

		return total;
	};

	return {
		enqueue,
		elsewhere,
		run: () => {
			pending = true;

			running ??= drain().finally(() => {
				running = undefined;
			});

			return running;
		},
	};
};

export type Deliveries = ReturnType<typeof createDeliveries>;
