import type { Database } from "@colibri-social/appview-db";
import {
	blobCid,
	COLLECTIONS,
	communitySpaces,
	LEGACY_CHANNEL_TYPES,
	LEGACY_COLLECTIONS,
	SELF,
	SPACE_TYPES,
	spaceUri,
} from "@colibri-social/lexicons";
import { messageFutureRefusal } from "@colibri-social/projections";
import { managedspacePolicy, memberspacePolicy, type PdsClient } from "@colibri-social/space";
import type { CommunityCredentials } from "./credentials.js";
import type { SpaceRegistry } from "./spaces.js";
import type { CommunityWriter } from "./writes.js";

export type LegacyRecord<T = Record<string, unknown>> = {
	uri: string;
	cid: string;
	value: T;
};

export type MigrationReport = {
	community: string;
	spacesCreated: string[];
	categories: number;
	channels: number;
	roles: number;
	members: number;
	bans: number;
	legacyMessages: number;
	warnings: string[];
};

export const MIGRATION_STEPS = [
	"readingLegacyRepo",
	"creatingSpaces",
	"writingProfile",
	"writingSettings",
	"migratingRoles",
	"migratingMembers",
	"migratingBans",
	"migratingChannels",
	"migratingCategories",
	"mirroringMessages",
	"retiringLegacyCommunity",
	"done",
] as const;

export type MigrationStep = (typeof MIGRATION_STEPS)[number];

export const isMigrationStep = (value: string): value is MigrationStep =>
	(MIGRATION_STEPS as readonly string[]).includes(value);

export type MigrationProgress = {
	step: MigrationStep;
	completed: number;
	total: number;
	community: string;
};

export const migrationProgress = (community: string, step: MigrationStep): MigrationProgress => ({
	step,
	completed: MIGRATION_STEPS.indexOf(step),
	total: MIGRATION_STEPS.length - 1,
	community,
});

export type MigrateDeps = {
	database: Database;
	hostFor: (did: string) => Promise<string>;
	credentials: CommunityCredentials;
	writer: CommunityWriter;
	spaces: SpaceRegistry;
	appviewService: string;
	log: (message: string, detail?: Record<string, unknown>) => void;
	onProgress?: (progress: MigrationProgress) => void;
	onStepDone?: (step: MigrationStep) => Promise<void>;
	completed?: ReadonlySet<MigrationStep>;
	target?: string;
	dryRun?: boolean;
};

type LegacyCommunityValue = {
	name?: string;
	description?: string;
	picture?: unknown;
	banner?: unknown;
	categoryOrder?: string[];
	requiresApprovalToJoin?: boolean;
	linkEmbeds?: boolean;
	migratedTo?: string;
};

type LegacyChannelValue = {
	name?: string;
	description?: string;
	type?: string;
	category?: string;
	ownerOnly?: boolean;
	allowedRoles?: string[];
	allowedMembers?: string[];
	linkEmbeds?: boolean;
};

type LegacyMemberValue = {
	subject?: string;
	roles?: string[];
	joinedAt?: string;
	nickname?: string;
};

type LegacyModerationValue = {
	action?: string;
	subject?: { did?: string; uri?: string };
	reason?: string;
	createdBy?: string;
	createdAt?: string;
};

export type LegacyMessageValue = {
	text?: string;
	facets?: unknown[];
	createdAt?: string;
	channel?: string;
	parent?: string;
	attachments?: unknown[];
	suppressedEmbeds?: string[];
};

const LEGACY_FACET_PREFIX = "social.colibri.richtext.facet";
const BETA_FACET_PREFIX = "social.colibri.beta.richtext.facet";
const BLUESKY_FACET_PREFIX = "app.bsky.richtext.facet";
const BLUESKY_FEATURES = new Set(["#link", "#mention"]);

const betaFeatureType = (type: string): string | undefined => {
	if (type.startsWith(LEGACY_FACET_PREFIX)) {
		return `${BETA_FACET_PREFIX}${type.slice(LEGACY_FACET_PREFIX.length)}`;
	}
	if (type.startsWith(BLUESKY_FACET_PREFIX)) {
		const fragment = type.slice(BLUESKY_FACET_PREFIX.length);
		return BLUESKY_FEATURES.has(fragment) ? `${BETA_FACET_PREFIX}${fragment}` : undefined;
	}
	return undefined;
};

const plainIndex = (index: unknown) => {
	if (!index || typeof index !== "object") return undefined;
	const { byteStart, byteEnd } = index as { byteStart?: unknown; byteEnd?: unknown };
	if (typeof byteStart !== "number" || typeof byteEnd !== "number") return undefined;
	return { byteStart, byteEnd };
};
const MESSAGE_BATCH = 100;

export const legacyCommunityUri = (did: string) =>
	`at://${did}/${LEGACY_COLLECTIONS.community}/${SELF}`;

export const migratedCommunityUri = (did: string) => `at://${did}/${COLLECTIONS.community}/${SELF}`;

export const rkeyOf = (uri: string) => uri.split("/").pop() as string;

export const channelSpaceFor = (community: string, legacy: LegacyRecord<LegacyChannelValue>) =>
	spaceUri(
		community,
		legacy.value.type === LEGACY_CHANNEL_TYPES.voice
			? SPACE_TYPES.channelVoice
			: SPACE_TYPES.channelText,
		rkeyOf(legacy.uri),
	);

export const activeBans = (
	records: readonly LegacyRecord<LegacyModerationValue>[],
): LegacyRecord<LegacyModerationValue>[] => {
	const ordered = [...records]
		.filter((record) => record.value.subject?.did)
		.filter((record) => record.value.action === "ban" || record.value.action === "unban")
		.sort((a, b) => {
			const byTime = (a.value.createdAt ?? "").localeCompare(b.value.createdAt ?? "");
			return byTime !== 0 ? byTime : rkeyOf(a.uri).localeCompare(rkeyOf(b.uri));
		});
	const latest = new Map<string, LegacyRecord<LegacyModerationValue>>();
	for (const record of ordered) latest.set(record.value.subject?.did as string, record);
	return [...latest.values()].filter((record) => record.value.action === "ban");
};

export const legacyChannelRkey = (community: string, channel: string | undefined) => {
	if (!channel) return undefined;
	if (!channel.startsWith("at://")) return channel;
	const [authority, collection, rkey] = channel.slice("at://".length).split("/");
	if (authority !== community || collection !== LEGACY_COLLECTIONS.channel) return undefined;
	return rkey;
};

export const rewriteLegacyFacets = (
	facets: readonly unknown[] | undefined,
	community: string,
	channelSpaces: ReadonlyMap<string, string>,
): unknown[] | null => {
	if (!facets?.length) return null;
	const out: unknown[] = [];
	for (const facet of facets) {
		if (!facet || typeof facet !== "object") continue;
		const { features, index } = facet as { features?: unknown[]; index?: unknown };
		const slice = plainIndex(index);
		if (!slice) continue;
		const rewritten: unknown[] = [];
		for (const feature of features ?? []) {
			if (!feature || typeof feature !== "object") continue;
			const value = feature as Record<string, unknown>;
			const type = typeof value.$type === "string" ? value.$type : "";
			const betaType = betaFeatureType(type);
			if (!betaType) continue;
			const next: Record<string, unknown> = { ...value, $type: betaType };
			if (type.endsWith("#channel")) {
				const rkey = legacyChannelRkey(community, value.channel as string | undefined);
				const space = rkey ? channelSpaces.get(rkey) : undefined;
				if (!space) continue;
				next.channel = space;
			}
			rewritten.push(next);
		}
		if (rewritten.length === 0) continue;
		out.push({
			$type: BETA_FACET_PREFIX,
			index: slice,
			features: rewritten,
		});
	}
	return out.length > 0 ? out : null;
};

export type LegacyMessageRow = {
	space: string;
	author: string;
	rkey: string;
	community: string;
	text: string;
	facets: unknown[] | null;
	createdAt: string;
	updatedAt: null;
	parentAuthor: string | null;
	parentRkey: string | null;
	attachments: unknown[] | null;
	forward: null;
	suppressedEmbeds: string[] | null;
	bridged: null;
	fromLegacyRepo: true;
	indexedAt: string;
};

export type AuthoredLegacyMessage = {
	author: string;
	record: LegacyRecord<LegacyMessageValue>;
};

export const legacyMessageRows = (
	community: string,
	messages: readonly AuthoredLegacyMessage[],
	channelSpaces: ReadonlyMap<string, string>,
	indexedAt: string,
	spaceAuthority: string = community,
): LegacyMessageRow[] => {
	const placed = messages.flatMap(({ author, record }) => {
		const channel = legacyChannelRkey(community, record.value.channel);
		const space = channel ? channelSpaces.get(channel) : undefined;
		if (!space || typeof record.value.text !== "string" || !record.value.createdAt) return [];
		const rkey = rkeyOf(record.uri);
		if (messageFutureRefusal(indexedAt, rkey, record.value.createdAt)) return [];
		return [{ author, record, space, rkey }];
	});

	const authorsByRkey = new Map<string, string>();
	for (const message of placed) {
		authorsByRkey.set(`${message.space} ${message.rkey}`, message.author);
	}

	return placed.map(({ author, record, space, rkey }) => {
		const parentRkey = record.value.parent ? rkeyOf(record.value.parent) : null;
		const parentAuthor = parentRkey ? (authorsByRkey.get(`${space} ${parentRkey}`) ?? null) : null;
		return {
			space,
			author,
			rkey,
			community: spaceAuthority,
			text: record.value.text as string,
			facets: rewriteLegacyFacets(record.value.facets, community, channelSpaces),
			createdAt: record.value.createdAt as string,
			updatedAt: null,
			parentAuthor: parentAuthor ? parentAuthor : null,
			parentRkey: parentAuthor ? parentRkey : null,
			attachments: record.value.attachments?.length ? record.value.attachments : null,
			forward: null,
			suppressedEmbeds: record.value.suppressedEmbeds?.length
				? record.value.suppressedEmbeds
				: null,
			bridged: null,
			fromLegacyRepo: true,
			indexedAt,
		};
	});
};

export const categoryChannelOrder = (
	categoryRkey: string,
	channelOrder: readonly string[] | undefined,
	channels: readonly LegacyRecord<LegacyChannelValue>[],
): string[] => {
	const known = new Set(channels.map((channel) => rkeyOf(channel.uri)));
	const ordered = (channelOrder ?? []).filter((rkey) => known.has(rkey));
	const listed = new Set(ordered);
	for (const channel of channels) {
		const rkey = rkeyOf(channel.uri);
		if (channel.value.category === categoryRkey && !listed.has(rkey)) {
			ordered.push(rkey);
			listed.add(rkey);
		}
	}
	return ordered;
};

const listAll = async <T>(
	pds: PdsClient,
	repo: string,
	collection: string,
): Promise<LegacyRecord<T>[]> => {
	const out: LegacyRecord<T>[] = [];
	let cursor: string | undefined;
	do {
		const page = await pds.xrpc.query<{
			records: LegacyRecord<T>[];
			cursor?: string;
		}>("com.atproto.repo.listRecords", { repo, collection, limit: 100, cursor });
		out.push(...page.records);
		cursor = page.cursor;
	} while (cursor);
	return out;
};

const rewritePermissions = (permissions: string[]): string[] => [
	...new Set(
		permissions.map((permission) => (permission === "message.hide" ? "label.apply" : permission)),
	),
];

export const migrateCommunity = async (
	deps: MigrateDeps,
	community: string,
): Promise<MigrationReport> => {
	const report: MigrationReport = {
		community,
		spacesCreated: [],
		categories: 0,
		channels: 0,
		roles: 0,
		members: 0,
		bans: 0,
		legacyMessages: 0,
		warnings: [],
	};

	const completed = deps.completed ?? new Set<MigrationStep>();
	const run = async (step: MigrationStep, body: () => Promise<void>): Promise<void> => {
		if (completed.has(step)) return;
		deps.onProgress?.(migrationProgress(community, step));
		await body();
		if (!deps.dryRun) await deps.onStepDone?.(step);
	};

	const target = deps.target ?? community;
	const spaces = communitySpaces(target);
	const host = await deps.credentials.connect(target);
	const repoOf = async (did: string) => deps.credentials.clientFor(await deps.hostFor(did));
	const legacyRepo = await repoOf(community);

	deps.onProgress?.(migrationProgress(community, "readingLegacyRepo"));
	deps.log("reading the legacy repo", { community, pds: legacyRepo.service });
	const [
		legacyCommunity,
		legacyCategories,
		legacyChannels,
		legacyRoles,
		legacyMembers,
		legacyModeration,
	] = await Promise.all([
		legacyRepo
			.getPublicRecord<LegacyRecord<LegacyCommunityValue>>(
				community,
				LEGACY_COLLECTIONS.community,
				SELF,
			)
			.catch(() => null),
		listAll<{ name?: string; channelOrder?: string[] }>(
			legacyRepo,
			community,
			LEGACY_COLLECTIONS.category,
		),
		listAll<LegacyChannelValue>(legacyRepo, community, LEGACY_COLLECTIONS.channel),
		listAll<Record<string, unknown>>(legacyRepo, community, LEGACY_COLLECTIONS.role),
		listAll<LegacyMemberValue>(legacyRepo, community, LEGACY_COLLECTIONS.member),
		listAll<LegacyModerationValue>(legacyRepo, community, LEGACY_COLLECTIONS.moderation),
	]);

	if (!legacyCommunity) {
		throw new Error(`${community} has no ${LEGACY_COLLECTIONS.community} record to migrate`);
	}
	if (!deps.dryRun) await deps.onStepDone?.("readingLegacyRepo");

	const bans = activeBans(legacyModeration);
	const banned = new Set(bans.map((ban) => ban.value.subject?.did as string));
	const members = legacyMembers.filter(
		(member) => member.value.subject && !banned.has(member.value.subject),
	);
	const channelSpaces = new Map(
		legacyChannels.map((channel) => [rkeyOf(channel.uri), channelSpaceFor(target, channel)]),
	);

	if (deps.dryRun) {
		deps.log("dry run, nothing will be written", {
			categories: legacyCategories.length,
			channels: legacyChannels.length,
			roles: legacyRoles.length,
			members: members.length,
			bans: bans.length,
		});
	}

	const createSpace = async (space: string) => {
		const type = space.split("/")[4] as string;
		const skey = rkeyOf(space);
		if (deps.dryRun) return;
		await host.pds
			.createSpace(host.session, {
				spaceType: type,
				skey,
				policy:
					type === SPACE_TYPES.communityProfile
						? memberspacePolicy({ publicRead: true })
						: managedspacePolicy(deps.appviewService),
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("SpaceAlreadyExists")) throw error;
			});
		await deps.spaces.register({ uri: space, community: target, host: host.pds.service });
	};

	const put = async (
		space: string,
		collection: string,
		rkey: string,
		record: Record<string, unknown>,
	) => {
		if (deps.dryRun) return;
		await deps.writer.put(target, { space, collection, rkey, record });
	};

	const legacy = legacyCommunity.value;

	await run("creatingSpaces", async () => {
		deps.log("creating the community's spaces");
		for (const space of [spaces.profile, spaces.configuration, spaces.members, spaces.moderation]) {
			await createSpace(space);
			report.spacesCreated.push(space);
		}
	});

	const carryBlob = async (blob: unknown): Promise<unknown> => {
		if (!blob || target === community || deps.dryRun) return blob;
		const cid = blobCid(blob);
		if (!cid) return undefined;
		try {
			const url = new URL("/xrpc/com.atproto.sync.getBlob", legacyRepo.service);
			url.searchParams.set("did", community);
			url.searchParams.set("cid", cid);
			const response = await fetch(url);
			if (!response.ok) throw new Error(`getBlob failed with ${response.status}`);
			const mimeType =
				response.headers.get("content-type") ??
				((blob as { mimeType?: string }).mimeType || "application/octet-stream");
			const bytes = new Uint8Array(await response.arrayBuffer());
			return await deps.writer.uploadBlob(target, bytes, mimeType);
		} catch (error) {
			report.warnings.push(
				`could not copy image ${cid}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	};

	await run("writingProfile", async () => {
		deps.log("writing the community profile");
		const picture = await carryBlob(legacy.picture);
		const banner = await carryBlob(legacy.banner);
		await put(spaces.profile, COLLECTIONS.community, SELF, {
			$type: COLLECTIONS.community,
			name: legacy.name ?? "Migrated community",
			managingApp: deps.appviewService.split("#")[0],
			...(legacy.description ? { description: legacy.description } : {}),
			...(picture ? { picture } : {}),
			...(banner ? { banner } : {}),
			migratedFrom: legacyCommunityUri(community),
		});
	});

	await run("writingSettings", async () => {
		const categoryOrder = legacy.categoryOrder?.length
			? legacy.categoryOrder
			: legacyCategories.map((category) => rkeyOf(category.uri));
		await put(spaces.configuration, COLLECTIONS.communitySettings, SELF, {
			$type: COLLECTIONS.communitySettings,
			categoryOrder,
			requiresApprovalToJoin: legacy.requiresApprovalToJoin ?? false,
			linkEmbeds: legacy.linkEmbeds ?? true,
		});
	});

	await run("migratingRoles", async () => {
		deps.log("writing roles");
		for (const role of legacyRoles) {
			const value = role.value;
			await put(spaces.members, COLLECTIONS.role, rkeyOf(role.uri), {
				$type: COLLECTIONS.role,
				name: value.name ?? "Role",
				permissions: rewritePermissions((value.permissions as string[]) ?? []),
				position: value.position ?? 0,
				...(value.color ? { color: value.color } : {}),
				...(value.hoisted ? { hoisted: true } : {}),
				...(value.mentionable ? { mentionable: true } : {}),
				...(value.protected ? { protected: true } : {}),
			});
			report.roles += 1;
		}
	});

	await run("migratingMembers", async () => {
		deps.log("writing members");
		for (const member of members) {
			const value = member.value;
			const subject = value.subject as string;
			await put(spaces.members, COLLECTIONS.member, subject, {
				$type: COLLECTIONS.member,
				subject,
				roles: value.roles ?? [],
				joinedAt: value.joinedAt ?? new Date().toISOString(),
				...(value.nickname ? { nickname: value.nickname } : {}),
			});
			report.members += 1;
		}
	});

	await run("migratingBans", async () => {
		deps.log("writing bans");
		for (const ban of bans) {
			const value = ban.value;
			await put(spaces.moderation, COLLECTIONS.moderation, rkeyOf(ban.uri), {
				$type: COLLECTIONS.moderation,
				action: "ban",
				subject: value.subject?.did,
				createdBy: value.createdBy ?? target,
				createdAt: value.createdAt ?? new Date().toISOString(),
				...(value.reason ? { reason: value.reason.slice(0, 512) } : {}),
			});
			report.bans += 1;
		}
	});

	await run("migratingChannels", async () => {
		deps.log("creating channel spaces");
		for (const channel of legacyChannels) {
			const value = channel.value;
			const space = channelSpaces.get(rkeyOf(channel.uri)) as string;
			await createSpace(space);
			await put(space, COLLECTIONS.channel, SELF, {
				$type: COLLECTIONS.channel,
				name: value.name ?? "channel",
				...(value.description ? { description: value.description } : {}),
				...(value.ownerOnly ? { ownerOnly: true } : {}),
				...(value.allowedRoles?.length ? { allowedRoles: value.allowedRoles } : {}),
				...(value.allowedMembers?.length ? { allowedMembers: value.allowedMembers } : {}),
				...(value.linkEmbeds === undefined ? {} : { linkEmbeds: value.linkEmbeds }),
				migratedFrom: channel.uri,
			});
			report.channels += 1;
		}
	});

	await run("migratingCategories", async () => {
		deps.log("writing categories");
		for (const category of legacyCategories) {
			const rkey = rkeyOf(category.uri);
			await put(spaces.configuration, COLLECTIONS.category, rkey, {
				$type: COLLECTIONS.category,
				name: category.value.name ?? "Category",
				channelOrder: categoryChannelOrder(rkey, category.value.channelOrder, legacyChannels),
			});
			report.categories += 1;
		}
	});

	await run("mirroringMessages", async () => {
		deps.log("mirroring legacy message history");
		const authors = [community, ...members.map((member) => member.value.subject as string)].filter(
			(author, index, all) => all.indexOf(author) === index,
		);
		report.legacyMessages = await mirrorLegacyMessages(
			deps,
			community,
			target,
			authors,
			channelSpaces,
			report,
		);
	});

	await run("retiringLegacyCommunity", async () => {
		if (deps.dryRun || target !== community) return;
		deps.log("retiring the legacy community record");
		await host.pds.putRepoRecord(host.session, {
			collection: LEGACY_COLLECTIONS.community,
			rkey: SELF,
			record: {
				...(legacy as Record<string, unknown>),
				$type: LEGACY_COLLECTIONS.community,
				migratedTo: migratedCommunityUri(community),
			},
		});
	});

	deps.onProgress?.(migrationProgress(community, "done"));
	return report;
};

const mirrorLegacyMessages = async (
	deps: MigrateDeps,
	community: string,
	target: string,
	authors: readonly string[],
	channelSpaces: ReadonlyMap<string, string>,
	report: MigrationReport,
): Promise<number> => {
	const collected: AuthoredLegacyMessage[] = [];
	for (const author of authors) {
		const records = await deps
			.hostFor(author)
			.then((host) =>
				listAll<LegacyMessageValue>(
					deps.credentials.clientFor(host),
					author,
					LEGACY_COLLECTIONS.message,
				),
			)
			.catch((error: unknown) => {
				report.warnings.push(
					`could not read ${author}'s legacy messages: ${error instanceof Error ? error.message : String(error)}`,
				);
				return [];
			});
		for (const record of records) {
			if (legacyChannelRkey(community, record.value.channel) === undefined) continue;
			collected.push({ author, record });
		}
	}

	const indexedAt = new Date().toISOString();
	const rows = legacyMessageRows(community, collected, channelSpaces, indexedAt, target);
	if (deps.dryRun) return rows.length;

	const { db, tables } = deps.database;
	const placed = new Set(rows.map((row) => `${row.author} ${row.rkey}`));
	const archive = collected
		.filter(({ author, record }) => placed.has(`${author} ${rkeyOf(record.uri)}`))
		.map(({ author, record }) => ({
			did: author,
			collection: LEGACY_COLLECTIONS.message,
			rkey: rkeyOf(record.uri),
			value: record.value as Record<string, unknown>,
			indexedAt,
		}));

	for (let start = 0; start < archive.length; start += MESSAGE_BATCH) {
		await db
			.insert(tables.legacyRecords)
			.values(archive.slice(start, start + MESSAGE_BATCH))
			.onConflictDoNothing();
	}

	for (let start = 0; start < rows.length; start += MESSAGE_BATCH) {
		await db
			.insert(tables.messages)
			.values(rows.slice(start, start + MESSAGE_BATCH))
			.onConflictDoNothing();
	}

	return rows.length;
};
