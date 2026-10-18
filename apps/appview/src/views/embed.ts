import type { EmbedAuthor, EmbedMedia, LinkEmbed, RichBlock } from "@colibri-social/embeds";
import {
	asDatetimeOrUndefined,
	asUri,
	asUriOrUndefined,
	type social,
} from "@colibri-social/lexicons";
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

	const media = (item: EmbedMedia) => ({
		kind: item.kind,
		url: asUri(proxied(item.kind === "image" ? "image" : "video", item.url)),
		previewUrl: item.previewUrl ? asUri(proxied("image", item.previewUrl)) : undefined,
		mimeType: item.mimeType,
		width: item.width,
		height: item.height,
		alt: item.alt,
	});
	const author = (value: EmbedAuthor) => ({
		name: value.name,
		handle: value.handle,
		url: asUriOrUndefined(value.url),
		avatar: value.avatar ? asUri(proxied("image", value.avatar)) : undefined,
	});
	const post = embed.post;
	const quote = post?.quote;

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
		themeColor: embed.themeColor,
		layout: embed.layout,
		provider: embed.provider
			? {
					name: embed.provider.name,
					url: asUriOrUndefined(embed.provider.url),
					icon: embed.provider.icon ? asUri(proxied("image", embed.provider.icon)) : undefined,
				}
			: undefined,
		author: embed.author ? author(embed.author) : undefined,
		publishedAt: asDatetimeOrUndefined(embed.publishedAt),
		media: embed.media?.map(media),
		post: post
			? {
					body: post.body.map(richBlock),
					sensitive: post.sensitive,
					contentWarning: post.contentWarning,
					stats: post.stats,
					translatedFrom: post.translatedFrom,
					quote: quote
						? {
								uri: asUri(quote.uri),
								author: author(quote.author),
								body: quote.body.map(richBlock),
								media: quote.media?.map(media),
								publishedAt: asDatetimeOrUndefined(quote.publishedAt),
								translatedFrom: quote.translatedFrom,
							}
						: undefined,
				}
			: undefined,
	};
};

const richBlock = (block: RichBlock) => ({
	kind: block.kind,
	spans: block.spans.map((span) => ({
		text: span.text,
		bold: span.bold,
		italic: span.italic,
		href: asUriOrUndefined(span.href),
	})),
});
