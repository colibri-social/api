import type { MessageView } from "./announce.js";
import type { AppContext } from "./context.js";
import { fireAndForget } from "./fire-and-forget.js";
import type { ChannelViews, LatePreviewTarget } from "./views/channel.js";

const settling = new Set<string>();

export const republishWhenPreviewsSettle = (
	ctx: AppContext,
	channels: ChannelViews,
	publish: (space: string, message: MessageView) => void,
	target: LatePreviewTarget,
	unresolved: readonly string[],
): void => {
	if (unresolved.length === 0) return;
	const key = `${target.readingSpace} ${target.author} ${target.rkey}`;
	if (settling.has(key)) return;
	settling.add(key);
	const message = { author: target.author, rkey: target.rkey };
	fireAndForget(
		ctx.log,
		"sync.embedRepublishFailed",
		async () => {
			try {
				await ctx.linkEmbeds.settle([...unresolved]);
				if (!unresolved.some((uri) => ctx.linkEmbeds.peek(uri))) return;
				const enriched = await channels.message(target.space, null, message, target.readingSpace, {
					embedWaitMs: 0,
				});
				if (!enriched) return;
				publish(target.readingSpace, enriched);
			} finally {
				settling.delete(key);
			}
		},
		{ space: target.readingSpace, ...message },
	);
};
