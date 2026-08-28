import { ActivitySweeper } from "./activity.js";
import { eventAnnouncer } from "./announce.js";
import { describeConfig, loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { Jetstream } from "./jetstream.js";
import { createLogger } from "./logger.js";
import { connectPipeline } from "./pipeline.js";
import { resolveVersion } from "./routes/server.js";
import { installFatalHandlers, startErrorReporting, stopErrorReporting } from "./sentry.js";
import { createAppServer } from "./server.js";
import { EventServer } from "./ws/events.js";
import { VoiceServer } from "./ws/voice.js";

const SHUTDOWN_DEADLINE_MS = 15_000;

const main = async (): Promise<void> => {
	const config = loadConfig();
	installFatalHandlers(createLogger(config));
	const reporting = startErrorReporting(config, `appview@${resolveVersion()}`);
	const ctx = await createContext(config);
	ctx.log.info({ errorReporting: reporting ? "enabled" : "disabled" }, "config.sentry");

	for (const [name, value] of Object.entries(describeConfig(config))) {
		ctx.log.info({ [name]: value }, `config.${name}`);
	}

	const server = createAppServer(ctx);
	const events = new EventServer(ctx);
	ctx.announce = eventAnnouncer(events);
	const voice = new VoiceServer(ctx, events);
	ctx.voiceRoster = voice;
	const disconnectPipeline = connectPipeline({ ctx, events });

	const jetstream = new Jetstream(ctx);
	const activities = new ActivitySweeper(ctx);

	const http = server.listen(config.PORT, () => {
		ctx.log.info({ port: config.PORT, host: config.HOST }, "listening");
	});
	events.attach(http);
	voice.attach(http);

	await ctx.sync.start();
	await jetstream.start();
	activities.start();

	let shuttingDown = false;

	const step = async (name: string, run: () => unknown): Promise<void> => {
		try {
			await run();
		} catch (error) {
			ctx.log.error({ step: name, err: error }, "shutdown.step-failed");
		}
	};

	const shutdown = async (signal: string) => {
		if (shuttingDown) {
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

		const deadline = setTimeout(() => {
			ctx.log.error({ deadlineMs: SHUTDOWN_DEADLINE_MS }, "shutdown.deadline-exceeded");
			process.exit(1);
		}, SHUTDOWN_DEADLINE_MS);

		await step("pipeline", () => disconnectPipeline());
		await step("error-reporting", () => stopErrorReporting());
		await step("jetstream", () => jetstream.stop());
		await step("activities", () => activities.stop());
		await step("events", () => events.close());
		await step("voice", () => voice.close());
		await step("http", () => http.close());
		await step("context", () => ctx.close());

		clearTimeout(deadline);
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
};

await main();
