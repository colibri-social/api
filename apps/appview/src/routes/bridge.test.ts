import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { XRPCError } from "@atproto/xrpc-server";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	admitCommunityWrites,
	BridgeError,
	Bridges,
	CommunityCredentialError,
	type CommunityCredentials,
	CommunityLoader,
	CommunityWriter,
} from "@colibri-social/community";
import { IdentityResolver } from "@colibri-social/identity";
import { communitySpaces } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import {
	bridgeFailureToXrpc,
	handleInstallBridge,
	handlePutRemoteRooms,
	handleReportBackfill,
	registrationView,
} from "./bridge.js";

describe("bridgeFailureToXrpc", () => {
	it("names each failure after its lexicon error", () => {
		const error = bridgeFailureToXrpc(new BridgeError("channelNotLinked", "not linked"));

		expect(error).toBeInstanceOf(XRPCError);
		expect((error as XRPCError).customErrorName).toBe("ChannelNotLinked");
		expect((error as XRPCError).statusCode).toBe(400);
	});

	it("answers a rate limit with 429", () => {
		const error = bridgeFailureToXrpc(new BridgeError("rateLimited", "slow down"));

		expect((error as XRPCError).customErrorName).toBe("RateLimited");
		expect((error as XRPCError).statusCode).toBe(429);
	});

	it("reports unusable community credentials", () => {
		const error = bridgeFailureToXrpc(
			new CommunityCredentialError(
				"did:plc:communityxxxxxxxxxxxxxxxxxxx",
				"notProvisioned",
				"no credentials",
			),
		);

		expect((error as XRPCError).customErrorName).toBe("CredentialsUnavailable");
	});

	it("passes other errors through untouched", () => {
		const original = new Error("boom");

		expect(bridgeFailureToXrpc(original)).toBe(original);
	});
});

describe("registrationView", () => {
	it("serves links and leaves absent optional fields out", () => {
		const view = registrationView({
			community: "did:plc:communityxxxxxxxxxxxxxxxxxxx",
			id: "3lkbridgeaaaa",
			bridge: "did:plc:bridgexxxxxxxxxxxxxxxxxxxxxx",
			platform: "chat",
			remoteSpace: "server-1",
			remoteSpaceName: "Server One",
			links: [
				{
					channel:
						"at://did:plc:communityxxxxxxxxxxxxxxxxxxx/space/social.colibri.beta.channel.text/3lkchannel001",
					remoteRoom: "room-1",
					remoteName: "general",
				},
			],
			channels: [],
			enabled: true,
			mirrorModeration: false,
			createdBy: "did:plc:adminxxxxxxxxxxxxxxxxxxxxxxx",
			createdAt: "2026-09-24T12:00:00.000Z",
			updatedAt: null,
		});

		expect(view.links).toHaveLength(1);
		expect(view.updatedAt).toBeUndefined();
		expect(view.bridgeHandle).toBeUndefined();
		expect(view.communityName).toBeUndefined();
	});
});

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const ADMIN = "did:plc:adminxxxxxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxx";
const BRIDGE = "did:plc:bridgexxxxxxxxxxxxxxxxxxxxxx";
const BRIDGE_HANDLE = "bolt.example.com";
const NOW = "2026-09-24T12:00:00.000Z";

describe("handleInstallBridge", () => {
	let database: TestDatabase;
	let ctx: AppContext;

	const fakeCredentials = (): CommunityCredentials => {
		const pds = {
			putRecord: async (_session: unknown, write: { collection: string; rkey: string }) => ({
				uri: `at://${COMMUNITY}/${write.collection}/${write.rkey}`,
				cid: `bafy${write.rkey}`,
			}),
			deleteRecord: async () => undefined,
		};

		return { connect: async () => ({ pds, session: {} }) } as unknown as CommunityCredentials;
	};

	const resolveAtIdentifier = async (identifier: string) => {
		if (identifier !== BRIDGE && identifier !== BRIDGE_HANDLE) {
			throw new Error(`could not resolve ${identifier}`);
		}

		return { did: BRIDGE, handle: BRIDGE_HANDLE, pds: null, signingKey: "key" };
	};

	beforeEach(async () => {
		database = await openTestDatabase();

		const spaces = communitySpaces(COMMUNITY);
		const loader = new CommunityLoader({ db: database.db, tables: database.tables });
		const writer = new CommunityWriter({
			credentials: fakeCredentials(),
			mirror: {
				db: database.db,
				tables: database.tables,
				projections: {
					db: database.db,
					tables: database.tables,
					now: () => NOW,
					admit: admitCommunityWrites(database.tables),
				},
			},
		});

		ctx = {
			database,
			loader,
			identity: { resolveAtIdentifier },
			bridges: new Bridges({ db: database.db, tables: database.tables, loader, writer }),
		} as unknown as AppContext;

		await database.db.insert(database.tables.communities).values({
			did: COMMUNITY,
			name: "Bridged",
			labelers: [],
			profileSpace: spaces.profile,
			configSpace: spaces.configuration,
			membersSpace: spaces.members,
			moderationSpace: spaces.moderation,
			indexedAt: NOW,
		});
		await database.db.insert(database.tables.roles).values({
			community: COMMUNITY,
			rkey: "admin",
			name: "admin",
			color: null,
			permissions: ["community.manage"],
			position: 100,
			hoisted: false,
			mentionable: false,
			protected: false,
			channelOverrides: [],
		});
		await database.db.insert(database.tables.members).values([
			{ community: COMMUNITY, did: ADMIN, roles: ["admin"], joinedAt: NOW, nickname: null },
			{ community: COMMUNITY, did: MEMBER, roles: [], joinedAt: NOW, nickname: null },
		]);
	});

	afterEach(async () => {
		await database.destroy();
	});

	it("installs a bridge by handle and names it after the handle", async () => {
		const registration = await handleInstallBridge(ctx, ADMIN, {
			community: COMMUNITY,
			bridge: BRIDGE_HANDLE,
		});

		expect(registration).toMatchObject({
			bridge: BRIDGE,
			platform: "external",
			remoteSpace: COMMUNITY,
			remoteSpaceName: BRIDGE_HANDLE,
			links: [],
			channels: [],
			createdBy: ADMIN,
		});
	});

	it("refuses a bridge that is already installed", async () => {
		await handleInstallBridge(ctx, ADMIN, { community: COMMUNITY, bridge: BRIDGE });

		await expect(
			handleInstallBridge(ctx, ADMIN, { community: COMMUNITY, bridge: BRIDGE_HANDLE }),
		).rejects.toMatchObject({ customErrorName: "AlreadyRegistered" });
	});

	it("installs a bridge whose DID document has no handle and names it after the DID", async () => {
		const key = "zQ3shhDZeUurHvL6sQJe9Nr4AdVTJ85SXVLSb3fACygaN7VFm";
		const server: Server = createServer((_, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: did,
					alsoKnownAs: ["at://"],
					verificationMethod: [
						{ id: `${did}#atproto`, type: "Multikey", controller: did, publicKeyMultibase: key },
					],
					service: [
						{
							id: "#atproto_pds",
							type: "AtprotoPersonalDataServer",
							serviceEndpoint: "https://pds.test",
						},
					],
				}),
			);
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

		const did = `did:web:localhost%3A${(server.address() as AddressInfo).port}`;
		const identity = new IdentityResolver({
			plcUrl: "http://plc.invalid",
			fetch: globalThis.fetch,
			staleSeconds: 3600,
			maxSeconds: 86_400,
		});

		try {
			const registration = await handleInstallBridge({ ...ctx, identity } as AppContext, ADMIN, {
				community: COMMUNITY,
				bridge: did,
			});

			expect(registration).toMatchObject({ bridge: did, remoteSpaceName: did });
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("refuses an address that does not resolve", async () => {
		await expect(
			handleInstallBridge(ctx, ADMIN, { community: COMMUNITY, bridge: "nobody.example.com" }),
		).rejects.toMatchObject({ customErrorName: "BridgeNotFound" });
	});

	it("refuses a caller without community.manage", async () => {
		await expect(
			handleInstallBridge(ctx, MEMBER, { community: COMMUNITY, bridge: BRIDGE_HANDLE }),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
	});
});

describe("bridge update announcements", () => {
	const REGISTRATION = "3lkbridgeaaaa";
	const CHANNEL = `at://${COMMUNITY}/space/social.colibri.beta.channel.text/3lkchannel001`;
	const REPORT = {
		community: COMMUNITY,
		registration: REGISTRATION,
		channel: CHANNEL,
		requestedAt: NOW,
		state: "running" as const,
		imported: 12,
		from: NOW,
		until: NOW,
	};

	let announced: Array<{ community: string; permission: string; frame: unknown }>;

	const contextWith = (bridges: Record<string, () => Promise<void>>) => {
		return {
			bridges,
			announce: {
				toCommunityPermission: async (community: string, permission: string, frame: unknown) => {
					announced.push({ community, permission, frame });
				},
			},
			log: { warn: () => {} },
		} as unknown as AppContext;
	};

	const refusing = async () => {
		throw new BridgeError("forbidden", "not held");
	};

	beforeEach(() => {
		announced = [];
	});

	it("tells community managers about new remote rooms", async () => {
		const ctx = contextWith({ putRemoteRooms: async () => {} });

		await handlePutRemoteRooms(ctx, BRIDGE, { community: COMMUNITY, registration: REGISTRATION }, [
			{ id: "room-1", name: "general" },
		]);

		expect(announced).toEqual([
			{
				community: COMMUNITY,
				permission: "community.manage",
				frame: {
					$type: "social.colibri.beta.sync.defs#bridgeUpdateEvent",
					event: "rooms",
					community: COMMUNITY,
					registration: REGISTRATION,
				},
			},
		]);
	});

	it("tells community managers about backfill progress with the channel", async () => {
		const ctx = contextWith({ reportBackfill: async () => {} });

		await handleReportBackfill(ctx, BRIDGE, REPORT);

		expect(announced).toEqual([
			{
				community: COMMUNITY,
				permission: "community.manage",
				frame: {
					$type: "social.colibri.beta.sync.defs#bridgeUpdateEvent",
					event: "backfill",
					community: COMMUNITY,
					registration: REGISTRATION,
					channel: CHANNEL,
				},
			},
		]);
	});

	it("announces nothing when the bridge's write is refused", async () => {
		const ctx = contextWith({ putRemoteRooms: refusing, reportBackfill: refusing });

		await expect(
			handlePutRemoteRooms(ctx, BRIDGE, { community: COMMUNITY, registration: REGISTRATION }, []),
		).rejects.toBeInstanceOf(XRPCError);
		await expect(handleReportBackfill(ctx, BRIDGE, REPORT)).rejects.toBeInstanceOf(XRPCError);
		expect(announced).toEqual([]);
	});
});
