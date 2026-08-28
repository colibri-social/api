import * as Sentry from "@sentry/node";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

const FLUSH_TIMEOUT_MS = 2000;

let reporting = false;
let fatalLogger: Logger | undefined;
let handlingFatal = false;

export const startErrorReporting = (config: Config, release: string): boolean => {
	if (!config.SENTRY_DSN) return false;

	Sentry.init({
		dsn: config.SENTRY_DSN,
		environment: config.NODE_ENV,
		release,
		tracesSampleRate: 0,
		sendDefaultPii: false,
	});
	Sentry.setTag("appview.flavor", config.APPVIEW_FLAVOR);
	Sentry.setTag("appview.did", config.APPVIEW_DID);

	reporting = true;
	return true;
};

const onFatal = async (error: unknown, stage: string): Promise<never> => {
	if (handlingFatal) return process.exit(1);
	handlingFatal = true;

	fatalLogger?.fatal({ err: error, stage }, "fatal");

	if (reporting) {
		Sentry.captureException(error, { tags: { stage } });
		await Sentry.close(FLUSH_TIMEOUT_MS).catch(() => undefined);
	}

	return process.exit(1);
};

export const installFatalHandlers = (logger: Logger): void => {
	fatalLogger = logger;
	process.on("uncaughtException", (error) => void onFatal(error, "uncaughtException"));
	process.on("unhandledRejection", (reason) => void onFatal(reason, "unhandledRejection"));
};

export const reportFailure = (
	error: unknown,
	context: { stage: string } & Record<string, string | number | undefined>,
): void => {
	if (!reporting) return;
	const { stage, ...rest } = context;
	Sentry.captureException(error, {
		tags: Object.fromEntries(
			Object.entries({ stage, ...rest }).filter(([, value]) => value !== undefined),
		) as Record<string, string | number>,
	});
};

export const stopErrorReporting = async (): Promise<void> => {
	if (!reporting) return;
	reporting = false;
	await Sentry.close(FLUSH_TIMEOUT_MS).catch(() => undefined);
};
