import type { NotificationKind, Schema } from "@colibri-social/appview-db";
import { and, eq, inArray } from "drizzle-orm";
import type { NotificationDeps } from "./deps.js";
import { nextId } from "./id.js";

export type IndexMessageInput = {
	space: string;
	community: string;
	author: string;
	rkey: string;
	facets: unknown[] | null;
	parentAuthor: string | null;
	parentRkey: string | null;
};

export type IndexedNotificationRow = Schema["notifications"]["$inferSelect"];

const FACET_MENTION_TYPE = "social.colibri.beta.richtext.facet#mention";
const FACET_ROLE_TYPE = "social.colibri.beta.richtext.facet#role";
const MENTION_ROLES_PERMISSION = "mention.roles";

type FacetFeature = { $type?: unknown; did?: unknown; role?: unknown };
type Facet = { features?: FacetFeature[] };

const featuresOf = (raw: unknown): FacetFeature[] => {
	const facet = raw as Facet;
	return Array.isArray(facet?.features) ? facet.features : [];
};

const extractMentionedDids = (facets: readonly unknown[]): string[] => {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const facet of facets) {
		for (const feature of featuresOf(facet)) {
			if (feature.$type !== FACET_MENTION_TYPE || typeof feature.did !== "string") continue;
			if (seen.has(feature.did)) continue;
			seen.add(feature.did);
			out.push(feature.did);
		}
	}
	return out;
};

const extractMentionedRoles = (facets: readonly unknown[]): string[] => {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const facet of facets) {
		for (const feature of featuresOf(facet)) {
			if (feature.$type !== FACET_ROLE_TYPE || typeof feature.role !== "string") continue;
			if (seen.has(feature.role)) continue;
			seen.add(feature.role);
			out.push(feature.role);
		}
	}
	return out;
};

type Recipient = { did: string; kind: NotificationKind; mentionRole: string | null };

const loadMemberPermissions = async (
	deps: NotificationDeps,
	community: string,
	actor: string,
): Promise<Set<string>> => {
	const [memberRow] = await deps.db
		.select({ roles: deps.tables.members.roles })
		.from(deps.tables.members)
		.where(and(eq(deps.tables.members.community, community), eq(deps.tables.members.did, actor)))
		.limit(1);
	if (!memberRow || memberRow.roles.length === 0) return new Set();

	const roleRows = await deps.db
		.select({ permissions: deps.tables.roles.permissions })
		.from(deps.tables.roles)
		.where(
			and(
				eq(deps.tables.roles.community, community),
				inArray(deps.tables.roles.rkey, memberRow.roles),
			),
		);
	const permissions = new Set<string>();
	for (const role of roleRows)
		for (const permission of role.permissions) permissions.add(permission);
	return permissions;
};

const expandRoleMentions = async (
	deps: NotificationDeps,
	message: IndexMessageInput,
	roleKeys: readonly string[],
): Promise<Array<{ did: string; roleName: string }>> => {
	const roleRows = await deps.db
		.select()
		.from(deps.tables.roles)
		.where(
			and(
				eq(deps.tables.roles.community, message.community),
				inArray(deps.tables.roles.rkey, roleKeys),
			),
		);
	if (roleRows.length === 0) return [];
	const rolesByKey = new Map(roleRows.map((role) => [role.rkey, role]));

	let authorPermissions: Set<string> | null = null;
	const authorCanMentionAnyRole = async (): Promise<boolean> => {
		if (message.author === message.community) return true;
		authorPermissions ??= await loadMemberPermissions(deps, message.community, message.author);
		return authorPermissions.has(MENTION_ROLES_PERMISSION);
	};

	const authorizedRoles: Array<{ rkey: string; name: string }> = [];
	for (const roleKey of roleKeys) {
		const role = rolesByKey.get(roleKey);
		if (!role) continue;
		if (!role.mentionable && !(await authorCanMentionAnyRole())) continue;
		authorizedRoles.push({ rkey: role.rkey, name: role.name });
	}
	if (authorizedRoles.length === 0) return [];

	const memberRows = await deps.db
		.select()
		.from(deps.tables.members)
		.where(eq(deps.tables.members.community, message.community));

	const out: Array<{ did: string; roleName: string }> = [];
	const seen = new Set<string>();
	for (const member of memberRows) {
		if (member.did === message.author || seen.has(member.did)) continue;
		const matched = authorizedRoles.find((role) => member.roles.includes(role.rkey));
		if (!matched) continue;
		seen.add(member.did);
		out.push({ did: member.did, roleName: matched.name });
	}
	return out;
};

const allMemberDids = async (deps: NotificationDeps, community: string): Promise<string[]> => {
	const rows = await deps.db
		.select({ did: deps.tables.members.did })
		.from(deps.tables.members)
		.where(eq(deps.tables.members.community, community));
	return rows.map((row) => row.did);
};

const filterRecipients = async (
	deps: NotificationDeps,
	message: IndexMessageInput,
	recipients: readonly Recipient[],
): Promise<Recipient[]> => {
	if (recipients.length === 0) return [];
	const dids = recipients.map((recipient) => recipient.did);

	const memberRows = await deps.db
		.select({ did: deps.tables.members.did })
		.from(deps.tables.members)
		.where(
			and(
				eq(deps.tables.members.community, message.community),
				inArray(deps.tables.members.did, dids),
			),
		);
	const memberDids = new Set(memberRows.map((row) => row.did));

	const muteRows = await deps.db
		.select({ did: deps.tables.mutes.did })
		.from(deps.tables.mutes)
		.where(
			and(
				inArray(deps.tables.mutes.did, dids),
				inArray(deps.tables.mutes.subject, [message.author, message.community, message.space]),
			),
		);
	const mutedDids = new Set(muteRows.map((row) => row.did));

	const settingsRows = await deps.db
		.select({ did: deps.tables.actorSettings.did })
		.from(deps.tables.actorSettings)
		.where(
			and(
				inArray(deps.tables.actorSettings.did, dids),
				eq(deps.tables.actorSettings.notificationLevel, "mentionsAndReplies"),
			),
		);
	const mentionsAndRepliesOnly = new Set(settingsRows.map((row) => row.did));

	const viewingRows = await deps.db
		.select({ did: deps.tables.userPresence.did })
		.from(deps.tables.userPresence)
		.where(
			and(
				inArray(deps.tables.userPresence.did, dids),
				eq(deps.tables.userPresence.viewingChannel, message.space),
			),
		);
	const watching = new Set(viewingRows.map((row) => row.did));

	const alreadyNotifiedRows = await deps.db
		.select({ recipient: deps.tables.notifications.recipient })
		.from(deps.tables.notifications)
		.where(
			and(
				eq(deps.tables.notifications.space, message.space),
				eq(deps.tables.notifications.messageAuthor, message.author),
				eq(deps.tables.notifications.messageRkey, message.rkey),
			),
		);
	const alreadyNotified = new Set(alreadyNotifiedRows.map((row) => row.recipient));

	return recipients.filter((recipient) => {
		if (!memberDids.has(recipient.did)) return false;
		if (mutedDids.has(recipient.did)) return false;
		if (recipient.kind === "message" && mentionsAndRepliesOnly.has(recipient.did)) return false;
		if (watching.has(recipient.did)) return false;
		if (alreadyNotified.has(recipient.did)) return false;
		return true;
	});
};

export const indexMessage = async (
	deps: NotificationDeps,
	message: IndexMessageInput,
): Promise<IndexedNotificationRow[]> => {
	const recipients = new Map<string, Recipient>();
	const facets = message.facets ?? [];

	for (const did of extractMentionedDids(facets)) {
		if (did === message.author || recipients.has(did)) continue;
		recipients.set(did, { did, kind: "mention", mentionRole: null });
	}

	const roleKeys = extractMentionedRoles(facets);
	if (roleKeys.length > 0) {
		for (const { did, roleName } of await expandRoleMentions(deps, message, roleKeys)) {
			if (recipients.has(did)) continue;
			recipients.set(did, { did, kind: "mention", mentionRole: roleName });
		}
	}

	if (
		message.parentAuthor &&
		message.parentAuthor !== message.author &&
		!recipients.has(message.parentAuthor)
	) {
		recipients.set(message.parentAuthor, {
			did: message.parentAuthor,
			kind: "reply",
			mentionRole: null,
		});
	}

	for (const did of await allMemberDids(deps, message.community)) {
		if (did === message.author || recipients.has(did)) continue;
		recipients.set(did, { did, kind: "message", mentionRole: null });
	}

	if (recipients.size === 0) return [];

	const filtered = await filterRecipients(deps, message, [...recipients.values()]);
	if (filtered.length === 0) return [];

	const now = deps.now();
	const rows: IndexedNotificationRow[] = filtered.map((recipient) => ({
		id: nextId(),
		recipient: recipient.did,
		kind: recipient.kind,
		community: message.community,
		space: message.space,
		author: message.author,
		messageAuthor: message.author,
		messageRkey: message.rkey,
		mentionRole: recipient.mentionRole,
		indexedAt: now,
		seenAt: null,
	}));

	await deps.db.insert(deps.tables.notifications).values(rows);
	return rows;
};
