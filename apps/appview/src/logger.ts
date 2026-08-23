import { pino } from "pino";
import type { Config } from "./config.js";

export type Logger = ReturnType<typeof createLogger>;

export const createLogger = (config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">) =>
	pino({
		level: config.LOG_LEVEL,
		...(config.NODE_ENV === "development"
			? { transport: { target: "pino-pretty", options: { colorize: true } } }
			: {}),
	});
