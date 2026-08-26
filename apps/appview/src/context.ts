import { Secp256k1Keypair } from "@atproto/crypto";
import { type Database, openDatabase, runMigrations } from "@colibri-social/appview-db";
import { BlobCache, BlobService } from "@colibri-social/blobs";
import {
	CommunityCredentials,
	CommunityLoader,
	CommunityProvisioner,
	CommunityWriter,
	SecretBox,
	spaceRegistry,
} from "@colibri-social/community";
import { createGifsClient, createPreviewCache, createTtlCache } from "@colibri-social/embeds";
import {
	buildDidDocument,
	IdentityResolver,
	SERVICE_FRAGMENTS,
	ServiceAuth,
	serviceId,
} from "@colibri-social/identity";
import type { ProjectionDeps } from "@colibri-social/projections";
import {
	DidDocumentSpaceHostResolver,
	PdsAdmin,
	PdsClient,
	SpaceClient,
	SpaceCredentials,
} from "@colibri-social/space";
import { SpaceSyncEngine } from "@colibri-social/space-sync";
import { createVoiceSfu, voiceSfuConfigFromEnv } from "@colibri-social/voice";
import {
	ARTWORK_CACHE_MAX_ENTRIES,
	ARTWORK_CACHE_TTL_MS,
	type ArtworkEntry,
} from "./activity-artwork.js";
import { type Announcer, silentAnnouncer } from "./announce.js";
import { type AuthzChanges, createAuthzChanges } from "./authz-changes.js";
import type { Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { drizzleCredentialStorage, drizzleIdentityStore, drizzleSyncStore } from "./stores.js";
import { createVideoArtworkClient } from "./video-artwork.js";
import type { VoiceRoster } from "./ws/voice.js";

const emptyVoiceRoster: VoiceRoster = {
	isJoined: () => false,
	disconnect: async () => {},
};

export type AppContext = Awaited<ReturnType<typeof createContext>>;

export const createContext = async (config: Config) => {
	const log = createLogger(config);

	const database: Database = openDatabase({
		url: config.DATABASE_URL,
		...(config.DATABASE_AUTH_TOKEN ? { authToken: config.DATABASE_AUTH_TOKEN } : {}),
		maxConnections: config.DATABASE_MAX_CONNECTIONS,
	});
	await runMigrations(database);

	const keypair = await Secp256k1Keypair.import(config.SIGNING_KEY, {
		exportable: true,
	});
	const secrets = await SecretBox.fromBase64(config.CREDENTIAL_ENCRYPTION_KEY);

	const identity = new IdentityResolver({
		plcUrl: config.PLC_URL,
		staleSeconds: 60 * 60,
		maxSeconds: 24 * 60 * 60,
		store: drizzleIdentityStore(database),
		handleTtlSeconds: config.HANDLE_CACHE_TTL_SECONDS,
		handleConcurrency: config.IDENTITY_CONCURRENCY,
	});

	const serviceAuth = new ServiceAuth({
		audience: [
			config.APPVIEW_DID,
			serviceId(config.APPVIEW_DID, SERVICE_FRAGMENTS.appview),
			serviceId(config.APPVIEW_DID, SERVICE_FRAGMENTS.syncer),
			serviceId(config.APPVIEW_DID, SERVICE_FRAGMENTS.notifs),
		],
		maxLifetimeSeconds: config.SERVICE_AUTH_MAX_LIFETIME_SECONDS,
		resolver: identity,
	});

	const pds = new PdsClient({ service: config.PDS_URL });
	const admin = config.PDS_ADMIN_PASSWORD
		? new PdsAdmin(pds.xrpc, { password: config.PDS_ADMIN_PASSWORD })
		: null;

	const credentials = new CommunityCredentials({
		db: database.db,
		tables: database.tables,
		secrets,
		pds,
		admin,
		log: (event, detail) => log.warn(detail, event),
	});

	const hosts = new DidDocumentSpaceHostResolver({ plcUrl: config.PLC_URL });

	const spaceCredentials = new SpaceCredentials({
		hosts,
		storage: drizzleCredentialStorage(database),
		delegation: async (space) => delegationFor(space),
		renewBeforeSeconds: 300,
	});

	const spaceClient = new SpaceClient({ hosts, credentials: spaceCredentials });

	const loader = new CommunityLoader({
		db: database.db,
		tables: database.tables,
	});

	const authzChanges = createAuthzChanges();

	const projections: ProjectionDeps = {
		db: database.db,
		tables: database.tables,
		now: () => new Date().toISOString(),
		onSkipped: (ref, reason) =>
			log.warn({ space: ref.space.uri, collection: ref.collection, reason }, "record.skipped"),
		onAuthzChanged: (change) => authzChanges.publish(change),
	};

	const writer = new CommunityWriter({
		credentials,
		mirror: { db: database.db, tables: database.tables, projections },
	});

	const sync = new SpaceSyncEngine({
		client: spaceClient,
		credentials: spaceCredentials,
		store: drizzleSyncStore(database, projections),
		hosts: {
			hostFor: async (did) => (await identity.resolveDid(did)).pds ?? config.PDS_URL,
		},
		keys: {
			signingKeyFor: async (did) => (await identity.resolveDid(did)).signingKey,
		},
		syncerService: serviceId(config.APPVIEW_DID, SERVICE_FRAGMENTS.syncer),
		concurrency: config.SYNC_WORKERS,
		workerThreads: config.SYNC_WORKER_THREADS,
		sweepIntervalMs: config.SYNC_SWEEP_SECONDS * 1000,
		log: (event, detail, level = "warn") => log[level](detail, event),
	});

	const spaces = spaceRegistry({
		database,
		onRegistered: (uri) => {
			void sync.sweepSpace(uri).catch((error) => log.warn({ space: uri, error }, "sweep.failed"));
		},
		onForgotten: (uri) => {
			sync.notifySpaceDeleted(uri);
		},
	});

	const provisioner = new CommunityProvisioner({
		pds,
		admin,
		credentials,
		spaces,
		handleDomain: config.COMMUNITY_HANDLE_DOMAIN,
		appviewService: serviceId(config.APPVIEW_DID, SERVICE_FRAGMENTS.appview),
		requiresInviteCode: config.PDS_REQUIRES_INVITE,
		...(config.COMMUNITY_EMAIL_DOMAIN ? { emailDomain: config.COMMUNITY_EMAIL_DOMAIN } : {}),
	});

	const blobs = new BlobService({
		spaceClient,
		hosts: {
			hostFor: async (did) => (await identity.resolveDid(did)).pds ?? config.PDS_URL,
		},
		cache: new BlobCache({ maxBytes: config.BLOB_CACHE_MAX_BYTES }),
	});

	const gifs = config.KLIPY_API_KEY ? createGifsClient({ apiKey: config.KLIPY_API_KEY }) : null;
	const previews = createPreviewCache();
	const artwork = createTtlCache<ArtworkEntry>({
		maxEntries: ARTWORK_CACHE_MAX_ENTRIES,
		ttlMs: ARTWORK_CACHE_TTL_MS,
	});
	const videoArtwork = config.VIDEO_ARTWORK_ENABLED ? createVideoArtworkClient({ log }) : null;

	const voice = config.VOICE_ENABLED ? await createVoiceSfu(voiceSfuConfigFromEnv()) : null;

	const didDocument = buildDidDocument(
		{ did: config.APPVIEW_DID, publicUrl: config.PUBLIC_URL },
		keypair,
	);

	async function delegationFor(space: string): Promise<string | null> {
		const authority = space.slice("at://".length).split("/")[0];
		if (!authority) return null;
		const stored = await credentials.load(authority);
		if (!stored) return null;
		const host = await credentials.connect(authority);
		return host.pds.getDelegationToken(host.session, space);
	}

	return {
		announce: silentAnnouncer as Announcer,
		voiceRoster: emptyVoiceRoster as VoiceRoster,
		authzChanges: authzChanges as AuthzChanges,
		config,
		log,
		database,
		keypair,
		identity,
		serviceAuth,
		pds,
		admin,
		credentials,
		hosts,
		spaceCredentials,
		spaceClient,
		loader,
		writer,
		spaces,
		provisioner,
		projections,
		sync,
		blobs,
		gifs,
		previews,
		artwork,
		videoArtwork,
		voice,
		didDocument,
		close: async () => {
			await sync.stop();
			await voice?.close();
			await database.close();
		},
	};
};

export type { Logger };
