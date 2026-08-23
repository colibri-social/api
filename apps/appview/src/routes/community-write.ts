import { AtUri } from "@atproto/syntax";
import { InvalidRequestError } from "@atproto/xrpc-server";
import {
	CommunityCredentialError,
	type CommunityProvisioner,
	generatePassword,
	has,
	isAdmin,
	Membership,
	MembershipError,
	migrateCommunity,
} from "@colibri-social/community";
import { SERVICE_FRAGMENTS, serviceId } from "@colibri-social/identity";
import {
	asDatetime,
	asDid,
	asRecordKey,
	COLLECTIONS,
	communitySpaces,
	PERMISSIONS,
	type Permission,
	SELF,
	social,
} from "@colibri-social/lexicons";
import { PdsClient, XrpcError } from "@colibri-social/space";
import { and, asc, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import type { CommunityView } from "../views/community.js";
import { CommunityViews } from "../views/community.js";
import { countMembers } from "./community.js";
import { credentialsUnavailable, membershipErrorToXrpc } from "./failures.js";
import { writeCommunitySettings } from "./settings.js";
import type { RouteDeps } from "./types.js";

type InvitationView = social.colibri.community.defs.InvitationView;
type MemberView = social.colibri.community.defs.MemberView;

const communityNotFound = () =>
	new InvalidRequestError("no community exists at that identifier", "CommunityNotFound");

const forbidden = (permission: Permission) =>
	new InvalidRequestError(`the requesting user lacks the ${permission} permission`, "Forbidden");

const requireCommunity = async (ctx: AppContext, community: string) => {
	const row = await ctx.loader.community(community);
	if (!row) throw communityNotFound();
	return row;
};

const invitationView = (row: {
	code: string;
	createdBy: string;
	active: boolean;
	createdAt: string;
	expiresAt: string | null;
	uses: number;
	maxUses: number | null;
}): InvitationView => ({
	code: row.code,
	createdBy: asDid(row.createdBy),
	active: row.active,
	createdAt: asDatetime(row.createdAt),
	expiresAt: row.expiresAt ? asDatetime(row.expiresAt) : undefined,
	uses: row.uses,
	maxUses: row.maxUses ?? undefined,
});

export const handleCreateCommunity = async (
	ctx: AppContext,
	communities: CommunityViews,
	callerDid: string,
	input: { name: string; description?: string; handlePrefix?: string },
): Promise<{ community: CommunityView }> => {
	if (!ctx.provisioner) {
		throw new InvalidRequestError(
			"no PDS admin password is configured, so communities cannot be provisioned",
			"PdsUnavailable",
		);
	}

	let provisioned: Awaited<ReturnType<CommunityProvisioner["create"]>>;
	try {
		provisioned = await ctx.provisioner.create({
			name: input.name,
			description: input.description,
			handlePrefix: input.handlePrefix,
			creator: callerDid,
		});
	} catch (error) {
		if (error instanceof XrpcError) {
			if (/exists|available|taken/i.test(error.code)) {
				throw new InvalidRequestError(error.message, "AlreadyExists");
			}
			throw new InvalidRequestError(error.message, "UpstreamFailure");
		}
		throw error;
	}

	const now = new Date().toISOString();
	const row = {
		did: provisioned.did,
		handle: provisioned.handle,
		name: input.name,
		description: input.description ?? null,
		pictureCid: null,
		bannerCid: null,
		requiresApproval: false,
		linkEmbeds: true,
		labelers: [] as string[],
		migratedFrom: null,
		profileSpace: provisioned.spaces.profile,
		configSpace: provisioned.spaces.configuration,
		membersSpace: provisioned.spaces.members,
		moderationSpace: provisioned.spaces.moderation,
		indexedAt: now,
	};
	const authz = {
		actor: callerDid,
		community: provisioned.did,
		isOwner: false,
		isBanned: false,
		member: { did: callerDid, roles: [provisioned.ownerRole], joinedAt: now, nickname: null },
		roles: [
			{
				rkey: provisioned.ownerRole,
				name: "Owner",
				permissions: [...PERMISSIONS],
				position: 1000,
				hoisted: true,
				mentionable: false,
				protected: true,
				channelOverrides: [],
			},
		],
	};

	return { community: communities.community(row, authz, 1) };
};

export const handleUpdateCommunity = async (
	ctx: AppContext,
	communities: CommunityViews,
	callerDid: string,
	input: {
		community: string;
		name?: string;
		description?: string;
		requiresApprovalToJoin?: boolean;
		linkEmbeds?: boolean;
		labelers?: string[];
	},
): Promise<{ community: CommunityView }> => {
	const row = await requireCommunity(ctx, input.community);
	const authz = await ctx.loader.authz(input.community, callerDid);
	if (!has(authz, "community.manage")) throw forbidden("community.manage");

	const nextName = input.name ?? row.name;
	const nextDescription = input.description ?? row.description ?? undefined;
	const nextRequiresApproval = input.requiresApprovalToJoin ?? row.requiresApproval;
	const nextLinkEmbeds = input.linkEmbeds ?? row.linkEmbeds;
	const nextLabelers = input.labelers ?? row.labelers;

	const spaces = communitySpaces(input.community);
	const categories = await ctx.database.db
		.select({ rkey: ctx.database.tables.categories.rkey })
		.from(ctx.database.tables.categories)
		.where(eq(ctx.database.tables.categories.community, input.community))
		.orderBy(asc(ctx.database.tables.categories.position));

	try {
		await ctx.writer.put(input.community, {
			space: spaces.profile,
			collection: COLLECTIONS.community,
			rkey: SELF,
			record: {
				$type: COLLECTIONS.community,
				name: nextName,
				...(nextDescription ? { description: nextDescription } : {}),
				...(row.migratedFrom ? { migratedFrom: row.migratedFrom } : {}),
			},
		});
		await writeCommunitySettings(ctx, ctx.writer, input.community, {
			categoryOrder: categories.map((category) => category.rkey),
			requiresApprovalToJoin: nextRequiresApproval,
			linkEmbeds: nextLinkEmbeds,
			labelers: nextLabelers,
		});
	} catch (error) {
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}

	const mergedRow = {
		...row,
		name: nextName,
		description: nextDescription ?? null,
		requiresApproval: nextRequiresApproval,
		linkEmbeds: nextLinkEmbeds,
		labelers: nextLabelers,
	};
	const total = await countMembers(ctx, input.community);
	return { community: communities.community(mergedRow, authz, total) };
};

export const handleDeleteCommunity = async (
	ctx: AppContext,
	callerDid: string,
	community: string,
): Promise<void> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "community.delete")) throw forbidden("community.delete");

	if (!ctx.provisioner) {
		throw new InvalidRequestError(
			"no PDS admin password is configured, so this community cannot be deleted",
			"CredentialsUnavailable",
		);
	}

	try {
		const session = await ctx.credentials.session(community);
		await ctx.provisioner.destroy(community, session, communitySpaces(community));
	} catch (error) {
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}
};

export const handleJoinCommunity = async (
	actors: ActorViews,
	membership: Membership,
	callerDid: string,
	community: string,
	invitation?: string,
): Promise<{ status: "joined" | "pending"; member?: MemberView }> => {
	try {
		const outcome = await membership.join(community, callerDid, invitation);
		if (outcome.status === "pending") return { status: "pending" };

		const member: MemberView = {
			actor: await actors.one(callerDid),
			roles: [],
			joinedAt: asDatetime(new Date().toISOString()),
			nickname: undefined,
		};
		return { status: "joined", member };
	} catch (error) {
		if (error instanceof MembershipError) throw membershipErrorToXrpc(error);
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}
};

export const handleLeaveCommunity = async (
	ctx: AppContext,
	membership: Membership,
	callerDid: string,
	community: string,
): Promise<void> => {
	await requireCommunity(ctx, community);
	try {
		await membership.leave(community, callerDid);
	} catch (error) {
		if (error instanceof MembershipError) throw membershipErrorToXrpc(error);
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}
};

export const handleSetMemberRoles = async (
	ctx: AppContext,
	actors: ActorViews,
	membership: Membership,
	callerDid: string,
	input: { community: string; subject: string; roles: string[] },
): Promise<{ member: MemberView }> => {
	await requireCommunity(ctx, input.community);
	const authz = await ctx.loader.authz(input.community, callerDid);
	if (!has(authz, "role.manage")) throw forbidden("role.manage");

	const targetBefore = await ctx.loader.authz(input.community, input.subject);
	try {
		await membership.setRoles(input.community, callerDid, input.subject, input.roles);
	} catch (error) {
		if (error instanceof MembershipError) throw membershipErrorToXrpc(error);
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}

	const member: MemberView = {
		actor: await actors.one(input.subject),
		roles: input.roles.map(asRecordKey),
		joinedAt: asDatetime(targetBefore.member?.joinedAt ?? new Date().toISOString()),
		nickname: targetBefore.member?.nickname ?? undefined,
	};
	return { member };
};

export const handleReorderCategories = async (
	ctx: AppContext,
	callerDid: string,
	input: { community: string; categories: string[] },
): Promise<void> => {
	await requireCommunity(ctx, input.community);
	const authz = await ctx.loader.authz(input.community, callerDid);
	if (!has(authz, "category.update")) throw forbidden("category.update");

	const existing = await ctx.database.db
		.select({ rkey: ctx.database.tables.categories.rkey })
		.from(ctx.database.tables.categories)
		.where(eq(ctx.database.tables.categories.community, input.community));

	const existingSet = new Set(existing.map((category) => category.rkey));
	const suppliedSet = new Set(input.categories);
	const matches =
		existingSet.size === suppliedSet.size &&
		[...existingSet].every((rkey) => suppliedSet.has(rkey));
	if (!matches) {
		throw new InvalidRequestError(
			"the supplied categories do not match the community's existing set",
			"InvalidRequest",
		);
	}

	try {
		await writeCommunitySettings(ctx, ctx.writer, input.community, {
			categoryOrder: input.categories,
		});
	} catch (error) {
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}
};

export const handleCreateInvitation = async (
	ctx: AppContext,
	callerDid: string,
	input: { community: string; maxUses?: number; expiresAt?: string },
): Promise<{ invitation: InvitationView }> => {
	await requireCommunity(ctx, input.community);
	const authz = await ctx.loader.authz(input.community, callerDid);
	if (!has(authz, "invitation.create")) throw forbidden("invitation.create");

	const row = {
		code: generatePassword(10),
		community: input.community,
		createdBy: callerDid,
		active: true,
		uses: 0,
		maxUses: input.maxUses ?? null,
		createdAt: new Date().toISOString(),
		expiresAt: input.expiresAt ?? null,
	};
	await ctx.database.db.insert(ctx.database.tables.invitations).values(row);
	return { invitation: invitationView(row) };
};

export const handleDeleteInvitation = async (
	ctx: AppContext,
	callerDid: string,
	community: string,
	code: string,
): Promise<void> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "invitation.delete")) throw forbidden("invitation.delete");

	const [existing] = await ctx.database.db
		.select()
		.from(ctx.database.tables.invitations)
		.where(
			and(
				eq(ctx.database.tables.invitations.code, code),
				eq(ctx.database.tables.invitations.community, community),
			),
		)
		.limit(1);
	if (!existing) {
		throw new InvalidRequestError("no invitation exists with that code", "InvitationNotFound");
	}

	await ctx.database.db
		.delete(ctx.database.tables.invitations)
		.where(eq(ctx.database.tables.invitations.code, code));
};

export const handleRegisterCredentials = async (
	ctx: AppContext,
	callerDid: string,
	input: { community: string; identifier: string; password: string },
): Promise<void> => {
	const existing = await ctx.credentials.load(input.community);
	if (existing) {
		const authz = await ctx.loader.authz(input.community, callerDid);
		if (!isAdmin(authz)) {
			throw new InvalidRequestError(
				"only an administrator of this community may replace its stored credentials",
				"Forbidden",
			);
		}
	}

	let pdsEndpoint: string;
	try {
		pdsEndpoint = await ctx.hosts.hostFor(input.community);
	} catch (error) {
		throw new InvalidRequestError(
			error instanceof Error ? error.message : "could not resolve the community's PDS",
			"UpstreamFailure",
		);
	}

	const client = new PdsClient({ service: pdsEndpoint });
	try {
		await client.login({ identifier: input.identifier, password: input.password });
	} catch {
		throw new InvalidRequestError(
			"the PDS refused the given identifier and password",
			"CredentialsRejected",
		);
	}

	await ctx.credentials.store({
		community: input.community,
		pdsEndpoint,
		identifier: input.identifier,
		password: input.password,
		source: "registered",
	});
};

export const handleMigrateCommunity = async (
	ctx: AppContext,
	communities: CommunityViews,
	callerDid: string,
	legacy: string,
): Promise<{ community: CommunityView }> => {
	const legacyDid = new AtUri(legacy).hostname;

	const already = await ctx.database.db
		.select({ did: ctx.database.tables.communities.did })
		.from(ctx.database.tables.communities)
		.where(eq(ctx.database.tables.communities.migratedFrom, legacy))
		.limit(1);
	if (already.length > 0) {
		throw new InvalidRequestError(
			"this legacy community has already been migrated",
			"AlreadyExists",
		);
	}

	const legacyRecord = await ctx.pds
		.getPublicRecord<{ value: { name?: string; description?: string } }>(
			legacyDid,
			COLLECTIONS.community,
			SELF,
		)
		.catch(() => null);
	if (!legacyRecord) throw communityNotFound();

	const authz = await ctx.loader.authz(legacyDid, callerDid);
	if (!isAdmin(authz)) {
		throw new InvalidRequestError(
			"only an administrator of the legacy community may migrate it",
			"Forbidden",
		);
	}

	let report: Awaited<ReturnType<typeof migrateCommunity>>;
	try {
		report = await migrateCommunity(
			{
				database: ctx.database,
				pds: ctx.pds,
				credentials: ctx.credentials,
				writer: ctx.writer,
				appviewService: serviceId(ctx.config.APPVIEW_DID, SERVICE_FRAGMENTS.appview),
				log: (message, detail) => ctx.log.info(detail ?? {}, message),
				dryRun: false,
			},
			legacyDid,
		);
	} catch (error) {
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		if (error instanceof XrpcError) throw new InvalidRequestError(error.message, "UpstreamFailure");
		throw error;
	}

	const spaces = communitySpaces(legacyDid);
	const row = {
		did: legacyDid,
		handle: null,
		name: legacyRecord.value.name ?? "Migrated community",
		description: legacyRecord.value.description ?? null,
		pictureCid: null,
		bannerCid: null,
		requiresApproval: false,
		linkEmbeds: true,
		labelers: [] as string[],
		migratedFrom: legacy,
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: new Date().toISOString(),
	};

	return { community: communities.community(row, authz, report.members) };
};

export const registerCommunityWriteRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const communities = new CommunityViews(ctx, actors);
	const membership = new Membership({
		db: ctx.database.db,
		tables: ctx.database.tables,
		loader: ctx.loader,
		writer: ctx.writer,
	});

	route(server, social.colibri.community.create, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleCreateCommunity(ctx, communities, caller.credentials.did, input.body),
		}),
	});

	route(server, social.colibri.community.update, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleUpdateCommunity(ctx, communities, caller.credentials.did, input.body),
		}),
	});

	route(server, social.colibri.community.delete, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleDeleteCommunity(ctx, caller.credentials.did, input.body.community);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.community.join, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleJoinCommunity(
				actors,
				membership,
				caller.credentials.did,
				input.body.community,
				input.body.invitation,
			),
		}),
	});

	route(server, social.colibri.community.leave, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleLeaveCommunity(ctx, membership, caller.credentials.did, input.body.community);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.community.setMemberRoles, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleSetMemberRoles(ctx, actors, membership, caller.credentials.did, input.body),
		}),
	});

	route(server, social.colibri.community.reorderCategories, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleReorderCategories(ctx, caller.credentials.did, input.body);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.community.createInvitation, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleCreateInvitation(ctx, caller.credentials.did, input.body),
		}),
	});

	route(server, social.colibri.community.deleteInvitation, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleDeleteInvitation(
				ctx,
				caller.credentials.did,
				input.body.community,
				input.body.code,
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.community.registerCredentials, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleRegisterCredentials(ctx, caller.credentials.did, input.body);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.community.migrate, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleMigrateCommunity(
				ctx,
				communities,
				caller.credentials.did,
				input.body.legacy,
			),
		}),
	});
};
