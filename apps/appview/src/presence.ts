import type { OnlineState, ReactionEmojiRef } from "@colibri-social/appview-db";
import type { social } from "@colibri-social/lexicons";
import { ACTIVE_WINDOW_MS, connectionStaleBefore } from "@colibri-social/notifications";
import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
import type { AppContext } from "./context.js";
import { type ActivityView, loadActorActivities } from "./views/activity.js";
import { loadVoiceState } from "./views/voice-state.js";
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
	statusCustomEmoji: ReactionEmojiRef | null;
	statusExpiresAt: string | null;
	statusShowWhileOffline: boolean;
};

export const isStatusExpired = (row: PresenceParts, now: number = Date.now()): boolean =>
	row.statusExpiresAt !== null && new Date(row.statusExpiresAt).getTime() <= now;

const statusOf = (row: PresenceParts): social.colibri.beta.actor.defs.Status | undefined => {
	if (isStatusExpired(row)) return undefined;
	if (!row.statusText && !row.statusEmoji && !row.statusCustomEmoji) return undefined;
	return {
		text: row.statusText ?? "",
		emoji: row.statusEmoji || undefined,
		customEmoji: row.statusCustomEmoji ?? undefined,
		expiresAt: row.statusExpiresAt ?? undefined,
		showWhileOffline: row.statusShowWhileOffline,
	} as social.colibri.beta.actor.defs.Status;
};

export const presenceOf = (
	row: PresenceParts,
	activities: ActivityView[],
	voice?: social.colibri.beta.actor.defs.VoiceState,
): social.colibri.beta.actor.defs.Presence =>
	({
		onlineState: effectiveOnlineState(row),
		status: statusOf(row),
		voice,
		activities,
	}) as social.colibri.beta.actor.defs.Presence;

export const isOnlineState = (value: string): value is OnlineState =>
	value === ONLINE || value === "away" || value === "dnd" || value === OFFLINE;

export type PresenceDeps = {
	ctx: AppContext;
	nodeId: string;
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

	async requested(did: string, state: OnlineState): Promise<void> {
		return this.enqueue(did, () => this.settle(did, state));
	}

	async reconcile(limit = RECONCILE_BATCH): Promise<number> {
		const { db, tables } = this.deps.ctx.database;
		const online = await db
			.select({ did: tables.userPresence.did })
			.from(tables.userPresence)
			.where(eq(tables.userPresence.derivedState, ONLINE))
			.limit(limit);
		let settled = 0;

		for (const { did } of online) {
			if (this.connections(did) > 0) {
				continue;
			}

			await this.enqueue(did, () => this.settle(did));
			settled += 1;
		}

		return settled;
	}

	private async connectedElsewhere(did: string): Promise<boolean> {
		const { db, tables } = this.deps.ctx.database;
		const rows = await db
			.select({ id: tables.presenceConnections.id })
			.from(tables.presenceConnections)
			.where(
				and(
					eq(tables.presenceConnections.did, did),
					ne(tables.presenceConnections.nodeId, this.deps.nodeId),
					gte(tables.presenceConnections.seenAt, connectionStaleBefore(new Date().toISOString())),
				),
			)
			.limit(1);

		return rows.length > 0;
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

		const connected = this.connections(did) > 0 || (await this.connectedElsewhere(did));
		const derivedState: OnlineState = connected ? ONLINE : OFFLINE;
		const row = {
			did,
			derivedState,
			requestedState: requestedState ?? existing?.requestedState ?? null,
			statusText: existing?.statusText ?? null,
			statusEmoji: existing?.statusEmoji ?? null,
			statusCustomEmoji: existing?.statusCustomEmoji ?? null,
			statusExpiresAt: existing?.statusExpiresAt ?? null,
			statusShowWhileOffline: existing?.statusShowWhileOffline ?? false,
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
				presence: presenceOf(
					row,
					await loadActorActivities(this.deps.ctx, did),
					await loadVoiceState(this.deps.ctx, did),
				),
			},
		);
	}
}

const ACTIVE_REFRESH_MS = 60 * 1000;

const RECONCILE_BATCH = 500;

export type ConnectionPresenceDeps = {
	ctx: Pick<AppContext, "database">;
	nodeId: string;
	now?: () => number;
};

export class ConnectionPresence {
	private readonly queues = new Map<string, Promise<void>>();
	private readonly activeUntil = new Map<string, number>();
	private readonly now: () => number;

	constructor(private readonly deps: ConnectionPresenceDeps) {
		this.now = deps.now ?? Date.now;
	}

	private get database() {
		return this.deps.ctx.database;
	}

	private iso(at: number = this.now()): string {
		return new Date(at).toISOString();
	}

	async opened(id: string, did: string): Promise<void> {
		return this.enqueue(id, async () => {
			const { db, tables } = this.database;
			await db.insert(tables.presenceConnections).values({
				id,
				did,
				viewingChannel: null,
				activeUntil: null,
				seenAt: this.iso(),
				nodeId: this.deps.nodeId,
			});
		});
	}

	async viewing(id: string, channel: string | null): Promise<void> {
		return this.enqueue(id, async () => {
			const { db, tables } = this.database;
			await db
				.update(tables.presenceConnections)
				.set({ viewingChannel: channel, seenAt: this.iso() })
				.where(eq(tables.presenceConnections.id, id));
		});
	}

	async active(id: string): Promise<void> {
		return this.enqueue(id, async () => {
			const now = this.now();
			const until = now + ACTIVE_WINDOW_MS;
			if (until - (this.activeUntil.get(id) ?? 0) < ACTIVE_REFRESH_MS) return;
			this.activeUntil.set(id, until);
			const { db, tables } = this.database;
			await db
				.update(tables.presenceConnections)
				.set({ activeUntil: this.iso(until), seenAt: this.iso(now) })
				.where(eq(tables.presenceConnections.id, id));
		});
	}

	async closed(id: string): Promise<void> {
		return this.enqueue(id, async () => {
			this.activeUntil.delete(id);
			const { db, tables } = this.database;
			await db.delete(tables.presenceConnections).where(eq(tables.presenceConnections.id, id));
		});
	}

	async touch(ids: readonly string[]): Promise<void> {
		if (ids.length === 0) return;
		const { db, tables } = this.database;
		await db
			.update(tables.presenceConnections)
			.set({ seenAt: this.iso() })
			.where(inArray(tables.presenceConnections.id, [...ids]));
	}

	async sweep(): Promise<void> {
		const { db, tables } = this.database;
		await db
			.delete(tables.presenceConnections)
			.where(lt(tables.presenceConnections.seenAt, connectionStaleBefore(this.iso())));
	}

	private enqueue(id: string, work: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(id) ?? Promise.resolve();
		const next = previous.then(work);
		const settled = next.catch(() => undefined);

		this.queues.set(id, settled);
		void settled.then(() => {
			if (this.queues.get(id) === settled) this.queues.delete(id);
		});

		return next;
	}
}
