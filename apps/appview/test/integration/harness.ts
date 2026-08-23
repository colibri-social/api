import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Secp256k1Keypair, sha256 } from "@atproto/crypto";
import { createServer as createXrpcServer } from "@atproto/xrpc-server";
import { type Database, openTestDatabase } from "@colibri-social/appview-db";
import {
	CommunityCredentials,
	CommunityLoader,
	CommunityProvisioner,
	CommunityWriter,
	Membership,
	Moderation,
	SecretBox,
} from "@colibri-social/community";
import {
	IdentityResolver,
	SERVICE_FRAGMENTS,
	ServiceAuth,
	serviceId,
} from "@colibri-social/identity";
import { applyChange, type ProjectionDeps } from "@colibri-social/projections";
import {
	DidDocumentSpaceHostResolver,
	PdsAdmin,
	PdsClient,
	type PdsSession,
	SpaceClient,
	SpaceCredentials,
} from "@colibri-social/space";
import { RepoSync } from "@colibri-social/space-sync";
import { pino } from "pino";
import { authVerifiers } from "../../src/auth.js";
import type { AppContext } from "../../src/context.js";
import { registerProtocolRoutes } from "../../src/routes/protocol.js";

export const pdsUrl = process.env.PDS_URL ?? "http://127.0.0.1:3001";
export const adminPassword = process.env.PDS_ADMIN_PASSWORD ?? "admin";
export const plcUrl = process.env.PLC_URL ?? "http://127.0.0.1:2582";

export const unique = (prefix: string) => `${prefix}${randomBytes(4).toString("hex")}`;

export const waitForPds = async (timeoutMs = 60_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const ok = await fetch(`${pdsUrl}/xrpc/_health`)
			.then((response) => response.ok)
			.catch(() => false);
		if (ok) return;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`the PDS at ${pdsUrl} did not become healthy`);
};

const textEncoder = new TextEncoder();

const cborHead = (majorType: number, length: number): number[] => {
	if (length < 24) return [(majorType << 5) | length];
	if (length < 256) return [(majorType << 5) | 24, length];
	if (length < 65536) return [(majorType << 5) | 25, (length >> 8) & 0xff, length & 0xff];
	return [
		(majorType << 5) | 26,
		(length >>> 24) & 0xff,
		(length >>> 16) & 0xff,
		(length >>> 8) & 0xff,
		length & 0xff,
	];
};

const compareBytes = (a: number[], b: number[]): number => {
	for (let index = 0; index < a.length; index++) {
		const diff = (a[index] as number) - (b[index] as number);
		if (diff !== 0) return diff;
	}
	return 0;
};

const encodeDagCbor = (value: unknown): number[] => {
	if (value === null) return [0xf6];
	if (typeof value === "string") {
		const bytes = Array.from(textEncoder.encode(value));
		return [...cborHead(3, bytes.length), ...bytes];
	}
	if (Array.isArray(value)) {
		return [...cborHead(4, value.length), ...value.flatMap((entry) => encodeDagCbor(entry))];
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => ({
			key,
			bytes: Array.from(textEncoder.encode(key)),
			entryValue,
		}));
		entries.sort((a, b) => a.bytes.length - b.bytes.length || compareBytes(a.bytes, b.bytes));
		const body = entries.flatMap(({ key, entryValue }) => [
			...encodeDagCbor(key),
			...encodeDagCbor(entryValue),
		]);
		return [...cborHead(5, entries.length), ...body];
	}
	throw new Error(`cannot encode value of type ${typeof value} for a did:plc operation`);
};

const PLC_BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const encodeBase32 = (bytes: Uint8Array): string => {
	let bits = 0;
	let value = 0;
	let output = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += PLC_BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
			bits -= 5;
		}
	}
	if (bits > 0) output += PLC_BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
	return output;
};

type PlcServiceEntry = { type: string; endpoint: string };

type PlcOperation = {
	type: "plc_operation";
	rotationKeys: string[];
	verificationMethods: Record<string, string>;
	alsoKnownAs: string[];
	services: Record<string, PlcServiceEntry>;
	prev: string | null;
};

const registerAppviewDid = async (options: {
	plcUrl: string;
	port: number;
}): Promise<{ did: string; keypair: Secp256k1Keypair }> => {
	const keypair = await Secp256k1Keypair.create({ exportable: true });
	const endpoint = `http://host.docker.internal:${options.port}`;

	const unsigned: PlcOperation = {
		type: "plc_operation",
		rotationKeys: [keypair.did()],
		verificationMethods: { atproto: keypair.did() },
		alsoKnownAs: [],
		services: {
			[SERVICE_FRAGMENTS.appview]: { type: "ColibriAppView", endpoint },
			[SERVICE_FRAGMENTS.syncer]: { type: "AtprotoSpaceSyncer", endpoint },
		},
		prev: null,
	};

	const sig = Buffer.from(await keypair.sign(Uint8Array.from(encodeDagCbor(unsigned)))).toString(
		"base64url",
	);
	const operation = { ...unsigned, sig };
	const hash = await sha256(Uint8Array.from(encodeDagCbor(operation)));
	const did = `did:plc:${encodeBase32(hash).slice(0, 24)}`;

	const response = await fetch(`${options.plcUrl}/${did}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(operation),
	});
	if (!response.ok) {
		throw new Error(
			`could not register the appview's did:plc at ${options.plcUrl}: ${response.status} ${await response.text()}`,
		);
	}

	return { did, keypair };
};

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export const createHarness = async () => {
	const database = await openTestDatabase();

	const pds = new PdsClient({ service: pdsUrl });
	const admin = new PdsAdmin(pds.xrpc, { password: adminPassword });
	const secrets = await SecretBox.fromBase64(SecretBox.generateKeyBase64());

	const credentials = new CommunityCredentials({
		db: database.db,
		tables: database.tables,
		secrets,
		pds,
		admin,
	});

	const identity = new IdentityResolver({
		plcUrl,
		staleSeconds: 5,
		maxSeconds: 30,
	});

	const httpServer = createHttpServer();
	await new Promise<void>((resolve) => httpServer.listen(0, "0.0.0.0", resolve));
	const { port } = httpServer.address() as AddressInfo;

	const { did: appviewDid } = await registerAppviewDid({ plcUrl, port });

	const serviceAuth = new ServiceAuth({
		audience: [
			appviewDid,
			serviceId(appviewDid, SERVICE_FRAGMENTS.appview),
			serviceId(appviewDid, SERVICE_FRAGMENTS.syncer),
		],
		maxLifetimeSeconds: 300,
		resolver: identity,
	});

	const hosts = new DidDocumentSpaceHostResolver({ plcUrl });

	const spaceCredentials = new SpaceCredentials({
		hosts,
		delegation: async (space) => {
			const authority = space.slice("at://".length).split("/")[0] as string;
			const stored = await credentials.load(authority);
			if (!stored) return null;
			const session = await credentials.session(authority);
			return pds.getDelegationToken(session, space);
		},
	});

	const spaceClient = new SpaceClient({ hosts, credentials: spaceCredentials });
	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	const writer = new CommunityWriter({ pds, credentials });

	const membership = new Membership({
		db: database.db,
		tables: database.tables,
		loader,
		writer,
	});

	const moderation = new Moderation({
		db: database.db,
		tables: database.tables,
		loader,
		writer,
		membership,
	});

	const protocolCtx = {
		loader,
		log: pino({ level: "silent" }),
		serviceAuth,
		sync: {
			notifyWrite: () => undefined,
			notifySpaceDeleted: () => undefined,
		},
	} as unknown as AppContext;

	const protocolAuth = authVerifiers(protocolCtx);
	const protocolServer = createXrpcServer(undefined, {
		payload: { jsonLimit: 1_000_000, blobLimit: 20 * 1024 * 1024 },
		catchall: undefined,
	});
	registerProtocolRoutes({ server: protocolServer, ctx: protocolCtx, auth: protocolAuth });
	httpServer.on("request", protocolServer.router);

	const provisioner = new CommunityProvisioner({
		pds,
		admin,
		credentials,
		handleDomain: "test",
		emailDomain: "communities.test.invalid",
		appviewService: serviceId(appviewDid, SERVICE_FRAGMENTS.appview),
	});

	const projections: ProjectionDeps = {
		db: database.db,
		tables: database.tables,
		now: () => new Date().toISOString(),
	};

	const repoSync = new RepoSync({
		client: spaceClient,
		store: integrationStore(database, projections),
		hosts: { hostFor: async (did) => (await identity.resolveDid(did)).pds ?? pdsUrl },
		keys: { signingKeyFor: async (did) => (await identity.resolveDid(did)).signingKey },
	});

	const createUser = async (handlePrefix = unique("user")) => {
		const handle = `${handlePrefix}.test`;
		const password = randomBytes(16).toString("hex");
		const account = await admin.createAccount({
			handle,
			email: `${handlePrefix}@test.invalid`,
			password,
		});
		const session = await pds.login({ identifier: handle, password });
		return { did: account.did, handle, password, session };
	};

	const syncSpace = async (space: string) => {
		for await (const repo of spaceClient.allRepos(space)) {
			await repoSync.sync(space, repo.did);
		}
	};

	const waitForWriter = async (space: string, did: string, timeoutMs = 5_000): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			for await (const repo of spaceClient.allRepos(space)) {
				if (repo.did === did) return;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		throw new Error(
			`writer ${did} did not appear in the writer set for ${space} within ${timeoutMs}ms`,
		);
	};

	return {
		database,
		pds,
		admin,
		credentials,
		identity,
		appviewDid,
		spaceClient,
		spaceCredentials,
		loader,
		writer,
		membership,
		moderation,
		provisioner,
		projections,
		repoSync,
		createUser,
		syncSpace,
		waitForWriter,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => (error ? reject(error) : resolve()));
			});
			await database.destroy();
		},
	};
};

const integrationStore = (database: Database, projections: ProjectionDeps) => {
	const { db, tables } = database;
	const now = () => new Date().toISOString();

	return {
		listSpaces: async () =>
			db.select({ uri: tables.spaces.uri, authority: tables.spaces.authority }).from(tables.spaces),
		listCursors: async () => [],
		loadCursor: async (space: string, author: string) => {
			const { and, eq } = await import("drizzle-orm");
			const [row] = await db
				.select()
				.from(tables.spaceRepos)
				.where(and(eq(tables.spaceRepos.space, space), eq(tables.spaceRepos.author, author)))
				.limit(1);
			return row
				? {
						space: row.space,
						author: row.author,
						appliedRev: row.appliedRev,
						setHashBase64: row.setHashBase64,
						state: row.state,
						consecutiveFailures: row.consecutiveFailures,
						retryAfter: row.retryAfter ? new Date(row.retryAfter) : null,
					}
				: null;
		},
		saveCursor: async () => undefined,
		commit: async (
			change: { space: string; author: string; puts: never[]; deletes: never[] },
			cursor: { appliedRev: string | null; setHashBase64: string | null; state: string },
		) => {
			await applyChange(projections, change);
			await upsertCursor(database, change.space, change.author, cursor, now());
		},
		replace: async (
			change: { space: string; author: string; puts: never[] },
			cursor: { appliedRev: string | null; setHashBase64: string | null; state: string },
		) => {
			await applyChange(projections, { ...change, deletes: [] });
			await upsertCursor(database, change.space, change.author, cursor, now());
		},
		dropRepo: async () => undefined,
		dropSpace: async () => undefined,
	} as never;
};

const upsertCursor = async (
	{ db, tables }: Database,
	space: string,
	author: string,
	cursor: { appliedRev: string | null; setHashBase64: string | null; state: string },
	syncedAt: string,
) => {
	const row = {
		space,
		author,
		appliedRev: cursor.appliedRev,
		setHashBase64: cursor.setHashBase64,
		state: cursor.state as "active",
		consecutiveFailures: 0,
		retryAfter: null,
		syncedAt,
	};
	await db
		.insert(tables.spaceRepos)
		.values(row)
		.onConflictDoUpdate({ target: [tables.spaceRepos.space, tables.spaceRepos.author], set: row });
};

export const registerSpace = async (
	{ db, tables }: Database,
	space: string,
	authority: string,
	community: string | null,
	host: string,
) => {
	await db
		.insert(tables.spaces)
		.values({
			uri: space,
			authority,
			spaceType: space.split("/")[4] as string,
			skey: space.split("/").pop() as string,
			community,
			host,
			createdAt: new Date().toISOString(),
		})
		.onConflictDoNothing();
};

export type UserFixture = { did: string; handle: string; password: string; session: PdsSession };
