import { holdLock, type LockHolder } from "@colibri-social/appview-db";
import { ActivitySweeper } from "./activity.js";
import { eventAnnouncer } from "./announce.js";
import { healCategoryOrders } from "./category-order.js";
import { describeConfig, loadConfig } from "./config.js";
import { type AppContext, createContext } from "./context.js";
import { drainGraceMs, hasPeers, waitForConnections } from "./drain.js";
import { HandOverSweeper, hostIdentityChanged } from "./hand-overs.js";
import { healOwnerRolePermissions } from "./heal.js";
import { Jetstream } from "./jetstream.js";
import { MAIN_LOCK_KEY } from "./locks.js";
import { createLogger } from "./logger.js";
import { migrationJobs } from "./migrations.js";
import { connectPipeline } from "./pipeline.js";
import { healProfilePolicies } from "./profile-policies.js";
import { resyncBrokenCids } from "./resync-broken-cids.js";
import { resolveVersion } from "./routes/server.js";
import { installFatalHandlers, startErrorReporting, stopErrorReporting } from "./sentry.js";
import { createAppServer } from "./server.js";
import { EventServer } from "./ws/events.js";
import { VoiceServer } from "./ws/voice.js";

const SHUTDOWN_DEADLINE_MS = 15_000;

type MainJobs = {
	stop: () => Promise<void>;
};

const startMainJobs = async (ctx: AppContext): Promise<MainJobs> => {
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

	return {
		stop: async () => {
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

	const server = createAppServer(ctx, { api: roles.has("api") });
	const events = new EventServer(ctx);
	ctx.announce = eventAnnouncer(events);
	const voice = new VoiceServer(ctx, events);
	ctx.voiceRoster = voice;
	const disconnectPipeline = connectPipeline({ ctx, events });

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
		const peers = await hasPeers(ctx.database, config.NODE_ID).catch((error: unknown) => {
			ctx.log.warn({ err: error }, "drain.peerCheckFailed");

			return false;
		});
		const graceMs = drainGraceMs(config.DRAIN_GRACE_MINUTES, peers);
		const deadline = new Date(Date.now() + graceMs);

		ctx.drain.begin(deadline);
		events.announceDrain(deadline);

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
				mainJobs = await startMainJobs(ctx);
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
