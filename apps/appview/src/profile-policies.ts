import { CommunityCredentialError, type CommunityHost } from "@colibri-social/community";
import { communitySpaces } from "@colibri-social/lexicons";
import { memberspacePolicy, type SpacePolicy, XrpcError } from "@colibri-social/space";
import type { AppContext } from "./context.js";

export type ProfilePolicyDeps = {
	communities: () => Promise<string[]>;
	connect: (community: string) => Promise<CommunityHost>;
	log: AppContext["log"];
};

export type ProfilePolicySweep = {
	updated: number;
	current: number;
	failed: number;
};

const failureCode = (error: unknown): string => {
	if (error instanceof CommunityCredentialError) return error.failure;
	if (error instanceof XrpcError) return error.code;
	return "Unknown";
};

const isPublicMemberspace = (policy: SpacePolicy): boolean =>
	policy.$type === "com.atproto.memberspace.policy" && policy.publicRead === true;

export const sweepProfilePolicies = async (
	deps: ProfilePolicyDeps,
): Promise<ProfilePolicySweep> => {
	const sweep: ProfilePolicySweep = { updated: 0, current: 0, failed: 0 };

	for (const community of await deps.communities()) {
		const space = communitySpaces(community).profile;
		try {
			const host = await deps.connect(community);
			const { policy } = await host.pds.getSpace(host.session, space);
			if (isPublicMemberspace(policy)) {
				sweep.current += 1;
				continue;
			}
			const next = memberspacePolicy({ publicRead: true });
			await host.pds.updateSpace(host.session, { space, policy: next });
			sweep.updated += 1;
			deps.log.info({ community, from: policy.$type, to: next.$type }, "heal.profilePolicyUpdated");
		} catch (error) {
			sweep.failed += 1;
			deps.log.warn({ community, code: failureCode(error) }, "heal.profilePolicyFailed");
		}
	}

	deps.log.info(sweep, "heal.profilePolicies");
	return sweep;
};

export const healProfilePolicies = (ctx: AppContext): Promise<ProfilePolicySweep> =>
	sweepProfilePolicies({
		communities: async () => {
			const table = ctx.database.tables.communityCredentials;
			const rows = await ctx.database.db.select({ community: table.community }).from(table);
			return rows.map((row) => row.community);
		},
		connect: (community) => ctx.credentials.connect(community),
		log: ctx.log,
	});
