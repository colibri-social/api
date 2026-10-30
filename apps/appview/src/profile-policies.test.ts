import type { CommunityHost } from "@colibri-social/community";
import { communitySpaces } from "@colibri-social/lexicons";
import { type SpacePolicy, XrpcError } from "@colibri-social/space";
import { describe, expect, it } from "vitest";
import { type ProfilePolicyDeps, sweepProfilePolicies } from "./profile-policies.js";

const MANAGED = "did:plc:managedxxxxxxxxxxxxxxxxxxxx";
const CURRENT = "did:plc:currentxxxxxxxxxxxxxxxxxxxx";
const OUTDATED = "did:plc:outdatedxxxxxxxxxxxxxxxxxxx";
const silent = { info: () => {}, warn: () => {} } as unknown as ProfilePolicyDeps["log"];

const setup = (policies: Record<string, SpacePolicy | Error>) => {
	const updates: Array<{ space: string; policy: SpacePolicy }> = [];
	const connect = async (community: string) =>
		({
			session: {},
			pds: {
				getSpace: async (_session: unknown, space: string) => {
					const policy = policies[community];
					if (policy instanceof Error) throw policy;
					return { uri: space, policy };
				},
				updateSpace: async (_session: unknown, input: { space: string; policy: SpacePolicy }) => {
					updates.push(input);
				},
			},
		}) as unknown as CommunityHost;
	const deps: ProfilePolicyDeps = {
		communities: async () => Object.keys(policies),
		connect,
		log: silent,
	};
	return { deps, updates };
};

describe("sweepProfilePolicies", () => {
	it("moves a managed profile space to a publicly readable member space", async () => {
		const { deps, updates } = setup({
			[MANAGED]: { $type: "com.atproto.managedspace.policy", managingApp: "did:web:appview.test" },
		});

		expect(await sweepProfilePolicies(deps)).toEqual({ updated: 1, current: 0, failed: 0 });
		expect(updates).toEqual([
			{
				space: communitySpaces(MANAGED).profile,
				policy: { $type: "com.atproto.memberspace.policy", publicRead: true },
			},
		]);
	});

	it("leaves a profile space that is already publicly readable alone", async () => {
		const { deps, updates } = setup({
			[CURRENT]: { $type: "com.atproto.memberspace.policy", publicRead: true },
		});

		expect(await sweepProfilePolicies(deps)).toEqual({ updated: 0, current: 1, failed: 0 });
		expect(updates).toEqual([]);
	});

	it("counts a host that is not on the new release yet and keeps going", async () => {
		const { deps, updates } = setup({
			[OUTDATED]: new XrpcError(501, "MethodNotImplemented", "unknown method", "getSpace"),
			[MANAGED]: { $type: "com.atproto.managedspace.policy", managingApp: "did:web:appview.test" },
		});

		expect(await sweepProfilePolicies(deps)).toEqual({ updated: 1, current: 0, failed: 1 });
		expect(updates).toHaveLength(1);
	});
});
