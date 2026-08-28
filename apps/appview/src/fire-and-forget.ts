import type { Logger } from "./logger.js";

export const fireAndForget = (
	log: Logger,
	event: string,
	run: () => Promise<unknown>,
	detail: Record<string, unknown> = {},
): void => {
	try {
		void run().catch((error: unknown) => {
			log.error({ ...detail, err: error }, event);
		});
	} catch (error) {
		log.error({ ...detail, err: error }, event);
	}
};
