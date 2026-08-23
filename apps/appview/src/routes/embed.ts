import { InvalidRequestError } from "@atproto/xrpc-server";
import type { EmbedError, GifCategory, GifView, LinkEmbed, TtlCache } from "@colibri-social/embeds";
import { fetchLinkPreview, gifsNotConfigured, isEmbedError } from "@colibri-social/embeds";
import { asUri, asUriOrUndefined, social } from "@colibri-social/lexicons";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import type { RouteDeps } from "./types.js";

type LinkEmbedView = social.colibri.beta.embed.defs.LinkEmbed;
type GifViewOut = social.colibri.beta.embed.defs.GifView;
type GifCategoryOut = social.colibri.beta.embed.defs.GifCategory;

const embedErrorToXrpc = (error: EmbedError): InvalidRequestError =>
	new InvalidRequestError(error.reason, error.code);

const toLinkEmbedView = (embed: LinkEmbed): LinkEmbedView => ({
	uri: asUri(embed.uri),
	title: embed.title,
	description: embed.description,
	siteName: embed.siteName,
	image: embed.image
		? {
				url: asUri(embed.image.url),
				width: embed.image.width,
				height: embed.image.height,
				alt: embed.image.alt,
			}
		: undefined,
	video: embed.video
		? {
				url: asUri(embed.video.url),
				mimeType: embed.video.mimeType,
				width: embed.video.width,
				height: embed.video.height,
				duration: embed.video.duration,
			}
		: undefined,
});

const toGifView = (gif: GifView): GifViewOut => ({
	id: gif.id,
	url: asUri(gif.url),
	previewUrl: asUri(gif.previewUrl),
	width: gif.width,
	height: gif.height,
	title: gif.title,
});

const toGifCategory = (category: GifCategory): GifCategoryOut => ({
	name: category.name,
	previewUrl: asUriOrUndefined(category.previewUrl),
});

const requireGifs = (ctx: AppContext) => {
	if (!ctx.gifs) throw embedErrorToXrpc(gifsNotConfigured());
	return ctx.gifs;
};

export const handleGetMetadata = async (
	ctx: AppContext,
	uri: string,
): Promise<{ embed: LinkEmbedView }> => {
	try {
		const cache = ctx.previews as unknown as TtlCache<LinkEmbed>;
		const embed = await fetchLinkPreview(uri, { cache });
		return { embed: toLinkEmbedView(embed) };
	} catch (cause) {
		if (isEmbedError(cause)) throw embedErrorToXrpc(cause);
		throw cause;
	}
};

export const handleSearchGifs = async (
	ctx: AppContext,
	q: string,
	options: { limit?: number; cursor?: string },
): Promise<{ gifs: GifViewOut[]; cursor?: string }> => {
	const gifs = requireGifs(ctx);
	try {
		const page = await gifs.searchGifs(q, options);
		return { gifs: page.gifs.map(toGifView), cursor: page.cursor };
	} catch (cause) {
		if (isEmbedError(cause)) throw embedErrorToXrpc(cause);
		throw cause;
	}
};

export const handleTrendingGifs = async (
	ctx: AppContext,
	options: { limit?: number; cursor?: string },
): Promise<{ gifs: GifViewOut[]; cursor?: string }> => {
	const gifs = requireGifs(ctx);
	try {
		const page = await gifs.trendingGifs(options);
		return { gifs: page.gifs.map(toGifView), cursor: page.cursor };
	} catch (cause) {
		if (isEmbedError(cause)) throw embedErrorToXrpc(cause);
		throw cause;
	}
};

export const handleGifCategories = async (
	ctx: AppContext,
): Promise<{ categories: GifCategoryOut[] }> => {
	const gifs = requireGifs(ctx);
	try {
		const categories = await gifs.gifCategories();
		return { categories: categories.map(toGifCategory) };
	} catch (cause) {
		if (isEmbedError(cause)) throw embedErrorToXrpc(cause);
		throw cause;
	}
};

export const registerEmbedRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	route(server, social.colibri.beta.embed.getMetadata, {
		auth: auth.required,
		handler: async ({ params }) => ({
			encoding: "application/json" as const,
			body: await handleGetMetadata(ctx, params.uri),
		}),
	});

	route(server, social.colibri.beta.embed.searchGifs, {
		auth: auth.required,
		handler: async ({ params }) => ({
			encoding: "application/json" as const,
			body: await handleSearchGifs(ctx, params.q, { limit: params.limit, cursor: params.cursor }),
		}),
	});

	route(server, social.colibri.beta.embed.trendingGifs, {
		auth: auth.required,
		handler: async ({ params }) => ({
			encoding: "application/json" as const,
			body: await handleTrendingGifs(ctx, { limit: params.limit, cursor: params.cursor }),
		}),
	});

	route(server, social.colibri.beta.embed.gifCategories, {
		auth: auth.required,
		handler: async () => ({
			encoding: "application/json" as const,
			body: await handleGifCategories(ctx),
		}),
	});
};
