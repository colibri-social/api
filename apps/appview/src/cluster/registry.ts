import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database, NodeRole, NodeState } from "@colibri-social/appview-db";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { PEER_HEARTBEAT_WINDOW_MS } from "../drain.js";
import { quorumAllows } from "./quorum.js";

export const JOIN_TOKEN_TTL_MS = 60 * 60_000;

export const CLUSTER_STATE_ID = "cluster";

const PARKED_STATES: readonly NodeState[] = ["maintenance", "retired"];

const COUNTED_STATES: readonly NodeState[] = ["joining", "active", "draining", "down"];

const CLIENT_ROLES: readonly NodeRole[] = ["api", "live", "voice"];

export type NodeIdentity = {
	id: string;
	region: string;
	roles: NodeRole[];
};

export type NodeAddress = {
	publicUrl: string;
	tailnetUrl: string;
	announcedIp?: string | undefined;
	version: string;
};

export type NodeRow = NodeIdentity &
	NodeAddress & {
		state: NodeState;
		connections: number;
		activeCalls: number;
		heartbeatAt: string | null;
		drainDeadline: string | null;
	};

export type NodeLoad = {
	connections: number;
	activeCalls: number;
	version: string;
};

export type LeaveDecision = { allowed: true } | { allowed: false; reason: string };

export type Registry = {
	createJoinToken: (identity: NodeIdentity) => Promise<string>;
	redeem: (token: string, address: NodeAddress) => Promise<{ id: string; secret: string } | null>;
	verify: (id: string, secret: string) => Promise<boolean>;
	register: (identity: NodeIdentity, address: NodeAddress) => Promise<NodeState>;
	heartbeat: (id: string, load: NodeLoad) => Promise<void>;
	setState: (id: string, state: NodeState, drainDeadline?: Date | null) => Promise<void>;
	node: (id: string) => Promise<NodeRow | null>;
	list: () => Promise<NodeRow[]>;
	accepting: () => Promise<NodeRow[]>;
	mayLeave: (id: string) => Promise<LeaveDecision>;
	claimMain: (id: string) => Promise<void>;
	remove: (id: string) => Promise<void>;
	mainNode: () => Promise<NodeRow | null>;
	rolloutPaused: () => Promise<boolean>;
	pauseRollout: () => Promise<void>;
};

const hash = (value: string): string => {
	return createHash("sha256").update(value).digest("hex");
};

const sameHash = (a: string, b: string): boolean => {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");

	return left.length === right.length && timingSafeEqual(left, right);
};

export const newSecret = (): string => {
	return randomBytes(32).toString("base64url");
};

export const createRegistry = (
	database: Database,
	now: () => Date = () => new Date(),
): Registry => {
	const { primary, tables } = database;
	const nodes = tables.nodes;

	const fresh = () => {
		return gt(
			nodes.heartbeatAt,
			new Date(now().getTime() - PEER_HEARTBEAT_WINDOW_MS).toISOString(),
		);
	};

	const toRow = (row: typeof nodes.$inferSelect): NodeRow => {
		return {
			id: row.id,
			region: row.region,
			roles: row.roles,
			publicUrl: row.publicUrl,
			tailnetUrl: row.tailnetUrl,
			...(row.announcedIp ? { announcedIp: row.announcedIp } : {}),
			version: row.version ?? "",
			state: row.state,
			connections: row.connections,
			activeCalls: row.activeCalls,
			heartbeatAt: row.heartbeatAt,
			drainDeadline: row.drainDeadline,
		};
	};

	const node = async (id: string): Promise<NodeRow | null> => {
		const [row] = await primary.select().from(nodes).where(eq(nodes.id, id)).limit(1);

		return row ? toRow(row) : null;
	};

	const addressColumns = (address: NodeAddress) => {
		return {
			publicUrl: address.publicUrl,
			tailnetUrl: address.tailnetUrl,
			announcedIp: address.announcedIp ?? null,
			version: address.version,
		};
	};

	return {
		createJoinToken: async (identity) => {
			const token = newSecret();

			await primary.insert(tables.nodeJoinTokens).values({
				tokenHash: hash(token),
				nodeId: identity.id,
				region: identity.region,
				roles: identity.roles,
				expiresAt: new Date(now().getTime() + JOIN_TOKEN_TTL_MS).toISOString(),
			});

			return token;
		},
		redeem: async (token, address) => {
			const at = now().toISOString();
			const [claimed] = await primary
				.update(tables.nodeJoinTokens)
				.set({ usedAt: at })
				.where(
					and(
						eq(tables.nodeJoinTokens.tokenHash, hash(token)),
						isNull(tables.nodeJoinTokens.usedAt),
						gt(tables.nodeJoinTokens.expiresAt, at),
					),
				)
				.returning();

			if (!claimed) {
				return null;
			}

			const secret = newSecret();
			const row = {
				id: claimed.nodeId,
				region: claimed.region,
				roles: claimed.roles,
				...addressColumns(address),
				state: "joining" as const,
				secretHash: hash(secret),
				registeredAt: at,
			};

			await primary
				.insert(nodes)
				.values(row)
				.onConflictDoUpdate({
					target: nodes.id,
					set: { ...row, registeredAt: undefined },
				});

			return { id: claimed.nodeId, secret };
		},
		verify: async (id, secret) => {
			const [row] = await primary
				.select({ secretHash: nodes.secretHash, state: nodes.state })
				.from(nodes)
				.where(eq(nodes.id, id))
				.limit(1);

			if (!row?.secretHash || row.state === "retired") {
				return false;
			}

			return sameHash(row.secretHash, hash(secret));
		},
		register: async (identity, address) => {
			const at = now().toISOString();
			const existing = await node(identity.id);
			const state: NodeState =
				existing && PARKED_STATES.includes(existing.state) ? existing.state : "active";
			const row = {
				id: identity.id,
				region: identity.region,
				roles: identity.roles,
				...addressColumns(address),
				state,
				drainDeadline: null,
				heartbeatAt: at,
			};

			await primary
				.insert(nodes)
				.values({ ...row, registeredAt: at })
				.onConflictDoUpdate({ target: nodes.id, set: row });

			return state;
		},
		heartbeat: async (id, load) => {
			await primary
				.update(nodes)
				.set({ ...load, heartbeatAt: now().toISOString() })
				.where(eq(nodes.id, id));
		},
		setState: async (id, state, drainDeadline) => {
			await primary
				.update(nodes)
				.set({
					state,
					...(drainDeadline === undefined
						? {}
						: { drainDeadline: drainDeadline?.toISOString() ?? null }),
				})
				.where(eq(nodes.id, id));
		},
		node,
		list: async () => {
			return (await primary.select().from(nodes).orderBy(nodes.region, nodes.id)).map(toRow);
		},
		accepting: async () => {
			const rows = await database.db
				.select()
				.from(nodes)
				.where(and(eq(nodes.state, "active"), fresh()));

			return rows.map(toRow).filter((row) => row.roles.some((role) => CLIENT_ROLES.includes(role)));
		},
		mayLeave: async (id) => {
			const counted = await primary
				.select({ id: nodes.id, state: nodes.state, heartbeatAt: nodes.heartbeatAt })
				.from(nodes)
				.where(inArray(nodes.state, [...COUNTED_STATES]));
			const since = now().getTime() - PEER_HEARTBEAT_WINDOW_MS;
			const up = counted.filter(
				(row) =>
					row.state === "active" &&
					row.heartbeatAt !== null &&
					new Date(row.heartbeatAt).getTime() > since,
			);
			const remaining = up.filter((row) => row.id !== id).length;

			if (quorumAllows(counted.length, remaining)) {
				return { allowed: true };
			}

			return {
				allowed: false,
				reason: `${remaining} of ${counted.length} nodes would stay up, below the quorum floor`,
			};
		},
		claimMain: async (id) => {
			const at = now().toISOString();

			await primary
				.insert(tables.clusterState)
				.values({ id: CLUSTER_STATE_ID, mainNodeId: id, updatedAt: at })
				.onConflictDoUpdate({
					target: tables.clusterState.id,
					set: { mainNodeId: id, updatedAt: at },
				});
		},
		remove: async (id) => {
			await primary.delete(tables.voiceParticipants).where(eq(tables.voiceParticipants.nodeId, id));
			await primary.delete(tables.voiceCalls).where(eq(tables.voiceCalls.nodeId, id));
			await primary.delete(tables.nodeJoinTokens).where(eq(tables.nodeJoinTokens.nodeId, id));
			await primary.delete(nodes).where(eq(nodes.id, id));
		},
		mainNode: async () => {
			const [state] = await primary
				.select({ mainNodeId: tables.clusterState.mainNodeId })
				.from(tables.clusterState)
				.where(eq(tables.clusterState.id, CLUSTER_STATE_ID))
				.limit(1);

			return state?.mainNodeId ? node(state.mainNodeId) : null;
		},
		rolloutPaused: async () => {
			const [state] = await primary
				.select({ paused: tables.clusterState.rolloutPaused })
				.from(tables.clusterState)
				.where(eq(tables.clusterState.id, CLUSTER_STATE_ID))
				.limit(1);

			return state?.paused ?? false;
		},
		pauseRollout: async () => {
			const at = now().toISOString();

			await primary
				.insert(tables.clusterState)
				.values({ id: CLUSTER_STATE_ID, rolloutPaused: true, updatedAt: at })
				.onConflictDoUpdate({
					target: tables.clusterState.id,
					set: { rolloutPaused: true, updatedAt: at },
				});
		},
	};
};
