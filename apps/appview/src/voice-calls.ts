import type { Database, NodeRole } from "@colibri-social/appview-db";
import { and, eq, gt, inArray, ne, notInArray } from "drizzle-orm";
import { PEER_HEARTBEAT_WINDOW_MS } from "./drain.js";

export type VoiceNode = {
	id: string;
	region: string;
	publicUrl: string;
};

export type VoiceCommand = {
	channel: string;
	subject: string;
	muted?: boolean;
	deafened?: boolean;
	disconnect?: boolean;
	moveTo?: string;
	supersede?: boolean;
};

export type ServerModeration = {
	serverMuted: boolean;
	serverDeafened: boolean;
};

export type CallClaim = { kind: "here" } | { kind: "elsewhere"; node: VoiceNode };

export type ParticipantState = {
	muted: boolean;
	deafened: boolean;
	serverMuted: boolean;
	serverDeafened: boolean;
	camera: boolean;
	screen: boolean;
};

export type ParticipantRow = ParticipantState & {
	did: string;
	channel: string;
	nodeId: string;
};

export type VoiceCalls = {
	claim: (channel: string, options: { acceptNew: boolean }) => Promise<CallClaim>;
	ownerOf: (channel: string) => Promise<string | null>;
	handOver: (channel: string, nodeId: string) => Promise<boolean>;
	end: (channel: string) => Promise<void>;
	moderationOf: (community: string, did: string) => Promise<ServerModeration>;
	saveModeration: (community: string, did: string, state: ServerModeration) => Promise<void>;
	candidates: () => Promise<VoiceNode[]>;
	node: (nodeId: string) => Promise<VoiceNode | null>;
	joined: (did: string, channel: string, state: ParticipantState) => Promise<void>;
	updated: (did: string, channel: string, state: ParticipantState) => Promise<void>;
	left: (did: string, channel: string) => Promise<void>;
	participant: (did: string) => Promise<ParticipantRow | null>;
	participants: (dids: readonly string[]) => Promise<Map<string, ParticipantRow>>;
	forgetNode: () => Promise<ParticipantRow[]>;
	sweep: () => Promise<ParticipantRow[]>;
};

export type VoiceCallsDeps = {
	database: Database;
	nodeId: string;
	region?: string | undefined;
	now?: () => Date;
};

const CLAIM_ATTEMPTS = 3;

type ParticipantSelect = Database["tables"]["voiceParticipants"]["$inferSelect"];

const toParticipant = (row: ParticipantSelect): ParticipantRow => {
	return {
		did: row.did,
		channel: row.channel,
		nodeId: row.nodeId,
		muted: row.muted,
		deafened: row.deafened,
		serverMuted: row.serverMuted,
		serverDeafened: row.serverDeafened,
		camera: row.camera,
		screen: row.screen,
	};
};

export const readParticipants = async (
	{ db, tables }: Pick<Database, "db" | "tables">,
	dids: readonly string[],
): Promise<Map<string, ParticipantRow>> => {
	if (dids.length === 0) {
		return new Map();
	}

	const rows = await db
		.select()
		.from(tables.voiceParticipants)
		.where(inArray(tables.voiceParticipants.did, [...dids]));

	return new Map(rows.map((row) => [row.did, toParticipant(row)]));
};

export const signalingUrlOf = (node: VoiceNode): string => {
	return node.publicUrl;
};

export const probeUrlOf = (node: VoiceNode): string => {
	return new URL("/health", node.publicUrl).toString();
};

const OWNER_STATES = ["active", "draining"] as const;

const hasVoice = (roles: readonly NodeRole[]): boolean => {
	return roles.includes("voice");
};

export const createVoiceCalls = (deps: VoiceCallsDeps): VoiceCalls => {
	const { primary, db, tables } = deps.database;
	const now = deps.now ?? (() => new Date());
	const self = deps.nodeId;

	const heartbeatSince = () => {
		return new Date(now().getTime() - PEER_HEARTBEAT_WINDOW_MS).toISOString();
	};

	const toNode = (row: { id: string; region: string; publicUrl: string }): VoiceNode => {
		return { id: row.id, region: row.region, publicUrl: row.publicUrl };
	};

	const readCall = async (channel: string) => {
		const [row] = await primary
			.select()
			.from(tables.voiceCalls)
			.where(eq(tables.voiceCalls.channel, channel))
			.limit(1);

		return row ?? null;
	};

	const liveNode = async (
		nodeId: string,
		states: readonly ("active" | "draining")[],
	): Promise<VoiceNode | null> => {
		const [row] = await primary
			.select()
			.from(tables.nodes)
			.where(
				and(
					eq(tables.nodes.id, nodeId),
					inArray(tables.nodes.state, [...states]),
					gt(tables.nodes.heartbeatAt, heartbeatSince()),
				),
			)
			.limit(1);

		return row && hasVoice(row.roles) ? toNode(row) : null;
	};

	const candidates = async (): Promise<VoiceNode[]> => {
		const rows = await primary
			.select()
			.from(tables.nodes)
			.where(
				and(
					eq(tables.nodes.state, "active"),
					gt(tables.nodes.heartbeatAt, heartbeatSince()),
					ne(tables.nodes.id, self),
				),
			);
		const voiceNodes = rows.filter((row) => hasVoice(row.roles)).map(toNode);
		const local = voiceNodes.filter((node) => node.region === deps.region);
		const remote = voiceNodes.filter((node) => node.region !== deps.region);

		return [...local, ...remote];
	};

	const claim = async (
		channel: string,
		options: { acceptNew: boolean },
		attempt = 1,
	): Promise<CallClaim> => {
		const existing = await readCall(channel);

		if (!existing) {
			if (!options.acceptNew) {
				const [target] = await candidates();

				if (target) {
					return { kind: "elsewhere", node: target };
				}
			}

			await primary
				.insert(tables.voiceCalls)
				.values({ channel, nodeId: self, startedAt: now().toISOString() })
				.onConflictDoNothing();
		} else if (existing.nodeId === self) {
			return { kind: "here" };
		} else {
			const owner = await liveNode(existing.nodeId, OWNER_STATES);

			if (owner) {
				return { kind: "elsewhere", node: owner };
			}

			await primary
				.update(tables.voiceCalls)
				.set({ nodeId: self })
				.where(
					and(
						eq(tables.voiceCalls.channel, channel),
						eq(tables.voiceCalls.nodeId, existing.nodeId),
					),
				);
		}

		const after = await readCall(channel);

		if (after?.nodeId === self) {
			return { kind: "here" };
		}

		if (attempt >= CLAIM_ATTEMPTS) {
			throw new Error(`could not claim the call in ${channel}`);
		}

		return claim(channel, options, attempt + 1);
	};

	const writeParticipant = async (did: string, channel: string, state: ParticipantState) => {
		const row = { did, channel, nodeId: self, ...state, updatedAt: now().toISOString() };

		await primary
			.insert(tables.voiceParticipants)
			.values(row)
			.onConflictDoUpdate({ target: tables.voiceParticipants.did, set: row });
	};

	const participants = (dids: readonly string[], source = db) => {
		return readParticipants({ db: source, tables }, dids);
	};

	return {
		claim: (channel, options) => claim(channel, options),
		ownerOf: async (channel) => {
			return (await readCall(channel))?.nodeId ?? null;
		},
		handOver: async (channel, nodeId) => {
			const moved = await primary
				.update(tables.voiceCalls)
				.set({ nodeId })
				.where(and(eq(tables.voiceCalls.channel, channel), eq(tables.voiceCalls.nodeId, self)))
				.returning({ channel: tables.voiceCalls.channel });

			return moved.length > 0;
		},
		end: async (channel) => {
			await primary
				.delete(tables.voiceCalls)
				.where(and(eq(tables.voiceCalls.channel, channel), eq(tables.voiceCalls.nodeId, self)));
		},
		moderationOf: async (community, did) => {
			const [row] = await primary
				.select()
				.from(tables.voiceModeration)
				.where(
					and(eq(tables.voiceModeration.community, community), eq(tables.voiceModeration.did, did)),
				)
				.limit(1);

			return {
				serverMuted: row?.serverMuted ?? false,
				serverDeafened: row?.serverDeafened ?? false,
			};
		},
		saveModeration: async (community, did, state) => {
			const where = and(
				eq(tables.voiceModeration.community, community),
				eq(tables.voiceModeration.did, did),
			);

			if (!state.serverMuted && !state.serverDeafened) {
				await primary.delete(tables.voiceModeration).where(where);

				return;
			}

			const row = { community, did, ...state, updatedAt: now().toISOString() };

			await primary
				.insert(tables.voiceModeration)
				.values(row)
				.onConflictDoUpdate({
					target: [tables.voiceModeration.community, tables.voiceModeration.did],
					set: { ...state, updatedAt: row.updatedAt },
				});
		},
		candidates,
		node: (nodeId) => liveNode(nodeId, ["active"]),
		joined: writeParticipant,
		updated: writeParticipant,
		left: async (did, channel) => {
			await primary
				.delete(tables.voiceParticipants)
				.where(
					and(
						eq(tables.voiceParticipants.did, did),
						eq(tables.voiceParticipants.channel, channel),
						eq(tables.voiceParticipants.nodeId, self),
					),
				);
		},
		participant: async (did) => {
			return (await participants([did], primary)).get(did) ?? null;
		},
		participants: (dids) => participants(dids),
		forgetNode: async () => {
			await primary.delete(tables.voiceCalls).where(eq(tables.voiceCalls.nodeId, self));

			const removed = await primary
				.delete(tables.voiceParticipants)
				.where(eq(tables.voiceParticipants.nodeId, self))
				.returning();

			return removed.map(toParticipant);
		},
		sweep: async () => {
			const live = await primary
				.select({ id: tables.nodes.id })
				.from(tables.nodes)
				.where(
					and(
						inArray(tables.nodes.state, [...OWNER_STATES]),
						gt(tables.nodes.heartbeatAt, heartbeatSince()),
					),
				);
			const keep = [self, ...live.map((row) => row.id)];
			const stale = await primary
				.select()
				.from(tables.voiceParticipants)
				.where(notInArray(tables.voiceParticipants.nodeId, keep));

			for (const row of stale) {
				await primary
					.delete(tables.voiceParticipants)
					.where(
						and(
							eq(tables.voiceParticipants.did, row.did),
							eq(tables.voiceParticipants.nodeId, row.nodeId),
						),
					);
			}

			await primary.delete(tables.voiceCalls).where(notInArray(tables.voiceCalls.nodeId, keep));

			return stale.map(toParticipant);
		},
	};
};
