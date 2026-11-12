import { pruneNotifications } from "@colibri-social/notifications";
import type { AppContext } from "./context.js";

const NOTIFICATION_PRUNE_MS = 60 * 60_000;

export class NotificationPruner {
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly ctx: AppContext,
		private readonly intervalMs = NOTIFICATION_PRUNE_MS,
	) {}

	start(): void {
		if (this.timer) return;

		const { db, tables } = this.ctx.database;
		const now = () => new Date().toISOString();

		const run = () =>
			void pruneNotifications({ db, tables, now })
				.then((deleted) => {
					if (deleted > 0) this.ctx.log.info({ deleted }, "notifications.pruned");
				})
				.catch((error: unknown) => this.ctx.log.warn({ err: error }, "notifications.pruneFailed"));

		run();
		this.timer = setInterval(run, this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;

		clearInterval(this.timer);
		this.timer = null;
	}
}
