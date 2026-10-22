import type { AppContext } from "./context.js";
import { fireAndForget } from "./fire-and-forget.js";
import type { ChannelViews, LatePreviewTarget } from "./views/channel.js";
import type { ChannelFrame } from "./ws/events.js";

const settling = new Set<string>();

export const republishWhenPreviewsSettle = (
	ctx: AppContext,
	channels: ChannelViews,
	publish: (space: string, frame: ChannelFrame) => void,
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
				publish(target.readingSpace, (viewer) => ({
					$type: "social.colibri.beta.sync.defs#messageEvent",
					event: "update",
					channel: target.readingSpace,
					message: channels.forViewer(enriched, viewer),
				}));
			} finally {
				settling.delete(key);
			}
		},
		{ space: target.readingSpace, ...message },
	);
};
