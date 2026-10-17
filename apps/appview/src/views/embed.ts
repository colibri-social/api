import type { LinkEmbed } from "@colibri-social/embeds";
import { asUri, type social } from "@colibri-social/lexicons";
import type { AppContext } from "../context.js";
import { type EmbedMediaKind, embedMediaUrl } from "../embed-token.js";

export type LinkEmbedView = social.colibri.beta.embed.defs.LinkEmbed;

export const toLinkEmbedView = (
	ctx: Pick<AppContext, "config">,
	embed: LinkEmbed,
	uri: string = embed.uri,
): LinkEmbedView => {
	const nowSeconds = Math.floor(Date.now() / 1000);
	const proxied = (kind: EmbedMediaKind, target: string): string =>
		embedMediaUrl(
			{
				publicUrl: ctx.config.PUBLIC_URL,
				signingKey: ctx.config.SIGNING_KEY,
				nowSeconds,
			},
			kind,
			target,
		);

	return {
		uri: asUri(uri),
		title: embed.title,
		description: embed.description,
		siteName: embed.siteName,
		image: embed.image
			? {
					url: asUri(proxied("image", embed.image.url)),
					width: embed.image.width,
					height: embed.image.height,
					alt: embed.image.alt,
				}
			: undefined,
		video: embed.video
			? {
					url: asUri(proxied("video", embed.video.url)),
					mimeType: embed.video.mimeType,
					width: embed.video.width,
					height: embed.video.height,
					duration: embed.video.duration,
				}
			: undefined,
	};
};
