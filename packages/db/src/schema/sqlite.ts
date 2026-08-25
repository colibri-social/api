import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => text(name);
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
const flag = (name: string) => integer(name, { mode: "boolean" });

export type SpaceRepoState = "pending" | "active" | "diverged" | "error" | "gone";
export type RoleChannelOverride = { channel: string; allow: string[]; deny: string[] };
export type ModerationAction = "ban" | "unban" | "kick";
export type NotificationKind = "mention" | "reply" | "message";
export type NotificationLevel = "all" | "mentionsAndReplies";
export type OnlineState = "online" | "away" | "dnd" | "offline";
export type ActivityKind = "listening" | "playing" | "streaming";
export type PushProvider = "webpush" | "fcm";
export type PushPlatform = "web" | "ios" | "android";
export type CredentialSource = "provisioned" | "registered";
export type GifFavorite = {
	id: string;
	url: string;
	previewUrl: string;
	width: number;
	height: number;
	title?: string;
};

export const spaces = sqliteTable(
	"spaces",
	{
		uri: text("uri").primaryKey(),
		authority: text("authority").notNull(),
		spaceType: text("space_type").notNull(),
		skey: text("skey").notNull(),
		community: text("community"),
		host: text("host").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [index("spaces_community_idx").on(t.community), index("spaces_type_idx").on(t.spaceType)],
);

export const spaceRepos = sqliteTable(
	"space_repos",
	{
		space: text("space").notNull(),
		author: text("author").notNull(),
		appliedRev: text("applied_rev"),
		setHashBase64: text("set_hash_base64"),
		remoteCommitHash: text("remote_commit_hash"),
		state: text("state").notNull().$type<SpaceRepoState>().default("pending"),
		error: text("error"),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		retryAfter: timestamp("retry_after"),
		syncedAt: timestamp("synced_at"),
	},
	(t) => [
		primaryKey({ columns: [t.space, t.author] }),
		index("space_repos_state_idx").on(t.state, t.retryAfter),
	],
);

export const records = sqliteTable(
	"records",
	{
		space: text("space").notNull(),
		author: text("author").notNull(),
		collection: text("collection").notNull(),
		rkey: text("rkey").notNull(),
		cid: text("cid").notNull(),
		value: json<Record<string, unknown>>("value").notNull(),
		indexedAt: timestamp("indexed_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.space, t.author, t.collection, t.rkey] }),
		index("records_collection_idx").on(t.space, t.collection),
	],
);

export const spaceCredentials = sqliteTable("space_credentials", {
	space: text("space").primaryKey(),
	credential: text("credential").notNull(),
	boundKeyThumbprint: text("bound_key_thumbprint").notNull(),
	boundPrivateJwk: text("bound_private_jwk").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
});

export const notifyRegistrations = sqliteTable("notify_registrations", {
	space: text("space").primaryKey(),
	service: text("service").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
});

export const communities = sqliteTable(
	"communities",
	{
		did: text("did").primaryKey(),
		handle: text("handle"),
		name: text("name").notNull(),
		description: text("description"),
		managingApp: text("managing_app"),
		pictureCid: text("picture_cid"),
		bannerCid: text("banner_cid"),
		requiresApproval: flag("requires_approval").notNull().default(false),
		linkEmbeds: flag("link_embeds").notNull().default(true),
		labelers: json<string[]>("labelers")
			.notNull()
			.$defaultFn(() => []),
		migratedFrom: text("migrated_from"),
		profileSpace: text("profile_space").notNull(),
		configSpace: text("config_space").notNull(),
		membersSpace: text("members_space").notNull(),
		moderationSpace: text("moderation_space").notNull(),
		indexedAt: timestamp("indexed_at").notNull(),
	},
	(t) => [uniqueIndex("communities_handle_idx").on(t.handle)],
);

export const categories = sqliteTable(
	"categories",
	{
		community: text("community").notNull(),
		rkey: text("rkey").notNull(),
		name: text("name").notNull(),
		channelOrder: json<string[]>("channel_order")
			.notNull()
			.$defaultFn(() => []),
		position: integer("position").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.community, t.rkey] })],
);

export const channels = sqliteTable(
	"channels",
	{
		space: text("space").primaryKey(),
		community: text("community").notNull(),
		spaceType: text("space_type").notNull(),
		skey: text("skey").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		category: text("category"),
		position: integer("position").notNull().default(0),
		ownerOnly: flag("owner_only").notNull().default(false),
		allowedRoles: json<string[]>("allowed_roles")
			.notNull()
			.$defaultFn(() => []),
		allowedMembers: json<string[]>("allowed_members")
			.notNull()
			.$defaultFn(() => []),
		visibleToRoles: json<string[]>("visible_to_roles")
			.notNull()
			.$defaultFn(() => []),
		visibleToMembers: json<string[]>("visible_to_members")
			.notNull()
			.$defaultFn(() => []),
		linkEmbeds: flag("link_embeds"),
		migratedFrom: text("migrated_from"),
	},
	(t) => [index("channels_community_idx").on(t.community, t.category)],
);

export const roles = sqliteTable(
	"roles",
	{
		community: text("community").notNull(),
		rkey: text("rkey").notNull(),
		name: text("name").notNull(),
		color: text("color"),
		permissions: json<string[]>("permissions")
			.notNull()
			.$defaultFn(() => []),
		position: integer("position").notNull().default(0),
		hoisted: flag("hoisted").notNull().default(false),
		mentionable: flag("mentionable").notNull().default(false),
		protected: flag("protected").notNull().default(false),
		channelOverrides: json<RoleChannelOverride[]>("channel_overrides")
			.notNull()
			.$defaultFn(() => []),
	},
	(t) => [
		primaryKey({ columns: [t.community, t.rkey] }),
		index("roles_position_idx").on(t.community, t.position),
	],
);

export const members = sqliteTable(
	"members",
	{
		community: text("community").notNull(),
		did: text("did").notNull(),
		roles: json<string[]>("roles")
			.notNull()
			.$defaultFn(() => []),
		joinedAt: timestamp("joined_at").notNull(),
		nickname: text("nickname"),
	},
	(t) => [primaryKey({ columns: [t.community, t.did] }), index("members_did_idx").on(t.did)],
);

export const messages = sqliteTable(
	"messages",
	{
		space: text("space").notNull(),
		author: text("author").notNull(),
		rkey: text("rkey").notNull(),
		community: text("community").notNull(),
		text: text("text").notNull(),
		facets: json<unknown[]>("facets"),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at"),
		parentAuthor: text("parent_author"),
		parentRkey: text("parent_rkey"),
		attachments: json<unknown[]>("attachments"),
		suppressedEmbeds: json<string[]>("suppressed_embeds"),
		fromLegacyRepo: flag("from_legacy_repo").notNull().default(false),
		indexedAt: timestamp("indexed_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.space, t.author, t.rkey] }),
		index("messages_channel_page_idx").on(t.space, t.rkey),
		index("messages_parent_idx").on(t.space, t.parentAuthor, t.parentRkey),
		index("messages_author_idx").on(t.author),
	],
);

export const reactions = sqliteTable(
	"reactions",
	{
		space: text("space").notNull(),
		author: text("author").notNull(),
		rkey: text("rkey").notNull(),
		targetAuthor: text("target_author").notNull(),
		targetRkey: text("target_rkey").notNull(),
		emoji: text("emoji").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.space, t.author, t.rkey] }),
		index("reactions_target_idx").on(t.space, t.targetAuthor, t.targetRkey),
		uniqueIndex("reactions_one_per_author_and_emoji_idx").on(
			t.space,
			t.targetAuthor,
			t.targetRkey,
			t.author,
			t.emoji,
		),
	],
);

export const labels = sqliteTable(
	"labels",
	{
		space: text("space").notNull(),
		src: text("src").notNull(),
		rkey: text("rkey").notNull(),
		subjectDid: text("subject_did").notNull(),
		subjectCollection: text("subject_collection").notNull(),
		subjectRkey: text("subject_rkey").notNull(),
		val: text("val").notNull(),
		scope: json<string[]>("scope"),
		negated: flag("negated").notNull().default(false),
		reason: text("reason"),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.space, t.src, t.rkey] }),
		index("labels_subject_idx").on(t.space, t.subjectDid, t.subjectRkey),
	],
);

export const moderationLog = sqliteTable(
	"moderation_log",
	{
		community: text("community").notNull(),
		rkey: text("rkey").notNull(),
		action: text("action").notNull().$type<ModerationAction>(),
		subject: text("subject").notNull(),
		reason: text("reason"),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.community, t.rkey] }),
		index("moderation_subject_idx").on(t.community, t.subject, t.createdAt),
	],
);

export const mutes = sqliteTable(
	"mutes",
	{
		did: text("did").notNull(),
		rkey: text("rkey").notNull(),
		subject: text("subject").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.did, t.rkey] }),
		uniqueIndex("mutes_one_per_subject_idx").on(t.did, t.subject),
	],
);

export const actorSettings = sqliteTable("actor_settings", {
	did: text("did").primaryKey(),
	notificationLevel: text("notification_level").notNull().$type<NotificationLevel>().default("all"),
	communityOrder: json<string[]>("community_order")
		.notNull()
		.$defaultFn(() => []),
	gifFavorites: json<GifFavorite[]>("gif_favorites")
		.notNull()
		.$defaultFn(() => []),
	shareActivity: flag("share_activity").notNull().default(false),
});

export const readCursors = sqliteTable(
	"read_cursors",
	{
		did: text("did").notNull(),
		community: text("community").notNull(),
		channel: text("channel").notNull(),
		cursor: text("cursor").notNull(),
	},
	(t) => [primaryKey({ columns: [t.did, t.channel] }), index("read_cursors_did_idx").on(t.did)],
);

export const communityCredentials = sqliteTable("community_credentials", {
	community: text("community").primaryKey(),
	pdsEndpoint: text("pds_endpoint").notNull(),
	identifier: text("identifier").notNull(),
	passwordCiphertextBase64: text("password_ciphertext_base64").notNull(),
	passwordNonceBase64: text("password_nonce_base64").notNull(),
	source: text("source").notNull().$type<CredentialSource>(),
	createdAt: timestamp("created_at").notNull(),
});

export const notifications = sqliteTable(
	"notifications",
	{
		id: text("id").primaryKey(),
		recipient: text("recipient").notNull(),
		kind: text("kind").notNull().$type<NotificationKind>(),
		community: text("community").notNull(),
		space: text("space").notNull(),
		author: text("author").notNull(),
		messageAuthor: text("message_author").notNull(),
		messageRkey: text("message_rkey").notNull(),
		mentionRole: text("mention_role"),
		indexedAt: timestamp("indexed_at").notNull(),
		seenAt: timestamp("seen_at"),
	},
	(t) => [
		index("notifications_recipient_idx").on(t.recipient, t.indexedAt),
		index("notifications_unseen_idx").on(t.recipient, t.seenAt),
		index("notifications_message_idx").on(t.messageAuthor, t.messageRkey),
	],
);

export const pushSubscriptions = sqliteTable(
	"push_subscriptions",
	{
		id: text("id").primaryKey(),
		actor: text("actor").notNull(),
		provider: text("provider").notNull().$type<PushProvider>(),
		platform: text("platform").notNull().$type<PushPlatform>(),
		endpoint: text("endpoint"),
		p256dh: text("p256dh"),
		auth: text("auth"),
		token: text("token"),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		index("push_actor_idx").on(t.actor),
		uniqueIndex("push_endpoint_idx").on(t.provider, t.endpoint),
		uniqueIndex("push_token_idx").on(t.provider, t.token),
	],
);

export const invitations = sqliteTable(
	"invitations",
	{
		code: text("code").primaryKey(),
		community: text("community").notNull(),
		createdBy: text("created_by").notNull(),
		active: flag("active").notNull().default(true),
		uses: integer("uses").notNull().default(0),
		maxUses: integer("max_uses"),
		createdAt: timestamp("created_at").notNull(),
		expiresAt: timestamp("expires_at"),
	},
	(t) => [index("invitations_community_idx").on(t.community)],
);

export const applications = sqliteTable(
	"applications",
	{
		community: text("community").notNull(),
		did: text("did").notNull(),
		createdAt: timestamp("created_at").notNull(),
		dismissedAt: timestamp("dismissed_at"),
	},
	(t) => [
		primaryKey({ columns: [t.community, t.did] }),
		index("applications_pending_idx").on(t.community, t.dismissedAt),
	],
);

export const userPresence = sqliteTable("user_presence", {
	did: text("did").primaryKey(),
	derivedState: text("derived_state").notNull().$type<OnlineState>().default("offline"),
	requestedState: text("requested_state").$type<OnlineState>(),
	statusText: text("status_text"),
	statusEmoji: text("status_emoji"),
	voiceChannel: text("voice_channel"),
	voiceMuted: flag("voice_muted"),
	voiceDeafened: flag("voice_deafened"),
	viewingChannel: text("viewing_channel"),
	updatedAt: timestamp("updated_at").notNull(),
});

export const actorActivity = sqliteTable(
	"actor_activity",
	{
		did: text("did").primaryKey(),
		kind: text("kind").notNull().$type<ActivityKind>(),
		title: text("title").notNull(),
		subtitle: text("subtitle"),
		detail: text("detail"),
		imageUrl: text("image_url"),
		linkUri: text("link_uri"),
		startedAt: timestamp("started_at"),
		endsAt: timestamp("ends_at"),
		source: text("source").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(t) => [index("actor_activity_ends_at_idx").on(t.endsAt)],
);

export const identityCache = sqliteTable(
	"identity_cache",
	{
		did: text("did").primaryKey(),
		handle: text("handle"),
		pds: text("pds"),
		signingKey: text("signing_key"),
		fetchedAt: timestamp("fetched_at").notNull(),
	},
	(t) => [index("identity_handle_idx").on(t.handle)],
);

export const profileCache = sqliteTable("profile_cache", {
	did: text("did").primaryKey(),
	colibri: json<Record<string, unknown>>("colibri"),
	bsky: json<Record<string, unknown>>("bsky"),
	fetchedAt: timestamp("fetched_at").notNull(),
});

export const serviceState = sqliteTable("service_state", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
});

export const legacyRecords = sqliteTable(
	"legacy_records",
	{
		did: text("did").notNull(),
		collection: text("collection").notNull(),
		rkey: text("rkey").notNull(),
		value: json<Record<string, unknown>>("value").notNull(),
		indexedAt: timestamp("indexed_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.did, t.collection, t.rkey] }),
		index("legacy_collection_idx").on(t.collection),
	],
);

export const schema = {
	spaces,
	spaceRepos,
	records,
	spaceCredentials,
	notifyRegistrations,
	communities,
	categories,
	channels,
	roles,
	members,
	messages,
	reactions,
	labels,
	moderationLog,
	mutes,
	actorSettings,
	readCursors,
	communityCredentials,
	notifications,
	pushSubscriptions,
	invitations,
	applications,
	userPresence,
	actorActivity,
	identityCache,
	profileCache,
	serviceState,
	legacyRecords,
};

export type Schema = typeof schema;
