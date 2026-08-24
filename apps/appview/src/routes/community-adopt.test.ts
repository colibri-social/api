import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader, ProvisioningRefused } from "@colibri-social/community";
import { communitySpaces } from "@colibri-social/lexicons";
import { XrpcError } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import { handleAdoptCommunity } from "./community-write.js";

const NOW = "2026-08-23T00:00:00.000Z";
const APPVIEW = "did:web:appview.test";
const BYO = "did:plc:broughtmyownxxxxxxxxxxxxxxxxxxx";
const CALLER = "did:plc:callerxxxxxxxxxxxxxxxxxxxxxxx";
const THEIRS = "https://pds.theirs.test";

let database: TestDatabase;
let ctx: AppContext;
let adoptions: Array<{ did: string; pdsEndpoint: string; creator: string }>;
let forgotten: string[];
let hostFor: (did: string) => Promise<string>;
let adopt: (request: { did: string; pdsEndpoint: string; creator: string }) => Promise<unknown>;

const input = {
	did: BYO,
	identifier: "byo.example",
	password: "hunter2",
	name: "Brought My Own",
};

const call = () =>
	handleAdoptCommunity(ctx, new CommunityViews(ctx, new ActorViews(ctx)), CALLER, input);

const provisioned = (did: string) => ({
	did,
	handle: "byo.example",
	spaces: communitySpaces(did),
	ownerRole: "3lkowner000000",
	channels: { text: "at://text", voice: "at://voice" },
});

beforeEach(async () => {
	database = await openTestDatabase();
	adoptions = [];
	forgotten = [];
	hostFor = async () => THEIRS;
	adopt = async (request) => {
		adoptions.push(request);
		return provisioned(request.did);
	};

	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	ctx = {
		announce: silentAnnouncer,
		config: { PUBLIC_URL: "https://appview.test", APPVIEW_DID: APPVIEW },
		database,
		loader,
		hosts: { hostFor: (did: string) => hostFor(did) },
		credentials: {
			forget: async (community: string) => {
				forgotten.push(community);
			},
		},
		provisioner: {
			adopt: (request: { did: string; pdsEndpoint: string; creator: string }) => adopt(request),
		},
		identity: {
			resolveDid: async () => {
				throw new Error("no identity in tests");
			},
		},
	} as unknown as AppContext;
});

afterEach(async () => {
	await database.destroy();
});

describe("community.adopt", () => {
	it("adopts the account on whichever PDS already hosts it", async () => {
		const result = await call();

		expect(adoptions).toEqual([
			{
				did: BYO,
				pdsEndpoint: THEIRS,
				identifier: "byo.example",
				password: "hunter2",
				name: "Brought My Own",
				description: undefined,
				creator: CALLER,
			},
		]);
		expect(result.community.did).toBe(BYO);
		expect(result.community.handle).toBe("byo.example");
		expect(result.community.managingApp).toBe(APPVIEW);
	});

	it("refuses a DID that is already a community here, without touching the PDS", async () => {
		const spaces = communitySpaces(BYO);
		await database.db.insert(database.tables.communities).values({
			did: BYO,
			handle: null,
			name: "Already Here",
			description: null,
			managingApp: APPVIEW,
			pictureCid: null,
			bannerCid: null,
			requiresApproval: false,
			linkEmbeds: true,
			labelers: [],
			migratedFrom: null,
			profileSpace: spaces.profile,
			configSpace: spaces.configuration,
			membersSpace: spaces.members,
			moderationSpace: spaces.moderation,
			indexedAt: NOW,
		});

		await expect(call()).rejects.toMatchObject({ customErrorName: "AlreadyExists" });
		expect(adoptions).toEqual([]);
	});

	it("reports an unresolvable DID as an upstream failure", async () => {
		hostFor = async () => {
			throw new Error("no PDS in the DID document");
		};

		await expect(call()).rejects.toMatchObject({ customErrorName: "UpstreamFailure" });
		expect(adoptions).toEqual([]);
	});

	it("reports credentials for the wrong account as IdentityMismatch", async () => {
		adopt = async () => {
			throw new ProvisioningRefused("identityMismatch", "those credentials are someone else's");
		};

		await expect(call()).rejects.toMatchObject({ customErrorName: "IdentityMismatch" });
	});

	it("reports a PDS without spaces as SpacesUnsupported", async () => {
		adopt = async () => {
			throw new XrpcError(501, "MethodNotImplemented", "unknown method", "createSpace");
		};

		await expect(call()).rejects.toMatchObject({ customErrorName: "SpacesUnsupported" });
	});

	it("reports a refused password as CredentialsRejected and keeps nothing", async () => {
		adopt = async () => {
			throw new XrpcError(401, "InvalidPassword", "nope", "createSession");
		};

		await expect(call()).rejects.toMatchObject({ customErrorName: "CredentialsRejected" });
		expect(forgotten).toEqual([BYO]);
	});

	it("drops the stored credentials when adoption fails part way through", async () => {
		adopt = async () => {
			throw new XrpcError(500, "UpstreamFailure", "the PDS fell over", "createSpace");
		};

		await expect(call()).rejects.toMatchObject({ customErrorName: "UpstreamFailure" });
		expect(forgotten).toEqual([BYO]);
	});
});
