import { type AdvisoryLock, holdLock, type LockHolder } from "@colibri-social/appview-db";
import { asDid, asSpaceRef } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import { lt } from "drizzle-orm";
import { ActivitySweeper } from "./activity.js";
import { busAnnouncer, type EventMessage } from "./announce.js";
import { type EventBus, memoryBus, postgresBus } from "./bus.js";
import { healCategoryOrders } from "./category-order.js";
import { describeConfig, loadConfig } from "./config.js";
import { type AppContext, createContext } from "./context.js";
import { drainGraceMs, hasPeers, waitForConnections } from "./drain.js";
import { eventDelivery } from "./event-delivery.js";
import { HandOverSweeper, hostIdentityChanged } from "./hand-overs.js";
import { healOwnerRolePermissions } from "./heal.js";
import { Jetstream } from "./jetstream.js";
import { claimClockId, MAIN_LOCK_KEY } from "./locks.js";
import { createLogger } from "./logger.js";
import { migrationJobs } from "./migrations.js";
import { connectPipeline } from "./pipeline.js";
import { healProfilePolicies } from "./profile-policies.js";
import { resyncBrokenCids } from "./resync-broken-cids.js";
import { resolveVersion } from "./routes/server.js";
import { installFatalHandlers, startErrorReporting, stopErrorReporting } from "./sentry.js";
import { createAppServer } from "./server.js";
import type { ParticipantRow } from "./voice-calls.js";
import { EventServer } from "./ws/events.js";
import { VoiceServer } from "./ws/voice.js";

const SHUTDOWN_DEADLINE_MS = 15_000;

const PRESENCE_RECONCILE_MS = 60_000;

const EVENT_PAYLOAD_TTL_MS = 10 * 60_000;

type MainJobs = {
	stop: () => Promise<void>;
};

const announceVoiceLeaves = (ctx: AppContext, rows: readonly ParticipantRow[]): void => {
	for (const row of rows) {
		ctx.announce.toCommunity(parseSpaceRef(row.channel).authority, {
			$type: "social.colibri.beta.sync.defs#voiceEvent",
			event: "leave",
			channel: asSpaceRef(row.channel),
			did: asDid(row.did),
		});
	}
};

const sweepVoiceParticipants = async (ctx: AppContext): Promise<void> => {
	announceVoiceLeaves(ctx, await ctx.voiceCalls.sweep());
};

const startMainJobs = async (ctx: AppContext, events: EventServer): Promise<MainJobs> => {
	const jetstream = new Jetstream(ctx, {
		onIdentity: (did) => {
			void hostIdentityChanged(ctx, did).catch((error: unknown) =>
				ctx.log.warn({ did, err: error }, "community.hostCheckFailed"),
			);
		},
	});
	const activities = new ActivitySweeper(ctx);
	const handOvers = new HandOverSweeper(ctx);

	await ctx.sync.start();
	await jetstream.start();
	activities.start();
	handOvers.start();

	void healOwnerRolePermissions(ctx).catch((error: unknown) =>
		ctx.log.warn({ err: error }, "heal.ownerPermissionsSweepFailed"),
	);
	void healCategoryOrders(ctx).catch((error: unknown) =>
		ctx.log.warn({ err: error }, "heal.categoryOrdersSweepFailed"),
	);
	void healProfilePolicies(ctx).catch((error: unknown) =>
		ctx.log.warn({ err: error }, "heal.profilePoliciesSweepFailed"),
	);
	void resyncBrokenCids(ctx.database, ctx.sync, ctx.log).catch((error: unknown) =>
		ctx.log.warn({ err: error }, "heal.brokenCidResyncFailed"),
	);
	void migrationJobs(ctx)
		.resume()
		.catch((error: unknown) => ctx.log.warn({ err: error }, "migration.resumeFailed"));

	const housekeeping = setInterval(() => {
		void events
			.reconcilePresence()
			.catch((error: unknown) => ctx.log.warn({ err: error }, "presence.reconcileFailed"));

		void sweepVoiceParticipants(ctx).catch((error: unknown) =>
			ctx.log.warn({ err: error }, "voice.sweepFailed"),
		);

		const { db, tables } = ctx.database;
		const before = new Date(Date.now() - EVENT_PAYLOAD_TTL_MS).toISOString();

		void db
			.delete(tables.eventPayloads)
			.where(lt(tables.eventPayloads.createdAt, before))
			.catch((error: unknown) => ctx.log.warn({ err: error }, "bus.payloadCleanupFailed"));
	}, PRESENCE_RECONCILE_MS);

	housekeeping.unref?.();

	return {
		stop: async () => {
			clearInterval(housekeeping);
			await jetstream.stop();
			await activities.stop();
			await handOvers.stop();
		},
	};
};

const main = async (): Promise<void> => {
	const config = loadConfig();
	installFatalHandlers(createLogger(config));
	const reporting = startErrorReporting(config, `appview@${resolveVersion()}`);
	const ctx = await createContext(config);
	ctx.log.info({ errorReporting: reporting ? "enabled" : "disabled" }, "config.sentry");

	for (const [name, value] of Object.entries(describeConfig(config))) {
		ctx.log.info({ [name]: value }, `config.${name}`);
	}

	const roles = new Set(config.ROLES);

	ctx.log.info({ roles: [...roles] }, "config.roles");

	const bus: EventBus<EventMessage> =
		ctx.database.dialect === "postgres"
			? await postgresBus<EventMessage>({
					url: config.DATABASE_URL,
					nodeId: ctx.nodeId,
					database: ctx.database,
					log: ctx.log,
				})
			: memoryBus<EventMessage>(ctx.nodeId, ctx.log);

	ctx.announce = busAnnouncer(bus);
	ctx.authzChanges.route((change) => bus.publish({ t: "authz", change }));

	const clockLock: AdvisoryLock | null = await claimClockId(ctx.database);

	if (!clockLock) {
		ctx.log.warn("notifications.clockIdUnclaimed");
	}

	const server = createAppServer(ctx, { api: roles.has("api") });
	const events = new EventServer(ctx);
	const voice = new VoiceServer(ctx);
	ctx.voiceRoster = voice;
	const stopDelivery = bus.subscribe(
		eventDelivery({
			ctx,
			events,
			authz: (change) => ctx.authzChanges.deliver(change),
			voice: (command) => voice.apply(command),
		}),
	);

	if (ctx.voice) {
		await ctx.voiceCalls
			.forgetNode()
			.then((rows) => announceVoiceLeaves(ctx, rows))
			.catch((error: unknown) => ctx.log.warn({ err: error }, "voice.forgetNodeFailed"));
	}
	const disconnectPipeline = connectPipeline({ ctx });

	const http = server.listen(config.PORT, () => {
		ctx.log.info({ port: config.PORT, host: config.HOST }, "listening");
	});

	if (roles.has("live")) {
		events.attach(http);
	}

	if (roles.has("voice")) {
		voice.attach(http);
	}

	let mainJobs: MainJobs | null = null;
	let mainLock: LockHolder | null = null;
	let shuttingDown = false;
	let skipDrain: () => void = () => {};

	const drainSkipped = new Promise<void>((resolve) => {
		skipDrain = resolve;
	});

	const step = async (name: string, run: () => unknown): Promise<void> => {
		try {
			await run();
		} catch (error) {
			ctx.log.error({ step: name, err: error }, "shutdown.step-failed");
		}
	};

	const connectionCount = () => {
		return events.connectionCount + voice.connectionCount;
	};

	const drain = async (): Promise<void> => {
		const peers = await hasPeers(ctx.database, ctx.nodeId).catch((error: unknown) => {
			ctx.log.warn({ err: error }, "drain.peerCheckFailed");

			return false;
		});
		const graceMs = drainGraceMs(config.DRAIN_GRACE_MINUTES, peers);
		const deadline = new Date(Date.now() + graceMs);

		ctx.drain.begin(deadline);
		events.announceDrain(deadline);
		void voice
			.beginMigration(deadline)
			.catch((error: unknown) => ctx.log.error({ err: error }, "voice.migrationFailed"));

		ctx.log.info(
			{ peers, graceMs, deadline: deadline.toISOString(), connections: connectionCount() },
			"drain.started",
		);

		const outcome = await waitForConnections({
			count: connectionCount,
			deadline,
			skip: drainSkipped,
		});

		ctx.log.info({ outcome, connections: connectionCount() }, "drain.finished");
	};

	const shutdown = async (signal: string, exitCode = 0) => {
		if (shuttingDown) {
			ctx.log.warn({ signal }, "drain.skipped");
			skipDrain();

			return;
		}
		shuttingDown = true;

		ctx.log.info(
			{
				signal,
				connections: events.connectionCount,
				voiceConnections: voice.connectionCount,
			},
			"shutting down",
		);

		if (exitCode === 0) {
			await step("drain", () => drain());
		}

		const deadline = setTimeout(() => {
			ctx.log.error({ deadlineMs: SHUTDOWN_DEADLINE_MS }, "shutdown.deadline-exceeded");
			process.exit(1);
		}, SHUTDOWN_DEADLINE_MS);

		await step("pipeline", () => disconnectPipeline());
		await step("error-reporting", () => stopErrorReporting());
		await step("main-jobs", () => mainJobs?.stop());
		await step("main-lock", () => mainLock?.stop());
		await step("events", () => events.close());
		await step("bus", async () => {
			stopDelivery();
			await bus.close();
		});
		await step("clock", () => clockLock?.release());
		await step("voice", () => voice.close());
		await step("http", () => http.close());
		await step("context", () => ctx.close());

		clearTimeout(deadline);
		process.exit(exitCode);
	};

	if (roles.has("main")) {
		mainLock = holdLock({
			lock: ctx.database.advisoryLock(MAIN_LOCK_KEY),
			onAcquired: async () => {
				ctx.log.info("main.acquired");
				mainJobs = await startMainJobs(ctx, events);
			},
			onLost: (error) => {
				ctx.log.error({ err: error }, "main.lost");
				void shutdown("main-lock-lost", 1);
			},
			onRetryFailed: (error) => {
				ctx.log.warn({ err: error }, "main.acquireFailed");
			},
		});
	}

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
};

await main();
