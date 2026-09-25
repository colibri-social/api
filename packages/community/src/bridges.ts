import { randomBytes } from "node:crypto";
import type {
	BridgeBackfillState,
	BridgedAttribution,
	BridgeLink,
	Queryable,
	Schema,
} from "@colibri-social/appview-db";
import {
	COLLECTIONS,
	communitySpaces,
	SELF,
	SPACE_TYPES,
	spaceTypeOf,
} from "@colibri-social/lexicons";
import { tidAt, tryParseSpaceRef } from "@colibri-social/space";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import type { CommunityLoader } from "./loader.js";
import type { BlobRef, CommunityWriter } from "./writes.js";

export type BridgeFailure =
	| "communityNotFound"
	| "registrationNotFound"
	| "forbidden"
	| "disabled"
	| "channelNotLinked"
	| "channelNotFound"
	| "pairingNotFound"
	| "alreadyRegistered"
	| "recordNotFound"
	| "notBridged"
	| "alreadyReacted"
	| "threadNotFound"
	| "messageNotFound"
	| "moderationMirrorOff"
	| "backfillNotRequested"
	| "outsideBackfillRange"
	| "rateLimited";

export class BridgeError extends Error {
	constructor(
		readonly failure: BridgeFailure,
		message: string,
	) {
		super(message);
		this.name = "BridgeError";
	}
}

export type BridgeRegistration = Schema["bridgeRegistrations"]["$inferSelect"];
export type BridgePairing = Schema["bridgePairings"]["$inferSelect"];
export type BridgeRemoteRoom = Schema["bridgeRemoteRooms"]["$inferSelect"];
export type BridgeBackfill = Schema["bridgeBackfills"]["$inferSelect"];

export type RemoteSpace = {
	platform: string;
	remoteSpace: string;
	remoteSpaceName: string;
};

export type RemoteAuthor = {
	id: string;
	name: string;
	avatar?: BlobRef;
};

export type RemoteRoomInput = {
	id: string;
	name: string;
	kind?: string;
	parent?: string;
};

export type RegistrationKey = {
	community: string;
	registration: string;
};

export type BridgedMessageInput = RegistrationKey & {
	channel: string;
	author: RemoteAuthor;
	text: string;
	facets?: unknown[];
	parent?: { did: string; rkey: string };
	attachments?: unknown[];
	forward?: Record<string, unknown>;
	remoteMessage?: string;
	createdAt?: string;
};

export type ImportedMessageInput = {
	author: RemoteAuthor;
	text: string;
	facets?: unknown[];
	parent?: { did: string; rkey: string };
	attachments?: unknown[];
	forward?: Record<string, unknown>;
	remoteMessage: string;
	createdAt: string;
};

export type BridgedImportInput = RegistrationKey & {
	channel: string;
	messages: ImportedMessageInput[];
};

export type BackfillReportInput = RegistrationKey & {
	channel: string;
	requestedAt: string;
	state: BridgeBackfillState;
	imported: number;
	from: string;
	until: string;
	reached?: string;
};

export type BridgedEditInput = RegistrationKey & {
	channel: string;
	rkey: string;
	text: string;
	facets?: unknown[];
};

export type BridgedReactionInput = RegistrationKey & {
	channel: string;
	author: RemoteAuthor;
	target: { did: string; rkey: string };
	emoji: string;
};

export type BridgedRecordKey = RegistrationKey & {
	channel: string;
	rkey: string;
};

export type BridgedHideInput = RegistrationKey & {
	channel: string;
	subject: { did: string; rkey: string };
};

export type RateLimit = {
	capacity: number;
	refillPerSecond: number;
};

export type BridgesDeps = {
	db: Queryable;
	tables: Schema;
	loader: CommunityLoader;
	writer: CommunityWriter;
	now?: () => Date;
	pairingTtlSeconds?: number;
	maxPendingPairings?: number;
	rateLimit?: RateLimit;
	importRateLimit?: RateLimit;
};

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const DEFAULT_PAIRING_TTL_SECONDS = 600;
const DEFAULT_MAX_PENDING_PAIRINGS = 10;
const DEFAULT_RATE_LIMIT: RateLimit = { capacity: 30, refillPerSecond: 5 };
const DEFAULT_IMPORT_RATE_LIMIT: RateLimit = { capacity: 100, refillPerSecond: 20 };

export const generatePairingCode = (): string => {
	const bytes = randomBytes(PAIRING_CODE_LENGTH);
	let code = "";
	for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
	return code;
};

export const normalisePairingCode = (code: string): string =>
	code.toUpperCase().replace(/[^A-Z0-9]/g, "");

class TokenBuckets {
	private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

	constructor(private readonly limit: RateLimit) {}

	take(key: string, now: number, cost = 1): boolean {
		const bucket = this.buckets.get(key) ?? { tokens: this.limit.capacity, updatedAt: now };
		const refilled = Math.min(
			this.limit.capacity,
			bucket.tokens + ((now - bucket.updatedAt) / 1000) * this.limit.refillPerSecond,
		);
		const allowed = refilled >= cost;
		this.buckets.set(key, { tokens: allowed ? refilled - cost : refilled, updatedAt: now });
		return allowed;
	}
}

class SerialQueues {
	private readonly tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const next = previous.then(task, task);
		const settled = next.catch(() => undefined);
		this.tails.set(key, settled);
		void settled.then(() => {
			if (this.tails.get(key) === settled) this.tails.delete(key);
		});
		return next;
	}
}

const isMessageSpace = (space: string): boolean => {
	const type = spaceTypeOf(space);
	return type === SPACE_TYPES.channelText || type === SPACE_TYPES.channelThread;
};

export class Bridges {
	private readonly buckets: TokenBuckets;
	private readonly importBuckets: TokenBuckets;
	private readonly queues = new SerialQueues();

	constructor(private readonly deps: BridgesDeps) {
		this.buckets = new TokenBuckets(deps.rateLimit ?? DEFAULT_RATE_LIMIT);
		this.importBuckets = new TokenBuckets(deps.importRateLimit ?? DEFAULT_IMPORT_RATE_LIMIT);
	}

	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	private async requireCommunity(community: string): Promise<void> {
		if (!(await this.deps.loader.community(community))) {
			throw new BridgeError("communityNotFound", "no community exists at that identifier");
		}
	}

	private throttle(key: string): void {
		if (!this.buckets.take(key, this.now().getTime())) {
			throw new BridgeError("rateLimited", "the bridge is sending requests too quickly");
		}
	}

	async createPairing(
		bridge: string,
		remote: RemoteSpace,
	): Promise<{ code: string; expiresAt: string }> {
		this.throttle(`pairing ${bridge}`);
		const { db, tables } = this.deps;
		const now = this.now();
		const pending = await db
			.select({ code: tables.bridgePairings.code })
			.from(tables.bridgePairings)
			.where(
				and(
					eq(tables.bridgePairings.bridge, bridge),
					isNull(tables.bridgePairings.redeemedAt),
					gt(tables.bridgePairings.expiresAt, now.toISOString()),
				),
			);
		if (pending.length >= (this.deps.maxPendingPairings ?? DEFAULT_MAX_PENDING_PAIRINGS)) {
			throw new BridgeError("rateLimited", "the bridge has too many pairing codes waiting");
		}

		const ttl = this.deps.pairingTtlSeconds ?? DEFAULT_PAIRING_TTL_SECONDS;
		const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
		const code = generatePairingCode();
		await db.insert(tables.bridgePairings).values({
			code,
			bridge,
			platform: remote.platform,
			remoteSpace: remote.remoteSpace,
			remoteSpaceName: remote.remoteSpaceName,
			createdAt: now.toISOString(),
			expiresAt,
		});
		return { code, expiresAt };
	}

	async pairing(code: string): Promise<BridgePairing> {
		const { db, tables } = this.deps;
		const [row] = await db
			.select()
			.from(tables.bridgePairings)
			.where(
				and(
					eq(tables.bridgePairings.code, normalisePairingCode(code)),
					isNull(tables.bridgePairings.redeemedAt),
					gt(tables.bridgePairings.expiresAt, this.now().toISOString()),
				),
			)
			.limit(1);
		if (!row) {
			throw new BridgeError("pairingNotFound", "that pairing code does not exist or has expired");
		}
		return row;
	}

	async redeemPairing(community: string, admin: string, code: string): Promise<BridgeRegistration> {
		await this.requireCommunity(community);
		const pairing = await this.pairing(code);
		const { db, tables } = this.deps;

		const [existing] = await db
			.select({ id: tables.bridgeRegistrations.id })
			.from(tables.bridgeRegistrations)
			.where(
				and(
					eq(tables.bridgeRegistrations.community, community),
					eq(tables.bridgeRegistrations.bridge, pairing.bridge),
					eq(tables.bridgeRegistrations.remoteSpace, pairing.remoteSpace),
				),
			)
			.limit(1);
		if (existing) {
			throw new BridgeError(
				"alreadyRegistered",
				"this bridge is already connected to the same remote space in this community",
			);
		}

		const claimed = await db
			.update(tables.bridgePairings)
			.set({ redeemedAt: this.now().toISOString() })
			.where(
				and(eq(tables.bridgePairings.code, pairing.code), isNull(tables.bridgePairings.redeemedAt)),
			)
			.returning({ code: tables.bridgePairings.code });
		if (claimed.length === 0) {
			throw new BridgeError("pairingNotFound", "that pairing code was already used");
		}

		const { rkey } = await this.deps.writer.put(community, {
			space: communitySpaces(community).configuration,
			collection: COLLECTIONS.bridgeRegistration,
			record: {
				$type: COLLECTIONS.bridgeRegistration,
				bridge: pairing.bridge,
				platform: pairing.platform,
				remoteSpace: pairing.remoteSpace,
				remoteSpaceName: pairing.remoteSpaceName,
				links: [],
				enabled: true,
				createdBy: admin,
				createdAt: this.now().toISOString(),
			},
		});
		return this.registration({ community, registration: rkey });
	}

	async registration(key: RegistrationKey): Promise<BridgeRegistration> {
		const { db, tables } = this.deps;
		const [row] = await db
			.select()
			.from(tables.bridgeRegistrations)
			.where(
				and(
					eq(tables.bridgeRegistrations.community, key.community),
					eq(tables.bridgeRegistrations.id, key.registration),
				),
			)
			.limit(1);
		if (!row) {
			throw new BridgeError(
				"registrationNotFound",
				"the community has no such bridge registration",
			);
		}
		return row;
	}

	async listRegistrations(community: string): Promise<BridgeRegistration[]> {
		await this.requireCommunity(community);
		const { db, tables } = this.deps;
		return db
			.select()
			.from(tables.bridgeRegistrations)
			.where(eq(tables.bridgeRegistrations.community, community))
			.orderBy(desc(tables.bridgeRegistrations.id));
	}

	async registrationsHeldBy(bridge: string): Promise<BridgeRegistration[]> {
		const { db, tables } = this.deps;
		return db
			.select()
			.from(tables.bridgeRegistrations)
			.where(eq(tables.bridgeRegistrations.bridge, bridge))
			.orderBy(asc(tables.bridgeRegistrations.community), asc(tables.bridgeRegistrations.id));
	}

	async update(
		key: RegistrationKey,
		changes: { links?: BridgeLink[]; enabled?: boolean; mirrorModeration?: boolean },
	): Promise<BridgeRegistration> {
		await this.requireCommunity(key.community);
		const current = await this.registration(key);
		if (changes.links) await this.requireChannels(key.community, changes.links);

		const record = await this.currentRegistrationRecord(key);
		await this.deps.writer.put(key.community, {
			space: communitySpaces(key.community).configuration,
			collection: COLLECTIONS.bridgeRegistration,
			rkey: key.registration,
			record: {
				...record,
				$type: COLLECTIONS.bridgeRegistration,
				links: (changes.links ?? current.links).map((link) => ({ ...link })),
				enabled: changes.enabled ?? current.enabled,
				mirrorModeration: changes.mirrorModeration ?? current.mirrorModeration,
				updatedAt: this.now().toISOString(),
			},
		});
		return this.registration(key);
	}

	async revoke(key: RegistrationKey): Promise<void> {
		await this.requireCommunity(key.community);
		await this.registration(key);
		await this.deps.writer.remove(key.community, {
			space: communitySpaces(key.community).configuration,
			collection: COLLECTIONS.bridgeRegistration,
			rkey: key.registration,
		});
	}

	async remoteRooms(key: RegistrationKey): Promise<BridgeRemoteRoom[]> {
		await this.requireCommunity(key.community);
		await this.registration(key);
		const { db, tables } = this.deps;
		return db
			.select()
			.from(tables.bridgeRemoteRooms)
			.where(
				and(
					eq(tables.bridgeRemoteRooms.community, key.community),
					eq(tables.bridgeRemoteRooms.registration, key.registration),
				),
			)
			.orderBy(asc(tables.bridgeRemoteRooms.position));
	}

	async putRemoteRooms(
		bridge: string,
		key: RegistrationKey,
		rooms: RemoteRoomInput[],
	): Promise<void> {
		await this.held(bridge, key);
		const { db, tables } = this.deps;
		const updatedAt = this.now().toISOString();
		await db.transaction(async (tx) => {
			await tx
				.delete(tables.bridgeRemoteRooms)
				.where(
					and(
						eq(tables.bridgeRemoteRooms.community, key.community),
						eq(tables.bridgeRemoteRooms.registration, key.registration),
					),
				);
			const seen = new Set<string>();
			for (const [position, room] of rooms.entries()) {
				if (seen.has(room.id)) continue;
				seen.add(room.id);
				await tx.insert(tables.bridgeRemoteRooms).values({
					community: key.community,
					registration: key.registration,
					remoteRoom: room.id,
					name: room.name,
					kind: room.kind ?? null,
					parent: room.parent ?? null,
					position,
					updatedAt,
				});
			}
		});
	}

	async uploadBlob(
		bridge: string,
		key: RegistrationKey,
		bytes: Uint8Array,
		mimeType: string,
	): Promise<BlobRef> {
		await this.writable(bridge, key);
		return this.deps.writer.uploadBlob(key.community, bytes, mimeType);
	}

	async postMessage(bridge: string, input: BridgedMessageInput): Promise<{ rkey: string }> {
		const registration = await this.linked(bridge, input, input.channel);
		const now = this.now().toISOString();
		const createdAt = input.createdAt && input.createdAt < now ? input.createdAt : now;
		const record: Record<string, unknown> = {
			$type: COLLECTIONS.message,
			text: input.text,
			createdAt,
			bridged: this.attribution(registration, input.author, input.remoteMessage),
		};
		if (input.facets?.length) record.facets = input.facets;
		if (input.parent) record.parent = { did: input.parent.did, rkey: input.parent.rkey };
		if (input.attachments?.length) record.attachments = input.attachments;
		if (input.forward) record.forward = input.forward;

		return this.queues.run(input.community, async () => {
			const { rkey } = await this.deps.writer.put(input.community, {
				space: input.channel,
				collection: COLLECTIONS.message,
				record,
			});
			return { rkey };
		});
	}

	async importMessages(
		bridge: string,
		input: BridgedImportInput,
	): Promise<{ remoteMessage: string; rkey: string }[]> {
		const registration = await this.held(bridge, input, "import");
		if (!registration.enabled) {
			throw new BridgeError("disabled", "an admin has paused this registration");
		}
		const channel = await this.linkedChannelOf(registration, input.channel);
		if (!channel) {
			throw new BridgeError("channelNotLinked", "that channel is not linked to this registration");
		}
		const request = registration.links.find((link) => link.channel === channel)?.backfill;
		if (!request) {
			throw new BridgeError(
				"backfillNotRequested",
				"no admin has asked for a history import on this channel",
			);
		}
		const since = request.since ? Date.parse(request.since) : Number.NEGATIVE_INFINITY;
		const until = Date.parse(request.requestedAt);
		for (const message of input.messages) {
			const sent = Date.parse(message.createdAt);
			if (Number.isNaN(sent) || sent < since || sent > until) {
				throw new BridgeError(
					"outsideBackfillRange",
					`message ${message.remoteMessage} was sent outside the requested range`,
				);
			}
		}
		if (
			!this.importBuckets.take(
				`import ${input.community} ${input.registration}`,
				this.now().getTime(),
				input.messages.length,
			)
		) {
			throw new BridgeError("rateLimited", "the bridge is importing messages too quickly");
		}

		return this.queues.run(input.community, async () => {
			const results: { remoteMessage: string; rkey: string }[] = [];
			for (const message of input.messages) {
				const record: Record<string, unknown> = {
					$type: COLLECTIONS.message,
					text: message.text,
					createdAt: message.createdAt,
					bridged: {
						...this.attribution(registration, message.author, message.remoteMessage),
						imported: true,
					},
				};
				if (message.facets?.length) record.facets = message.facets;
				if (message.parent) record.parent = { did: message.parent.did, rkey: message.parent.rkey };
				if (message.attachments?.length) record.attachments = message.attachments;
				if (message.forward) record.forward = message.forward;
				const { rkey } = await this.deps.writer.put(input.community, {
					space: input.channel,
					collection: COLLECTIONS.message,
					rkey: tidAt(message.createdAt, `${registration.id} ${message.remoteMessage}`),
					record,
				});
				results.push({ remoteMessage: message.remoteMessage, rkey });
			}
			return results;
		});
	}

	async reportBackfill(bridge: string, input: BackfillReportInput): Promise<void> {
		const registration = await this.held(bridge, input);
		const link = registration.links.find((entry) => entry.channel === input.channel);
		if (!link) {
			throw new BridgeError("channelNotLinked", "that channel is not linked to this registration");
		}
		if (link.backfill?.requestedAt !== input.requestedAt) {
			throw new BridgeError(
				"backfillNotRequested",
				"that history import is not the one an admin asked for",
			);
		}
		const { db, tables } = this.deps;
		const row = {
			community: input.community,
			registration: input.registration,
			channel: input.channel,
			requestedAt: input.requestedAt,
			state: input.state,
			imported: input.imported,
			from: input.from,
			until: input.until,
			reached: input.reached ?? null,
			updatedAt: this.now().toISOString(),
		};
		await db
			.insert(tables.bridgeBackfills)
			.values(row)
			.onConflictDoUpdate({
				target: [
					tables.bridgeBackfills.community,
					tables.bridgeBackfills.registration,
					tables.bridgeBackfills.channel,
				],
				set: row,
			});
	}

	async backfills(registration: BridgeRegistration): Promise<BridgeBackfill[]> {
		const { db, tables } = this.deps;
		const rows = await db
			.select()
			.from(tables.bridgeBackfills)
			.where(
				and(
					eq(tables.bridgeBackfills.community, registration.community),
					eq(tables.bridgeBackfills.registration, registration.id),
				),
			);
		return rows.filter((row) =>
			registration.links.some(
				(link) => link.channel === row.channel && link.backfill?.requestedAt === row.requestedAt,
			),
		);
	}

	async editMessage(bridge: string, input: BridgedEditInput): Promise<void> {
		await this.linked(bridge, input, input.channel);
		await this.queues.run(input.community, async () => {
			const current = await this.ownRecord(input, COLLECTIONS.message);
			const record: Record<string, unknown> = {
				...current,
				$type: COLLECTIONS.message,
				text: input.text,
				updatedAt: this.now().toISOString(),
			};
			if (input.facets?.length) record.facets = input.facets;
			else delete record.facets;
			await this.deps.writer.put(input.community, {
				space: input.channel,
				collection: COLLECTIONS.message,
				rkey: input.rkey,
				record,
			});
		});
	}

	async deleteMessage(bridge: string, input: BridgedRecordKey): Promise<void> {
		await this.linked(bridge, input, input.channel);
		await this.queues.run(input.community, async () => {
			await this.ownRecord(input, COLLECTIONS.message);
			await this.deps.writer.remove(input.community, {
				space: input.channel,
				collection: COLLECTIONS.message,
				rkey: input.rkey,
			});
		});
	}

	async addReaction(bridge: string, input: BridgedReactionInput): Promise<{ rkey: string }> {
		const registration = await this.linked(bridge, input, input.channel);
		const bridged = this.attribution(registration, input.author);
		return this.queues.run(input.community, async () => {
			const { db, tables } = this.deps;
			const [existing] = await db
				.select({ rkey: tables.reactions.rkey })
				.from(tables.reactions)
				.where(
					and(
						eq(tables.reactions.space, input.channel),
						eq(tables.reactions.targetAuthor, input.target.did),
						eq(tables.reactions.targetRkey, input.target.rkey),
						eq(tables.reactions.author, input.community),
						eq(tables.reactions.bridgedFrom, `${registration.id} ${input.author.id}`),
						eq(tables.reactions.emoji, input.emoji),
					),
				)
				.limit(1);
			if (existing) {
				throw new BridgeError("alreadyReacted", "this person already reacted with that emoji");
			}

			const { rkey } = await this.deps.writer.put(input.community, {
				space: input.channel,
				collection: COLLECTIONS.reaction,
				record: {
					$type: COLLECTIONS.reaction,
					emoji: input.emoji,
					target: { did: input.target.did, rkey: input.target.rkey },
					bridged,
				},
			});
			return { rkey };
		});
	}

	async removeReaction(
		bridge: string,
		input: BridgedRecordKey,
	): Promise<{ target: unknown; emoji: unknown; author: { id: string; name: string } }> {
		await this.linked(bridge, input, input.channel);
		return this.queues.run(input.community, async () => {
			const current = await this.ownRecord(input, COLLECTIONS.reaction);
			await this.deps.writer.remove(input.community, {
				space: input.channel,
				collection: COLLECTIONS.reaction,
				rkey: input.rkey,
			});
			const bridged = current.bridged as { remoteId?: unknown; name?: unknown };
			return {
				target: current.target,
				emoji: current.emoji,
				author: { id: String(bridged.remoteId ?? ""), name: String(bridged.name ?? "") },
			};
		});
	}

	async mayRead(bridge: string, space: string): Promise<boolean> {
		const community = tryParseSpaceRef(space)?.authority;
		if (!community) return false;
		const { db, tables } = this.deps;
		const rows = await db
			.select()
			.from(tables.bridgeRegistrations)
			.where(
				and(
					eq(tables.bridgeRegistrations.bridge, bridge),
					eq(tables.bridgeRegistrations.community, community),
				),
			);
		for (const registration of rows) {
			if (await this.linkedChannelOf(registration, space)) return true;
		}
		return false;
	}

	async linkedChannelOf(registration: BridgeRegistration, space: string): Promise<string | null> {
		if (!registration.enabled) return null;
		const linked = (channel: string) => registration.links.some((link) => link.channel === channel);
		if (linked(space)) return space;
		if (spaceTypeOf(space) !== SPACE_TYPES.channelThread) return null;
		const thread = await this.deps.loader.threadRow(space);
		if (!thread || thread.community !== registration.community) return null;
		if (thread.visibleToRoles.length > 0 || thread.visibleToMembers.length > 0) return null;
		return linked(thread.channel) ? thread.channel : null;
	}

	serialize<T>(community: string, task: () => Promise<T>): Promise<T> {
		return this.queues.run(community, task);
	}

	async threadOpener(
		bridge: string,
		key: RegistrationKey,
		channel: string,
		anchor?: { did: string; rkey: string },
	): Promise<BridgeRegistration> {
		const registration = await this.writable(bridge, key);
		if (!registration.links.some((link) => link.channel === channel)) {
			throw new BridgeError("channelNotLinked", "that channel is not linked to this registration");
		}
		if (anchor && !(await this.messageExists(channel, anchor.did, anchor.rkey))) {
			throw new BridgeError("messageNotFound", "the anchor message is not in that channel");
		}
		return registration;
	}

	async ownThread(
		bridge: string,
		key: RegistrationKey,
		thread: string,
	): Promise<{ registration: BridgeRegistration; record: Record<string, unknown> }> {
		const registration = await this.writable(bridge, key);
		if (spaceTypeOf(thread) !== SPACE_TYPES.channelThread) {
			throw new BridgeError("threadNotFound", "no thread exists in that space");
		}
		const record = await this.deps.writer.currentRecord(
			key.community,
			thread,
			COLLECTIONS.thread,
			SELF,
		);
		if (!record) throw new BridgeError("threadNotFound", "no thread exists in that space");
		const bridged = record.bridged as { registration?: unknown } | undefined;
		if (bridged?.registration !== key.registration) {
			throw new BridgeError("notBridged", "that thread was not opened for this registration");
		}
		return { registration, record };
	}

	async hideable(bridge: string, input: BridgedHideInput): Promise<BridgeRegistration> {
		const registration = await this.linked(bridge, input, input.channel);
		if (!registration.mirrorModeration) {
			throw new BridgeError(
				"moderationMirrorOff",
				"moderation mirroring is turned off for this registration",
			);
		}
		if (input.subject.did === input.community) {
			throw new BridgeError(
				"notBridged",
				"that message was written by the community, delete it with deleteMessage instead",
			);
		}
		if (!(await this.messageExists(input.channel, input.subject.did, input.subject.rkey))) {
			throw new BridgeError("recordNotFound", "no such message in that channel");
		}
		return registration;
	}

	attributionFor(
		registration: BridgeRegistration,
		author: RemoteAuthor,
		remoteId?: string,
	): BridgedAttribution {
		return this.attribution(registration, author, remoteId);
	}

	private async messageExists(space: string, author: string, rkey: string): Promise<boolean> {
		const { db, tables } = this.deps;
		const [row] = await db
			.select({ rkey: tables.messages.rkey })
			.from(tables.messages)
			.where(
				and(
					eq(tables.messages.space, space),
					eq(tables.messages.author, author),
					eq(tables.messages.rkey, rkey),
				),
			)
			.limit(1);
		return row !== undefined;
	}

	private attribution(
		registration: BridgeRegistration,
		author: RemoteAuthor,
		remoteMessage?: string,
	): BridgedAttribution {
		return {
			registration: registration.id,
			platform: registration.platform,
			remoteId: author.id,
			name: author.name,
			...(author.avatar ? { avatar: author.avatar } : {}),
			...(remoteMessage ? { remoteMessage } : {}),
		};
	}

	private async held(
		bridge: string,
		key: RegistrationKey,
		budget: "live" | "import" = "live",
	): Promise<BridgeRegistration> {
		await this.requireCommunity(key.community);
		const registration = await this.registration(key);
		if (registration.bridge !== bridge) {
			throw new BridgeError(
				"forbidden",
				"the caller is not the bridge this registration belongs to",
			);
		}
		if (budget === "live") this.throttle(`registration ${key.community} ${key.registration}`);
		return registration;
	}

	private async writable(bridge: string, key: RegistrationKey): Promise<BridgeRegistration> {
		const registration = await this.held(bridge, key);
		if (!registration.enabled) {
			throw new BridgeError("disabled", "an admin has paused this registration");
		}
		return registration;
	}

	private async linked(
		bridge: string,
		key: RegistrationKey,
		channel: string,
	): Promise<BridgeRegistration> {
		const registration = await this.writable(bridge, key);
		if (!(await this.linkedChannelOf(registration, channel))) {
			throw new BridgeError("channelNotLinked", "that channel is not linked to this registration");
		}
		return registration;
	}

	private async ownRecord(
		input: BridgedRecordKey,
		collection: string,
	): Promise<Record<string, unknown>> {
		const current = await this.deps.writer.currentRecord(
			input.community,
			input.channel,
			collection,
			input.rkey,
		);
		if (!current) throw new BridgeError("recordNotFound", "no such record in that channel");
		const bridged = current.bridged as { registration?: unknown } | undefined;
		if (bridged?.registration !== input.registration) {
			throw new BridgeError("notBridged", "that record was not written for this registration");
		}
		return current;
	}

	private async currentRegistrationRecord(key: RegistrationKey): Promise<Record<string, unknown>> {
		const record = await this.deps.writer.currentRecord(
			key.community,
			communitySpaces(key.community).configuration,
			COLLECTIONS.bridgeRegistration,
			key.registration,
		);
		if (!record) {
			throw new BridgeError(
				"registrationNotFound",
				"the community has no such bridge registration",
			);
		}
		return record;
	}

	private async requireChannels(community: string, links: BridgeLink[]): Promise<void> {
		const { db, tables } = this.deps;
		const channels = await db
			.select({ space: tables.channels.space })
			.from(tables.channels)
			.where(eq(tables.channels.community, community));
		const known = new Set(channels.map((row) => row.space));
		for (const link of links) {
			if (!known.has(link.channel) || !isMessageSpace(link.channel)) {
				throw new BridgeError(
					"channelNotFound",
					`the community has no text channel ${link.channel}`,
				);
			}
		}
	}
}
