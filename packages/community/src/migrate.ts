import type { Database } from "@colibri-social/appview-db";
import {
	COLLECTIONS,
	communitySpaces,
	LEGACY_CHANNEL_TYPES,
	LEGACY_COLLECTIONS,
	SELF,
	SPACE_TYPES,
	spaceUri,
} from "@colibri-social/lexicons";
import {
	managingAppPolicy,
	nextTid,
	openAppAccess,
	type PdsClient,
	publicPolicy,
} from "@colibri-social/space";
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
	legacyMessages: number;
	warnings: string[];
};

export type MigrateDeps = {
	database: Database;
	hostFor: (did: string) => Promise<string>;
	credentials: CommunityCredentials;
	writer: CommunityWriter;
	spaces: SpaceRegistry;
	appviewService: string;
	log: (message: string, detail?: Record<string, unknown>) => void;
	dryRun?: boolean;
};

const legacyUri = (did: string, collection: string, rkey: string) =>
	`at://${did}/${collection}/${rkey}`;

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

const rkeyOf = (uri: string) => uri.split("/").pop() as string;

const repoFor = async (deps: MigrateDeps, did: string): Promise<PdsClient> =>
	deps.credentials.clientFor(await deps.hostFor(did));

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
		legacyMessages: 0,
		warnings: [],
	};

	const spaces = communitySpaces(community);
	const host = await deps.credentials.connect(community);
	const session = host.session;
	const repoOf = async (did: string) => deps.credentials.clientFor(await deps.hostFor(did));
	const legacyRepo = await repoOf(community);

	deps.log("reading the legacy repo", { community, pds: legacyRepo.service });
	const [legacyCommunity, legacyCategories, legacyChannels, legacyRoles, legacyMembers] =
		await Promise.all([
			legacyRepo
				.getPublicRecord<LegacyRecord>(community, LEGACY_COLLECTIONS.community, SELF)
				.catch(() => null),
			listAll<Record<string, unknown>>(legacyRepo, community, LEGACY_COLLECTIONS.category),
			listAll<Record<string, unknown>>(legacyRepo, community, LEGACY_COLLECTIONS.channel),
			listAll<Record<string, unknown>>(legacyRepo, community, LEGACY_COLLECTIONS.role),
			listAll<Record<string, unknown>>(legacyRepo, community, LEGACY_COLLECTIONS.member),
		]);

	if (!legacyCommunity) {
		throw new Error(`${community} has no ${LEGACY_COLLECTIONS.community} record to migrate`);
	}

	if (deps.dryRun) {
		deps.log("dry run, nothing will be written", {
			categories: legacyCategories.length,
			channels: legacyChannels.length,
			roles: legacyRoles.length,
			members: legacyMembers.length,
		});
	}

	const isPrivate = false;
	const createSpace = async (type: string, skey: string) => {
		if (deps.dryRun) return;
		await host.pds
			.createSpace(session, {
				type,
				skey,
				policy:
					type === SPACE_TYPES.communityProfile && !isPrivate
						? publicPolicy()
						: managingAppPolicy(deps.appviewService),
				appAccess: openAppAccess(),
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("SpaceAlreadyExists")) throw error;
			});
		await deps.spaces.register({
			uri: spaceUri(community, type, skey),
			community,
			host: host.pds.service,
		});
	};

	deps.log("creating the community's spaces");
	for (const type of [
		SPACE_TYPES.communityProfile,
		SPACE_TYPES.communityConfiguration,
		SPACE_TYPES.communityMembers,
		SPACE_TYPES.communityModeration,
	]) {
		await createSpace(type, SELF);
		report.spacesCreated.push(type);
	}

	const legacy = legacyCommunity.value as {
		name?: string;
		description?: string;
		picture?: unknown;
		banner?: unknown;
		categoryOrder?: string[];
		requiresApprovalToJoin?: boolean;
		linkEmbeds?: boolean;
	};

	const put = async (
		space: string,
		collection: string,
		rkey: string,
		record: Record<string, unknown>,
	) => {
		if (deps.dryRun) return;
		await deps.writer.put(community, { space, collection, rkey, record });
	};

	deps.log("writing the community profile");
	await put(spaces.profile, COLLECTIONS.community, SELF, {
		$type: COLLECTIONS.community,
		name: legacy.name ?? "Migrated community",
		managingApp: deps.appviewService.split("#")[0],
		...(legacy.description ? { description: legacy.description } : {}),
		...(legacy.picture ? { picture: legacy.picture } : {}),
		...(legacy.banner ? { banner: legacy.banner } : {}),
		migratedFrom: legacyUri(community, LEGACY_COLLECTIONS.community, SELF),
	});

	deps.log("writing roles");
	for (const role of legacyRoles) {
		const value = role.value as Record<string, unknown>;
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

	deps.log("writing members");
	for (const member of legacyMembers) {
		const value = member.value as {
			subject?: string;
			roles?: string[];
			joinedAt?: string;
			nickname?: string;
		};
		if (!value.subject) {
			report.warnings.push(`skipped a member record with no subject: ${member.uri}`);
			continue;
		}
		await put(spaces.members, COLLECTIONS.member, value.subject, {
			$type: COLLECTIONS.member,
			subject: value.subject,
			roles: value.roles ?? [],
			joinedAt: value.joinedAt ?? new Date().toISOString(),
			...(value.nickname ? { nickname: value.nickname } : {}),
		});
		report.members += 1;
	}

	deps.log("creating channel spaces");
	const channelSpaceByLegacyRkey = new Map<string, string>();
	for (const channel of legacyChannels) {
		const value = channel.value as {
			name?: string;
			description?: string;
			type?: string;
			ownerOnly?: boolean;
			allowedRoles?: string[];
			allowedMembers?: string[];
			linkEmbeds?: boolean;
		};
		const spaceType =
			value.type === LEGACY_CHANNEL_TYPES.voice
				? SPACE_TYPES.channelVoice
				: SPACE_TYPES.channelText;
		if (value.type === LEGACY_CHANNEL_TYPES.forum || value.type === LEGACY_CHANNEL_TYPES.link) {
			report.warnings.push(
				`migrated ${channel.uri} as a text channel: ${value.type} has no space type`,
			);
		}
		const skey = nextTid();
		const space = `at://${community}/space/${spaceType}/${skey}`;

		await createSpace(spaceType, skey);
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

		channelSpaceByLegacyRkey.set(rkeyOf(channel.uri), space);
		report.channels += 1;
	}

	deps.log("writing categories");
	const categoryOrder: string[] = [];
	for (const category of legacyCategories) {
		const value = category.value as { name?: string; channelOrder?: string[] };
		const rkey = rkeyOf(category.uri);
		await put(spaces.configuration, COLLECTIONS.category, rkey, {
			$type: COLLECTIONS.category,
			name: value.name ?? "Category",
			channelOrder: (value.channelOrder ?? [])
				.map((legacyRkey) => channelSpaceByLegacyRkey.get(legacyRkey))
				.filter((space): space is string => space !== undefined)
				.map((space) => space.split("/").pop() as string),
		});
		categoryOrder.push(rkey);
		report.categories += 1;
	}

	await put(spaces.configuration, COLLECTIONS.communitySettings, SELF, {
		$type: COLLECTIONS.communitySettings,
		categoryOrder: legacy.categoryOrder?.length ? legacy.categoryOrder : categoryOrder,
		requiresApprovalToJoin: legacy.requiresApprovalToJoin ?? false,
		linkEmbeds: legacy.linkEmbeds ?? true,
	});

	deps.log("mirroring legacy message history");
	report.legacyMessages = await mirrorLegacyMessages(deps, community, legacyMembers, report);

	return report;
};

const mirrorLegacyMessages = async (
	deps: MigrateDeps,
	community: string,
	members: LegacyRecord[],
	report: MigrationReport,
): Promise<number> => {
	let mirrored = 0;
	const authors = new Set<string>([community]);
	for (const member of members) {
		const subject = (member.value as { subject?: string }).subject;
		if (subject) authors.add(subject);
	}

	for (const author of authors) {
		const records = await repoFor(deps, author)
			.then((repo) => listAll<Record<string, unknown>>(repo, author, LEGACY_COLLECTIONS.message))
			.catch((error: unknown) => {
				report.warnings.push(
					`could not read ${author}'s legacy messages: ${error instanceof Error ? error.message : String(error)}`,
				);
				return [];
			});

		for (const record of records) {
			if (deps.dryRun) {
				mirrored += 1;
				continue;
			}
			const row = {
				did: author,
				collection: LEGACY_COLLECTIONS.message,
				rkey: rkeyOf(record.uri),
				value: record.value,
				indexedAt: new Date().toISOString(),
			};
			await deps.database.db
				.insert(deps.database.tables.legacyRecords)
				.values(row)
				.onConflictDoUpdate({
					target: [
						deps.database.tables.legacyRecords.did,
						deps.database.tables.legacyRecords.collection,
						deps.database.tables.legacyRecords.rkey,
					],
					set: row,
				});
			mirrored += 1;
		}
	}

	return mirrored;
};

const rewritePermissions = (permissions: string[]): string[] => [
	...new Set(
		permissions.map((permission) => (permission === "message.hide" ? "label.apply" : permission)),
	),
];
