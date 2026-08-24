import * as Sentry from "@sentry/node";
import type { Config } from "./config.js";

let reporting = false;

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

	process.on("unhandledRejection", (reason) => {
		Sentry.captureException(reason, { tags: { stage: "unhandledRejection" } });
	});
	process.on("uncaughtException", (error) => {
		Sentry.captureException(error, { tags: { stage: "uncaughtException" } });
	});

	reporting = true;
	return true;
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
	await Sentry.close(2000).catch(() => undefined);
};
