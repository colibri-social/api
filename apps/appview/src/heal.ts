import {
	CommunityCredentialError,
	ensureDefaultRole,
	healOwnerPermissions,
} from "@colibri-social/community";
import { COLLECTIONS } from "@colibri-social/lexicons";
import { XrpcError } from "@colibri-social/space";
import { roleEvent } from "./announce.js";
import type { AppContext } from "./context.js";

const failureCode = (error: unknown): string => {
	if (error instanceof CommunityCredentialError) return error.failure;
	if (error instanceof XrpcError) return error.code;
	return "Unknown";
};

const backfills = new Map<string, Promise<void>>();

export const backfillDefaultRole = (ctx: AppContext, community: string): Promise<void> => {
	const running = backfills.get(community);
	if (running) return running;
	const pending = runDefaultRoleBackfill(ctx, community).finally(() => backfills.delete(community));
	backfills.set(community, pending);
	return pending;
};

const runDefaultRoleBackfill = async (ctx: AppContext, community: string): Promise<void> => {
	try {
		const backfill = await ensureDefaultRole(
			{
				db: ctx.database.db,
				tables: ctx.database.tables,
				loader: ctx.loader,
				writer: ctx.writer,
			},
			community,
		);
		if (!backfill) return;
		if (backfill.created || backfill.normalized) {
			ctx.announce.toCommunity(
				community,
				roleEvent(backfill.created ? "create" : "update", community, backfill.role),
			);
		}
		if (backfill.members > 0) {
			ctx.authzChanges.publish({ community, collection: COLLECTIONS.member });
		}
		const detail = {
			community,
			role: backfill.role,
			members: backfill.members,
			code: backfill.created
				? "DefaultRoleCreated"
				: backfill.normalized
					? "DefaultRoleNormalized"
					: "DefaultRoleRepaired",
		};
		if (backfill.failedMembers > 0) {
			ctx.log.warn(
				{ ...detail, failedMembers: backfill.failedMembers, code: "MemberWriteFailed" },
				"heal.defaultRolePartial",
			);
			return;
		}
		ctx.log.info(detail, "heal.defaultRole");
	} catch (error) {
		const code = failureCode(error);
		if (error instanceof CommunityCredentialError) {
			ctx.log.info({ community, code }, "heal.defaultRoleSkipped");
			return;
		}
		ctx.log.warn({ community, code }, "heal.defaultRoleFailed");
	}
};

export const healOwnerRolePermissions = async (ctx: AppContext): Promise<void> => {
	const rows = await ctx.database.db
		.select({ did: ctx.database.tables.communities.did })
		.from(ctx.database.tables.communities);

	for (const { did } of rows) {
		try {
			const healed = await healOwnerPermissions({ loader: ctx.loader, writer: ctx.writer }, did);
			if (healed.length > 0) {
				ctx.log.info({ community: did, roles: healed }, "heal.ownerPermissions");
			}
		} catch (error) {
			ctx.log.warn({ community: did, err: error }, "heal.ownerPermissionsFailed");
		}
		await backfillDefaultRole(ctx, did);
	}
};
