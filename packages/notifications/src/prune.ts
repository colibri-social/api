import { and, asc, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { NotificationDeps } from "./deps.js";
import { idAt } from "./id.js";

export type PruneOptions = {
	batchSize?: number;
	maxBatches?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const SEEN_RETENTION_MS = 30 * DAY_MS;
export const UNSEEN_RETENTION_MS = 90 * DAY_MS;
export const PRUNE_BATCH_SIZE = 5_000;
export const PRUNE_MAX_BATCHES = 50;

export const pruneNotifications = async (
	deps: Pick<NotificationDeps, "db" | "tables" | "now">,
	options: PruneOptions = {},
) => {
	const { notifications } = deps.tables;
	const batchSize = options.batchSize ?? PRUNE_BATCH_SIZE;
	const maxBatches = options.maxBatches ?? PRUNE_MAX_BATCHES;
	const now = new Date(deps.now()).getTime();
	const seenCutoff = idAt(new Date(now - SEEN_RETENTION_MS));
	const allCutoff = idAt(new Date(now - UNSEEN_RETENTION_MS));

	const expired = or(
		lt(notifications.id, allCutoff),
		and(lt(notifications.id, seenCutoff), isNotNull(notifications.seenAt)),
	);

	let deleted = 0;

	for (let batch = 0; batch < maxBatches; batch++) {
		const rows = await deps.db
			.select({ id: notifications.id })
			.from(notifications)
			.where(expired)
			.orderBy(asc(notifications.id))
			.limit(batchSize);

		if (rows.length === 0) {
			break;
		}

		await deps.db.delete(notifications).where(
			inArray(
				notifications.id,
				rows.map((row) => row.id),
			),
		);

		deleted += rows.length;

		if (rows.length < batchSize) {
			break;
		}
	}

	return deleted;
};
