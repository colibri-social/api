import { eventAnnouncer } from "./announce.js";
import { describeConfig, loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { Jetstream } from "./jetstream.js";
import { connectPipeline } from "./pipeline.js";
import { resolveVersion } from "./routes/server.js";
import { startErrorReporting, stopErrorReporting } from "./sentry.js";
import { createAppServer } from "./server.js";
import { EventServer } from "./ws/events.js";
import { VoiceServer } from "./ws/voice.js";

const main = async (): Promise<void> => {
	const config = loadConfig();
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
	const disconnectPipeline = connectPipeline({ ctx, events });

	const jetstream = new Jetstream(ctx);

	const http = server.listen(config.PORT, () => {
		ctx.log.info({ port: config.PORT, host: config.HOST }, "listening");
	});
	events.attach(http);
	voice.attach(http);

	await ctx.sync.start();
	await jetstream.start();

	const shutdown = async (signal: string) => {
		ctx.log.info(
			{
				signal,
				connections: events.connectionCount,
				voiceConnections: voice.connectionCount,
			},
			"shutting down",
		);
		disconnectPipeline();
		await stopErrorReporting();
		await jetstream.stop();
		await events.close();
		await voice.close();
		http.close();
		await ctx.close();
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
};

await main();
