import { healOwnerPermissions } from "@colibri-social/community";
import type { AppContext } from "./context.js";

export const healOwnerRolePermissions = async (ctx: AppContext): Promise<void> => {
	const rows = await ctx.database.db
		.select({ did: ctx.database.tables.communities.did })
		.from(ctx.database.tables.communities);

	for (const { did } of rows) {
		try {
			const healed = await healOwnerPermissions({ loader: ctx.loader, writer: ctx.writer }, did);
			if (healed.length === 0) continue;
			ctx.log.info({ community: did, roles: healed }, "heal.ownerPermissions");
		} catch (error) {
			ctx.log.warn({ community: did, err: error }, "heal.ownerPermissionsFailed");
		}
	}
};
