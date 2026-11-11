import * as Sentry from "@sentry/node";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

const FLUSH_TIMEOUT_MS = 2000;

let reporting = false;
let fatalLogger: Logger | undefined;
let handlingFatal = false;

export const SLOW_TRANSACTION_SECONDS = 1;

type TransactionLike = {
	start_timestamp?: number;
	timestamp?: number;
	contexts?: { trace?: { status?: string; data?: Record<string, unknown> } };
};

export const skipsTracing = (name: string, attributes: Record<string, unknown> = {}): boolean => {
	const path = String(attributes["url.path"] ?? attributes["http.target"] ?? "");

	return name.endsWith("/health") || path === "/health" || path.startsWith("/health?");
};

export const keepsTransaction = (
	event: TransactionLike,
	sampleRate: number,
	random: () => number = Math.random,
): boolean => {
	const duration = (event.timestamp ?? 0) - (event.start_timestamp ?? 0);
	const trace = event.contexts?.trace;
	const code = Number(trace?.data?.["http.response.status_code"] ?? 0);
	const failed =
		code >= 500 ||
		(code === 0 &&
			trace?.status !== undefined &&
			trace.status !== "ok" &&
			trace.status !== "unset");

	return failed || duration >= SLOW_TRANSACTION_SECONDS || random() < sampleRate;
};

export const startErrorReporting = (config: Config, release: string): boolean => {
	if (!config.SENTRY_DSN) return false;

	Sentry.init({
		dsn: config.SENTRY_DSN,
		environment: config.NODE_ENV,
		release,
		sendDefaultPii: false,
		enableLogs: true,
		integrations: [Sentry.pinoIntegration({ log: { levels: ["info", "warn", "error", "fatal"] } })],
		tracesSampler: ({ name, attributes }) => {
			return skipsTracing(name, attributes ?? {}) ? 0 : 1;
		},
		beforeSendTransaction: (event) => {
			return keepsTransaction(event, config.SENTRY_TRACES_SAMPLE_RATE) ? event : null;
		},
	});
	Sentry.setTag("appview.flavor", config.APPVIEW_FLAVOR);
	Sentry.setTag("appview.did", config.APPVIEW_DID);

	if (config.NODE_ID) {
		Sentry.setTag("node.id", config.NODE_ID);
		Sentry.setTag("node.region", config.NODE_REGION ?? "default");
		Sentry.setTag("node.roles", config.ROLES.join(","));
	}

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
