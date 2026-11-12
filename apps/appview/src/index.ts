import type { AdvisoryLock } from "@colibri-social/appview-db";
import { asDid, asSpaceRef } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import type { VoiceSfuStats } from "@colibri-social/voice";
import { lt } from "drizzle-orm";
import { ActivitySweeper } from "./activity.js";
import { busAnnouncer, type EventMessage } from "./announce.js";
import { type EventBus, memoryBus, postgresBus } from "./bus.js";
import { healCategoryOrders } from "./category-order.js";
import { resolveClusterEnv } from "./cluster/boot.js";
import { createMainRole } from "./cluster/main-role.js";
import { type ClusterNode, startClusterNode } from "./cluster/node.js";
import { parkedState } from "./cluster/orders.js";
import type { DrainMode } from "./cluster/protocol.js";
import { describeConfig, loadConfig } from "./config.js";
import { type AppContext, createContext } from "./context.js";
import { drainGraceMs, hasPeers, waitForConnections } from "./drain.js";
import { eventDelivery } from "./event-delivery.js";
import { HandOverSweeper, hostIdentityChanged } from "./hand-overs.js";
import { healOwnerRolePermissions } from "./heal.js";
import { Jetstream } from "./jetstream.js";
import { claimClockId, MAIN_LOCK_KEY, migrateUnderLock } from "./locks.js";
import { createLogger } from "./logger.js";
import { observe, startMetrics } from "./metrics.js";
import { migrationJobs } from "./migrations.js";
import { NotificationPruner } from "./notification-prune.js";
import { connectPipeline } from "./pipeline.js";
import { healProfilePolicies } from "./profile-policies.js";
import { resyncBrokenCids } from "./resync-broken-cids.js";
import { resolveVersion } from "./routes/server.js";
import { installFatalHandlers, startErrorReporting, stopErrorReporting } from "./sentry.js";
import { createAppServer } from "./server.js";
import { startTelemetry } from "./telemetry.js";
import type { ParticipantRow } from "./voice-calls.js";
import { EventServer } from "./ws/events.js";
import { VoiceServer } from "./ws/voice.js";

const SHUTDOWN_DEADLINE_MS = 15_000;

const UPDATE_HOLD_MS = 15 * 60_000;

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
	const notificationPruner = new NotificationPruner(ctx);

	await ctx.sync.start();
	await jetstream.start();
	activities.start();
	handOvers.start();
	notificationPruner.start();

	const telemetry = startTelemetry({
		database: ctx.database,
		log: ctx.log,
		enabled: ctx.config.telemetryEnabled,
		url: ctx.config.COLIBRI_TELEMETRY_URL,
		version: resolveVersion(),
		flavor: ctx.config.APPVIEW_FLAVOR,
		roles: ctx.config.ROLES,
		voice: ctx.config.VOICE_ENABLED,
		nodes: async () =>
			ctx.clustered
				? (await ctx.registry.list()).filter((node) => node.state !== "retired").length
				: 1,
	});

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
			notificationPruner.stop();
			telemetry.stop();
			await jetstream.stop();
			await activities.stop();
			await handOvers.stop();
		},
	};
};

const WRITE_MODES = { normal: 0, queued: 1, readOnly: 2 } as const;

const VOICE_STATS_TTL_MS = 5_000;

const observeNode = (ctx: AppContext, events: EventServer, voice: VoiceServer): void => {
	let voiceStats: { at: number; stats: Promise<VoiceSfuStats | null> } | null = null;

	const sfuStats = (): Promise<VoiceSfuStats | null> => {
		if (!ctx.voice) {
			return Promise.resolve(null);
		}

		if (!voiceStats || Date.now() - voiceStats.at > VOICE_STATS_TTL_MS) {
			voiceStats = { at: Date.now(), stats: ctx.voice.stats().catch(() => null) };
		}

		return voiceStats.stats;
	};

	const version = resolveVersion();

	observe("buildInfo", () => [{ value: 1, attributes: { version } }]);
	observe("connections", () => [
		{ value: events.connectionCount, attributes: { kind: "events" } },
		{ value: voice.connectionCount, attributes: { kind: "voice" } },
	]);
	observe("drainState", () => [{ value: ctx.drain.parked ? 2 : ctx.drain.draining ? 1 : 0 }]);
	observe("writeMode", () => [{ value: WRITE_MODES[ctx.writeProxy?.mode ?? "normal"] }]);
	observe("writeQueue", () => [{ value: ctx.writeProxy?.waiting ?? 0 }]);

	if (!ctx.voice) {
		return;
	}

	observe("voiceCalls", async () => [{ value: (await sfuStats())?.calls ?? 0 }]);
	observe("voiceParticipants", async () => [{ value: (await sfuStats())?.participants ?? 0 }]);
	observe("sfuWorkerCpu", async () =>
		((await sfuStats())?.workers ?? []).map((usage) => ({
			value: usage.cpuSeconds,
			attributes: { worker: usage.worker },
		})),
	);
	observe("sfuBitrate", async () => {
		const transports = (await sfuStats())?.transports ?? [];

		return [
			{
				value: transports.reduce((total, sample) => total + sample.recvBitrate, 0),
				attributes: { direction: "in" },
			},
			{
				value: transports.reduce((total, sample) => total + sample.sendBitrate, 0),
				attributes: { direction: "out" },
			},
		];
	});
	observe("sfuPacketLoss", async () => {
		const transports = (await sfuStats())?.transports ?? [];

		return [
			{
				value: Math.max(0, ...transports.map((sample) => sample.lossReceived)),
				attributes: { direction: "in" },
			},
			{
				value: Math.max(0, ...transports.map((sample) => sample.lossSent)),
				attributes: { direction: "out" },
			},
		];
	});
	observe("sfuTransports", async () => {
		const states = new Map<string, number>();

		for (const sample of (await sfuStats())?.transports ?? []) {
			states.set(sample.iceState, (states.get(sample.iceState) ?? 0) + 1);
		}

		return [...states].map(([state, value]) => ({ value, attributes: { ice: state } }));
	});
};

const main = async (): Promise<void> => {
	const config = loadConfig(
		await resolveClusterEnv(process.env, {
			log: (message) => process.stderr.write(`cluster: ${message}\n`),
		}),
	);
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

	let holdsMain = false;
	let yieldMainTo: (target: string) => Promise<boolean> = async () => false;
	let cluster: ClusterNode | null = null;
	let onDrainOrder: (mode: DrainMode, graceMinutes: number | undefined) => void = () => {};
	let onResumeOrder: () => void = () => {};

	cluster = await startClusterNode({
		ctx,
		roles,
		isMain: () => holdsMain,
		load: () => ({
			connections: events.connectionCount + voice.connectionCount,
			activeCalls: ctx.voice?.channels.length ?? 0,
		}),
		onDrain: (mode, graceMinutes) => onDrainOrder(mode, graceMinutes),
		onResume: () => onResumeOrder(),
		onWriteMode: (mode) => events.announceWriteState(mode),
		yieldMain: (target) => yieldMainTo(target),
		app: server.router,
	});

	const metricsHandle =
		config.METRICS_PORT > 0
			? startMetrics({
					host: config.METRICS_HOST,
					port: config.METRICS_PORT,
					attributes: { node: ctx.nodeId, region: config.NODE_REGION ?? "default" },
				})
			: null;

	observeNode(ctx, events, voice);

	if (cluster?.parked) {
		ctx.drain.park();
		ctx.log.warn({ node: ctx.nodeId }, "node.parked");
	}

	const stopDelivery = bus.subscribe(
		eventDelivery({
			ctx,
			events,
			authz: (change) => ctx.authzChanges.deliver(change),
			voice: (command) => voice.apply(command),
			cluster: async (order) => cluster?.order(order),
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

	if (roles.has("live") && !ctx.drain.parked) {
		events.attach(http);
	}

	if (roles.has("voice") && !ctx.drain.parked) {
		voice.attach(http);
	}

	let mainJobs: MainJobs | null = null;
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

	const drain = async (graceMinutes = config.DRAIN_GRACE_MINUTES): Promise<void> => {
		const peers = await hasPeers(ctx.database, ctx.nodeId).catch((error: unknown) => {
			ctx.log.warn({ err: error }, "drain.peerCheckFailed");

			return false;
		});
		const graceMs = drainGraceMs(graceMinutes, peers);
		const deadline = new Date(Date.now() + graceMs);
		const wasParked = ctx.drain.parked;

		ctx.drain.begin(deadline);

		await step("main-lock", () => mainRole.pause());

		if (!wasParked) {
			await cluster
				?.setState("draining", deadline)
				.catch((error: unknown) => ctx.log.warn({ err: error }, "cluster.stateFailed"));
		}

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

		await step("cluster", async () => {
			if (!ctx.drain.parked) await cluster?.setState("down", null);
			await cluster?.stop();
		});
		await step("pipeline", () => disconnectPipeline());
		await step("error-reporting", () => stopErrorReporting());
		await step("main-lock", () => mainRole.stop());
		await step("events", () => events.close());
		await step("bus", async () => {
			stopDelivery();
			await bus.close();
		});
		await step("clock", () => clockLock?.release());
		await step("voice", () => voice.close());
		await step("http", () => http.close());
		await step("metrics", () => metricsHandle?.stop());
		await step("context", () => ctx.close());

		clearTimeout(deadline);
		process.exit(exitCode);
	};

	const mainRole = createMainRole({
		lock: () => ctx.database.advisoryLock(MAIN_LOCK_KEY),
		canContend: () => !shuttingDown && !ctx.drain.draining,
		mayAcquire: () => cluster?.mayTakeMain() ?? Promise.resolve(true),
		invite: (target) => cluster?.inviteToMain(target),
		mainNode: async () => (await ctx.registry.mainNode())?.id ?? null,
		onAcquired: async () => {
			const migrated = await migrateUnderLock(ctx.database).catch((error: unknown) => {
				ctx.log.error({ err: error }, "migrations.failed");

				return null;
			});

			if (migrated === null) {
				void shutdown("migrations-failed", 1);

				return;
			}

			if (!migrated) {
				ctx.log.warn("migrations.deferredReadOnly");
			}

			holdsMain = true;
			await cluster
				?.becameMain()
				.catch((error: unknown) => ctx.log.warn({ err: error }, "cluster.claimMainFailed"));
			mainJobs = await startMainJobs(ctx, events);
		},
		onReleasing: async () => {
			holdsMain = false;
			cluster?.releasedMain();
			await step("main-jobs", () => mainJobs?.stop());
			mainJobs = null;
		},
		onLost: (error) => {
			holdsMain = false;
			ctx.log.error({ err: error }, "main.lost");
			void shutdown("main-lock-lost", 1);
		},
		log: ctx.log,
	});

	yieldMainTo = (target) => mainRole.yieldTo(target);

	if (roles.has("main") || roles.has("failover")) {
		mainRole.contend();
	}

	let parking = false;

	onDrainOrder = (mode, graceMinutes) => {
		if (parking || shuttingDown) {
			return;
		}

		parking = true;
		ctx.log.info({ mode, graceMinutes }, "node.parking");

		void (async () => {
			await step("drain", () => drain(graceMinutes));
			await step("events", () => events.close());
			await step("voice", () => voice.close());
			ctx.drain.park();

			if (mode === "update") {
				cluster?.report({ t: "drained", mode });
				ctx.log.info({ holdMs: UPDATE_HOLD_MS }, "node.awaitingUpdate");
				setTimeout(() => void shutdown("update-hold"), UPDATE_HOLD_MS).unref();

				return;
			}

			await step("park", () => cluster?.setState(parkedState(mode), null));
			cluster?.report({ t: "drained", mode });
			ctx.log.info({ mode }, "node.parked");
		})();
	};

	onResumeOrder = () => {
		ctx.log.info("node.resuming");
		void shutdown("resume");
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
};

await main();
