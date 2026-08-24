import { LEGACY_COLLECTIONS } from "@colibri-social/lexicons";
import type { PdsClient } from "@colibri-social/space";
import { beforeEach, describe, expect, it } from "vitest";
import { legacyAdmin, legacyCandidates, readLegacyCommunity } from "./legacy.js";

const ACTOR = "did:plc:actorxxxxxxxxxxxxxxxxxxxxxx";
const OWNED = "did:plc:ownedxxxxxxxxxxxxxxxxxxxxxx";
const JOINED = "did:plc:joinedxxxxxxxxxxxxxxxxxxxxx";
const OWNER_ROLE = "3lkroleowner1";
const MEMBER_ROLE = "3lkrolemember";

type Repo = Map<string, Array<{ rkey: string; value: Record<string, unknown> }>>;

let repos: Map<string, Repo>;

const repoOf = (did: string): Repo => {
	const existing = repos.get(did);
	if (existing) return existing;
	const created: Repo = new Map();
	repos.set(did, created);
	return created;
};

const seed = (did: string, collection: string, rkey: string, value: Record<string, unknown>) => {
	const repo = repoOf(did);
	repo.set(collection, [...(repo.get(collection) ?? []), { rkey, value }]);
};

const fakeClient = (): PdsClient =>
	({
		getPublicRecord: async (repo: string, collection: string, rkey: string) => {
			const found = repos
				.get(repo)
				?.get(collection)
				?.find((record) => record.rkey === rkey);
			if (!found) throw new Error(`no ${collection}/${rkey} in ${repo}`);
			return { value: found.value };
		},
		xrpc: {
			query: async (
				_method: string,
				params: { repo: string; collection: string; cursor?: string },
			) => ({
				records: (repos.get(params.repo)?.get(params.collection) ?? []).map((record) => ({
					uri: `at://${params.repo}/${params.collection}/${record.rkey}`,
					value: record.value,
				})),
			}),
		},
	}) as unknown as PdsClient;

const deps = {
	hostFor: async (did: string) => `https://pds.test/${did}`,
	clientFor: () => fakeClient(),
};

beforeEach(() => {
	repos = new Map();
});

const seedLegacyCommunity = (
	did: string,
	options: { adminIs?: string; migratedTo?: string; channels?: number } = {},
) => {
	seed(did, LEGACY_COLLECTIONS.community, "self", {
		name: `Community ${did.slice(-4)}`,
		description: "a legacy community",
		...(options.migratedTo ? { migratedTo: options.migratedTo } : {}),
	});
	seed(did, LEGACY_COLLECTIONS.role, OWNER_ROLE, { name: "Owner", protected: true, position: 100 });
	seed(did, LEGACY_COLLECTIONS.role, MEMBER_ROLE, { name: "Member", position: 1 });
	seed(did, LEGACY_COLLECTIONS.member, "3lkmember0001", {
		subject: options.adminIs ?? ACTOR,
		roles: [options.adminIs === undefined ? MEMBER_ROLE : OWNER_ROLE],
	});
	for (let index = 0; index < (options.channels ?? 1); index += 1) {
		seed(did, LEGACY_COLLECTIONS.channel, `3lkchannel000${index}`, { name: "general" });
	}
};

describe("legacyCandidates", () => {
	it("reads the actor's own repo, keeping the sidebar order and adding joined communities", async () => {
		seed(ACTOR, LEGACY_COLLECTIONS.actorData, "self", { status: "", communities: [OWNED] });
		seed(ACTOR, LEGACY_COLLECTIONS.membership, "3lkjoin000001", {
			community: `at://${JOINED}/${LEGACY_COLLECTIONS.community}/self`,
		});

		expect(await legacyCandidates(deps, ACTOR)).toEqual([OWNED, JOINED]);
	});

	it("drops a membership whose community lived in someone else's repo", async () => {
		seed(ACTOR, LEGACY_COLLECTIONS.membership, "3lkjoin000001", {
			community: `at://not-a-did.example/${LEGACY_COLLECTIONS.community}/self`,
		});

		expect(await legacyCandidates(deps, ACTOR)).toEqual([]);
	});

	it("does not list the actor themselves and never repeats a community", async () => {
		seed(ACTOR, LEGACY_COLLECTIONS.actorData, "self", {
			status: "",
			communities: [OWNED, OWNED, ACTOR],
		});
		seed(ACTOR, LEGACY_COLLECTIONS.membership, "3lkjoin000001", {
			community: `at://${OWNED}/${LEGACY_COLLECTIONS.community}/self`,
		});

		expect(await legacyCandidates(deps, ACTOR)).toEqual([OWNED]);
	});

	it("returns nothing rather than throwing when the actor has no legacy records", async () => {
		expect(await legacyCandidates(deps, ACTOR)).toEqual([]);
	});

	it("finds a community the actor only ever read, with no membership record", async () => {
		seed(ACTOR, LEGACY_COLLECTIONS.read, "3lkchannel0000", {
			channel: `at://${OWNED}/${LEGACY_COLLECTIONS.channel}/3lkchannel0000`,
			cursor: `at://${ACTOR}/${LEGACY_COLLECTIONS.message}/3lkmsg00000001`,
		});

		expect(await legacyCandidates(deps, ACTOR)).toEqual([OWNED]);
	});

	it("falls back to the actor's messages when nothing else names a community", async () => {
		seed(ACTOR, LEGACY_COLLECTIONS.message, "3lkmsg00000001", {
			channel: `at://${OWNED}/${LEGACY_COLLECTIONS.channel}/3lkchannel0000`,
			content: "hello",
		});

		expect(await legacyCandidates(deps, ACTOR)).toEqual([OWNED]);
	});

	it("does not scan messages once another source has named a community", async () => {
		let messagePages = 0;
		const counting = {
			...deps,
			clientFor: () => {
				const client = fakeClient();
				const inner = client.xrpc.query.bind(client.xrpc);
				return {
					...client,
					xrpc: {
						query: async (method: string, params: { collection: string }) => {
							if (params.collection === LEGACY_COLLECTIONS.message) messagePages += 1;
							return inner(method, params as never);
						},
					},
				} as unknown as PdsClient;
			},
		};
		seed(ACTOR, LEGACY_COLLECTIONS.actorData, "self", { status: "", communities: [OWNED] });
		seed(ACTOR, LEGACY_COLLECTIONS.message, "3lkmsg00000001", {
			channel: `at://${JOINED}/${LEGACY_COLLECTIONS.channel}/3lkchannel0000`,
		});

		expect(await legacyCandidates(counting, ACTOR)).toEqual([OWNED]);
		expect(messagePages).toBe(0);
	});
});

describe("readLegacyCommunity", () => {
	it("counts members and channels and reports the viewer as an administrator", async () => {
		seedLegacyCommunity(OWNED, { adminIs: ACTOR, channels: 3 });

		expect(await readLegacyCommunity(deps, OWNED, ACTOR)).toEqual({
			did: OWNED,
			name: `Community ${OWNED.slice(-4)}`,
			description: "a legacy community",
			memberCount: 1,
			channelCount: 3,
			viewerIsAdmin: true,
		});
	});

	it("reports a member with no protected role as unable to migrate", async () => {
		seedLegacyCommunity(JOINED);

		expect(await readLegacyCommunity(deps, JOINED, ACTOR)).toMatchObject({
			viewerIsAdmin: false,
		});
	});

	it("treats the community itself as an administrator", async () => {
		seedLegacyCommunity(OWNED);

		expect(await readLegacyCommunity(deps, OWNED, OWNED)).toMatchObject({ viewerIsAdmin: true });
	});

	it("surfaces migratedTo so an already-migrated community can be filtered out", async () => {
		seedLegacyCommunity(OWNED, { adminIs: ACTOR, migratedTo: `at://${OWNED}/space/x/self` });

		expect(await readLegacyCommunity(deps, OWNED, ACTOR)).toMatchObject({
			migratedTo: `at://${OWNED}/space/x/self`,
		});
	});

	it("returns null when the repo holds no legacy community record", async () => {
		expect(await readLegacyCommunity(deps, OWNED, ACTOR)).toBeNull();
	});
});

describe("legacyAdmin", () => {
	it("refuses a community it cannot read at all", async () => {
		expect(await legacyAdmin(deps, OWNED, ACTOR)).toBe(false);
	});

	it("agrees with the community's own protected roles", async () => {
		seedLegacyCommunity(OWNED, { adminIs: ACTOR });
		expect(await legacyAdmin(deps, OWNED, ACTOR)).toBe(true);

		seedLegacyCommunity(JOINED);
		expect(await legacyAdmin(deps, JOINED, ACTOR)).toBe(false);
	});
});
