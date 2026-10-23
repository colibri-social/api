import type { AppContext } from "./context.js";

const HAND_OVER_SWEEP_MS = 60_000;

export const expireHandOvers = async (ctx: AppContext): Promise<void> => {
	const { reset, moved } = await ctx.credentials.expireHandOvers();
	for (const community of reset) ctx.log.info({ community }, "handOver.reset");
	for (const community of moved) ctx.log.info({ community }, "handOver.moved");
};

export const hostIdentityChanged = async (ctx: AppContext, did: string): Promise<void> => {
	if (!(await ctx.credentials.has(did))) return;
	await ctx.identity.resolveDid(did, true).catch(() => undefined);
	if (await ctx.credentials.hostChanged(did)) {
		ctx.log.info({ community: did }, "community.hostChanged");
	}
};

export class HandOverSweeper {
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly ctx: AppContext,
		private readonly intervalMs = HAND_OVER_SWEEP_MS,
	) {}

	start(): void {
		if (this.timer) return;
		const run = () =>
			void expireHandOvers(this.ctx).catch((error: unknown) =>
				this.ctx.log.warn({ err: error }, "handOver.sweepFailed"),
			);
		run();
		this.timer = setInterval(run, this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}
}
