import type { Schema } from "@colibri-social/appview-db";
import type { Admit } from "@colibri-social/projections";
import { decideSpaceAccess } from "./access.js";
import { CommunityLoader } from "./loader.js";

export const admitCommunityWrites =
	(tables: Schema): Admit =>
	async (db, ref) => {
		const community = ref.space.community;
		if (!community) return "the space does not belong to a community";

		const loader = new CommunityLoader({ db, tables });
		const authz = await loader.authz(community, ref.author);
		const { channel, thread } = await loader.spaceStates(ref.space.uri, ref.space.spaceType);
		const decision = decideSpaceAccess({
			spaceType: ref.space.spaceType,
			authz,
			visibility: { profileIsPublic: false },
			channel,
			thread,
			access: "write",
		});
		return decision.authorized ? null : decision.reason;
	};
