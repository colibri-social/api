import type { OnlineState } from "@colibri-social/appview-db";
import type { social } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import type { AppContext } from "./context.js";
import { type ActivityView, loadActivity } from "./views/activity.js";
import { liveVoiceState } from "./views/voice-state.js";
import type { ServerFrame } from "./ws/events.js";

const ONLINE = "online" satisfies OnlineState;
const OFFLINE = "offline" satisfies OnlineState;

type PresenceRow = {
	derivedState: OnlineState;
	requestedState: OnlineState | null;
};

/**
 * The state everyone else sees. A socket has to be open for anything other than
 * offline, and while one is open the state the actor asked for wins.
 */
export const effectiveOnlineState = (row: PresenceRow): OnlineState =>
	row.derivedState === OFFLINE ? OFFLINE : (row.requestedState ?? ONLINE);

export type PresenceParts = PresenceRow & {
	statusText: string | null;
	statusEmoji: string | null;
};

export const presenceOf = (
	ctx: AppContext,
	did: string,
	row: PresenceParts,
	activity?: ActivityView,
): social.colibri.beta.actor.defs.Presence =>
	({
		onlineState: effectiveOnlineState(row),
		status: row.statusText
			? { text: row.statusText, emoji: row.statusEmoji ?? undefined }
			: undefined,
		voice: liveVoiceState(ctx.voice, did),
		activity,
	}) as social.colibri.beta.actor.defs.Presence;

export const isOnlineState = (value: string): value is OnlineState =>
	value === ONLINE || value === "away" || value === "dnd" || value === OFFLINE;

export type PresenceDeps = {
	ctx: AppContext;
	publish: (did: string, communities: readonly string[], frame: ServerFrame) => void;
};

/**
 * Counts the event sockets each actor holds open and keeps `userPresence` in
 * step with them, so closing the last tab reads as offline.
 */
export class PresenceTracker {
	private readonly sockets = new Map<string, number>();
	private readonly queues = new Map<string, Promise<void>>();

	constructor(private readonly deps: PresenceDeps) {}

	connections(did: string): number {
		return this.sockets.get(did) ?? 0;
	}

	async opened(did: string): Promise<void> {
		return this.enqueue(did, async () => {
			this.sockets.set(did, this.connections(did) + 1);
			if (this.connections(did) === 1) await this.settle(did);
		});
	}

	async closed(did: string): Promise<void> {
		return this.enqueue(did, async () => {
			const remaining = this.connections(did) - 1;
			if (remaining > 0) {
				this.sockets.set(did, remaining);
				return;
			}
			this.sockets.delete(did);
			await this.settle(did);
		});
	}

	async viewing(did: string, channel: string | null): Promise<void> {
		return this.enqueue(did, async () => {
			const { db, tables } = this.deps.ctx.database;
			const [existing] = await db
				.select()
				.from(tables.userPresence)
				.where(eq(tables.userPresence.did, did))
				.limit(1);
			if (!existing) return;

			await db
				.update(tables.userPresence)
				.set({ viewingChannel: channel, updatedAt: new Date().toISOString() })
				.where(eq(tables.userPresence.did, did));
		});
	}

	async requested(did: string, state: OnlineState): Promise<void> {
		return this.enqueue(did, () => this.settle(did, state));
	}

	private enqueue(did: string, work: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(did) ?? Promise.resolve();
		const next = previous.then(work);
		const settled = next.catch(() => undefined);

		this.queues.set(did, settled);
		void settled.then(() => {
			if (this.queues.get(did) === settled) this.queues.delete(did);
		});

		return next;
	}

	private async settle(did: string, requestedState?: OnlineState): Promise<void> {
		const { db, tables } = this.deps.ctx.database;
		const [existing] = await db
			.select()
			.from(tables.userPresence)
			.where(eq(tables.userPresence.did, did))
			.limit(1);

		const derivedState: OnlineState = this.connections(did) > 0 ? ONLINE : OFFLINE;
		const row = {
			did,
			derivedState,
			requestedState: requestedState ?? existing?.requestedState ?? null,
			statusText: existing?.statusText ?? null,
			statusEmoji: existing?.statusEmoji ?? null,
			viewingChannel: derivedState === OFFLINE ? null : (existing?.viewingChannel ?? null),
			updatedAt: new Date().toISOString(),
		};

		await db
			.insert(tables.userPresence)
			.values(row)
			.onConflictDoUpdate({ target: tables.userPresence.did, set: row });

		const before = existing ? effectiveOnlineState(existing) : OFFLINE;
		const after = effectiveOnlineState(row);
		if (after === before) return;

		const memberships = await db
			.select({ community: tables.members.community })
			.from(tables.members)
			.where(eq(tables.members.did, did));

		this.deps.publish(
			did,
			memberships.map((membership) => membership.community),
			{
				$type: "social.colibri.beta.sync.defs#presenceEvent",
				did,
				presence: presenceOf(this.deps.ctx, did, row, await loadActivity(this.deps.ctx, did)),
			},
		);
	}
}
