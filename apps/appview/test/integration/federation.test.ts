import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secp256k1Keypair } from "@atproto/crypto";
import { SecretBox } from "@colibri-social/community";
import { COLLECTIONS, communitySpaces, preferencesSpace, SELF } from "@colibri-social/lexicons";
import { applyChange } from "@colibri-social/projections";
import { PdsAdmin, PdsClient } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { type AppContext, createContext } from "../../src/context.js";
import { createRemoteCommunities } from "../../src/federation/remote-communities.js";
import { connectPipeline } from "../../src/pipeline.js";
import { saveActor } from "../../src/polyfill/state.js";
import { createAppServer } from "../../src/server.js";
import {
	adminPassword,
	createTestUser,
	handleDomain,
	pdsUrl,
	plcUrl,
	type UserFixture,
	unique,
	waitForPds,
} from "./harness.js";

const NS = "social.colibri.beta";
const MENTION_FACET = `${NS}.richtext.facet#mention`;
const POLYFILL_CREATE = `${NS}.polyfill.applyWrites#create`;

const routedUrl = process.env.FEDERATION_APPVIEW_URL;
const routedPort = Number(process.env.FEDERATION_APPVIEW_PORT);
const routed = Boolean(routedUrl) && Number.isInteger(routedPort) && routedPort > 0;

type RunningAppview = {
	did: string;
	url: string;
	ctx: AppContext;
	stop: () => Promise<void>;
	close: () => Promise<void>;
};

type XrpcAnswer = {
	status: number;
	body: Record<string, unknown>;
};

type XrpcInput = {
	params?: Record<string, string>;
	body?: unknown;
};

type MessageView = {
	text: string;
	author: { did: string };
};

const pds = new PdsClient({ service: pdsUrl });
const admin = new PdsAdmin(pds.xrpc, { password: adminPassword });

const listen = (server: HttpServer, port: number) => {
	return new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, () => resolve((server.address() as AddressInfo).port));
	});
};

const startAppview = async (options: { port: number; publicUrl?: string }) => {
	const http = createServer();
	const port = await listen(http, options.port);
	const url = options.publicUrl ?? `http://localhost:${port}`;
	const did = `did:web:${encodeURIComponent(new URL(url).host)}`;
	const directory = mkdtempSync(join(tmpdir(), "colibri-federation-"));
	const keypair = await Secp256k1Keypair.create({ exportable: true });

	const config = loadConfig({
		NODE_ENV: "test",
		LOG_LEVEL: "fatal",
		APPVIEW_DID: did,
		PUBLIC_URL: url,
		SIGNING_KEY: Buffer.from(await keypair.export()).toString("hex"),
		CREDENTIAL_ENCRYPTION_KEY: SecretBox.generateKeyBase64(),
		DATABASE_URL: `file:${join(directory, "appview.db")}`,
		ROLES: "main,api",
		PDS_URL: pdsUrl,
		PDS_ADMIN_PASSWORD: adminPassword,
		PDS_REQUIRES_INVITE: "true",
		PLC_URL: plcUrl,
		COMMUNITY_HANDLE_DOMAIN: handleDomain,
		JETSTREAM_ENABLED: "false",
		VOICE_ENABLED: "false",
		COLIBRI_TELEMETRY_DISABLED: "1",
		BLOB_DISK_CACHE_DIR: join(directory, "blobs"),
	});

	const ctx = await createContext(config);
	const server = createAppServer(ctx);
	const disconnect = connectPipeline({ ctx });
	let listening = true;

	http.on("request", server.router);

	const stop = async () => {
		if (!listening) return;

		listening = false;

		await new Promise<void>((resolve) => {
			http.close(() => resolve());
			http.closeAllConnections();
		});
	};

	return {
		did,
		url,
		ctx,
		stop,
		close: async () => {
			await stop();
			disconnect();
			await ctx.close();
			rmSync(directory, { recursive: true, force: true });
		},
	} satisfies RunningAppview;
};

const serviceToken = async (user: UserFixture, audience: string, lxm: string) => {
	const { token } = await user.session.run((auth) =>
		pds.xrpc.query<{ token: string }>(
			"com.atproto.server.getServiceAuth",
			{ aud: `${audience}#colibri_appview`, lxm },
			auth,
		),
	);

	return token;
};

const xrpc = async (
	target: RunningAppview,
	user: UserFixture,
	nsid: string,
	input: XrpcInput = {},
): Promise<XrpcAnswer> => {
	const url = new URL(`/xrpc/${nsid}`, target.url);

	for (const [name, value] of Object.entries(input.params ?? {})) {
		url.searchParams.set(name, value);
	}

	const headers: Record<string, string> = {
		authorization: `Bearer ${await serviceToken(user, target.did, nsid)}`,
	};

	if (input.body !== undefined) headers["content-type"] = "application/json";

	const response = await fetch(url, {
		method: input.body === undefined ? "GET" : "POST",
		headers,
		body: input.body === undefined ? undefined : JSON.stringify(input.body),
	});

	const text = await response.text();

	return { status: response.status, body: text ? JSON.parse(text) : {} };
};

const waitFor = async <T>(
	check: () => Promise<T | undefined>,
	what: string,
	timeoutMs = 30_000,
): Promise<T> => {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const value = await check();

		if (value !== undefined) return value;

		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	throw new Error(`timed out waiting for ${what}`);
};

const declareAppviews = (user: UserFixture, appviews: string[]) => {
	return pds.putRepoRecord(user.session, {
		collection: COLLECTIONS.appview,
		rkey: SELF,
		record: {
			$type: COLLECTIONS.appview,
			appviews,
			updatedAt: new Date().toISOString(),
		},
	});
};

const rkeyOf = (uri: string): string => {
	return uri.split("/").at(-1) as string;
};

describe.skipIf(!routed)(
	"federation between two AppViews (needs FEDERATION_APPVIEW_URL and FEDERATION_APPVIEW_PORT)",
	() => {
		let home: RunningAppview;
		let managing: RunningAppview;
		let founder: UserFixture;
		let member: UserFixture;
		let polyfilled: UserFixture;
		let community: string;
		let channel: string;
		let invitation: string;

		const sweep = async (spaces: readonly string[]) => {
			for (const space of spaces) await managing.ctx.sync.sweepSpace(space);

			await managing.ctx.sync.drain();
		};

		const managedMessage = async (author: string, rkey: string) => {
			const { db, tables } = managing.ctx.database;

			const [row] = await db
				.select({ text: tables.messages.text })
				.from(tables.messages)
				.where(
					and(
						eq(tables.messages.space, channel),
						eq(tables.messages.author, author),
						eq(tables.messages.rkey, rkey),
					),
				);

			return row;
		};

		const syncedMessage = (author: string, rkey: string) => {
			return waitFor(async () => {
				await sweep([channel]);

				return managedMessage(author, rkey);
			}, `message ${rkey} on the managing AppView`);
		};

		const homeNotifications = (recipient: string) => {
			const { db, tables } = home.ctx.database;

			return db
				.select()
				.from(tables.notifications)
				.where(eq(tables.notifications.recipient, recipient));
		};

		const listMessagesThroughHome = async (user: UserFixture) => {
			const answer = await xrpc(home, user, `${NS}.channel.listMessages`, {
				params: { channel },
			});

			expect(answer.status).toBe(200);

			return answer.body.messages as MessageView[];
		};

		beforeAll(async () => {
			await waitForPds();

			home = await startAppview({ port: 0 });
			managing = await startAppview({ port: routedPort, publicUrl: routedUrl });

			home.ctx.remoteCommunities = createRemoteCommunities({
				enabled: true,
				hosts: home.ctx.spaceHosts,
				forward: home.ctx.forwarder,
				cacheMs: 0,
			});

			founder = await createTestUser({ pds, admin }, unique("founder"));
			member = await createTestUser({ pds, admin }, unique("member"));
			polyfilled = await createTestUser({ pds, admin }, unique("polyfill"));

			await declareAppviews(member, [home.did]);
			await declareAppviews(polyfilled, [home.did]);

			const provisioned = await managing.ctx.provisioner.create({
				name: "Federated community",
				description: "managed by the second AppView",
				creator: founder.did,
			});

			community = provisioned.did;
			channel = provisioned.channels.text;

			await sweep([...Object.values(communitySpaces(community)), channel]);
		}, 180_000);

		afterAll(async () => {
			await home?.close();
			await managing?.close();
		});

		it("joins a Space on the managing AppView through the home AppView", async () => {
			const created = await xrpc(managing, founder, `${NS}.community.createInvitation`, {
				body: { community },
			});

			expect(created.status).toBe(200);

			invitation = (created.body.invitation as { code: string }).code;

			const joined = await xrpc(home, member, `${NS}.community.join`, {
				body: { community, invitation },
			});

			expect(joined.status).toBe(200);
			expect(joined.body.status).toBe("joined");

			const authz = await managing.ctx.loader.authz(community, member.did);

			expect(authz.member).not.toBeNull();
			expect(await home.ctx.loader.community(community)).toBeFalsy();
		});

		it("forwards reading messages to the managing AppView", async () => {
			const written = await pds.createRecord(founder.session, {
				space: channel,
				collection: COLLECTIONS.message,
				record: {
					$type: COLLECTIONS.message,
					text: "hello from the managing AppView",
					createdAt: new Date().toISOString(),
				},
			});

			await syncedMessage(founder.did, rkeyOf(written.uri));

			const messages = await listMessagesThroughHome(member);

			expect(messages.map((message) => message.text)).toContain("hello from the managing AppView");
		});

		it("delivers a mention to the home AppView and retracts it on delete", async () => {
			const text = `hey @${member.handle}`;
			const mention = `@${member.handle}`;
			const byteStart = Buffer.byteLength(text) - Buffer.byteLength(mention);

			const written = await pds.createRecord(founder.session, {
				space: channel,
				collection: COLLECTIONS.message,
				record: {
					$type: COLLECTIONS.message,
					text,
					facets: [
						{
							index: { byteStart, byteEnd: Buffer.byteLength(text) },
							features: [{ $type: MENTION_FACET, did: member.did }],
						},
					],
					createdAt: new Date().toISOString(),
				},
			});

			const rkey = rkeyOf(written.uri);

			await syncedMessage(founder.did, rkey);

			const delivered = await waitFor(async () => {
				const rows = await homeNotifications(member.did);

				return rows.find((row) => row.messageRkey === rkey);
			}, "the federated notification on the home AppView");

			expect(delivered.kind).toBe("mention");
			expect(delivered.originAppview).toBe(managing.did);
			expect(delivered.community).toBe(community);

			await pds.deleteRecord(founder.session, {
				space: channel,
				collection: COLLECTIONS.message,
				rkey,
			});

			await waitFor(async () => {
				await sweep([channel]);

				return (await managedMessage(founder.did, rkey)) ? undefined : true;
			}, "the deleted message to leave the managing AppView");

			await waitFor(async () => {
				const rows = await homeNotifications(member.did);

				return rows.some((row) => row.messageRkey === rkey) ? undefined : true;
			}, "the retraction on the home AppView");
		});

		it("writes into the Space through the home AppView for a polyfilled user", async () => {
			const { pds: endpoint } = await managing.ctx.identity.resolveDid(polyfilled.did);

			await saveActor(
				{
					db: managing.ctx.database.primary,
					tables: managing.ctx.database.tables,
				},
				{
					did: polyfilled.did,
					mode: "polyfill",
					pds: endpoint,
					pdsSupportsSpaces: false,
				},
				new Date(),
			);

			const joined = await xrpc(home, polyfilled, `${NS}.community.join`, {
				body: { community, invitation },
			});

			expect(joined.status).toBe(200);

			const written = await xrpc(home, polyfilled, `${NS}.polyfill.applyWrites`, {
				body: {
					space: channel,
					writes: [
						{
							$type: POLYFILL_CREATE,
							collection: COLLECTIONS.message,
							value: {
								$type: COLLECTIONS.message,
								text: "written through the polyfill",
								createdAt: new Date().toISOString(),
							},
						},
					],
				},
			});

			expect(written.status).toBe(200);

			const messages = await waitFor(async () => {
				const listed = await listMessagesThroughHome(member);

				return listed.some((message) => message.author.did === polyfilled.did) ? listed : undefined;
			}, "the polyfilled message through the home AppView");

			expect(messages.map((message) => message.text)).toContain("written through the polyfill");
		});

		it("lists the remote Space, then reports it unavailable once its AppView stops", async () => {
			await applyChange(home.ctx.projections, {
				space: preferencesSpace(member.did),
				author: member.did,
				puts: [
					{
						collection: COLLECTIONS.remoteSpace,
						rkey: community,
						cid: "bafyreifederationintegration",
						value: {
							$type: COLLECTIONS.remoteSpace,
							managingApp: managing.did,
							joinedAt: new Date().toISOString(),
						},
					},
				],
				deletes: [],
			});

			const listed = await xrpc(home, member, `${NS}.actor.listCommunities`);

			expect(listed.status).toBe(200);
			expect((listed.body.communities as { did: string }[]).map((view) => view.did)).toContain(
				community,
			);
			expect(listed.body.unavailable).toBeUndefined();

			await managing.stop();

			const stopped = await xrpc(home, member, `${NS}.actor.listCommunities`);

			expect(stopped.status).toBe(200);
			expect(stopped.body.communities).toEqual([]);
			expect(stopped.body.unavailable).toEqual([
				{
					did: community,
					managingApp: managing.did,
				},
			]);
		});
	},
);
