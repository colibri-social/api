import type { GifView } from "@colibri-social/embeds";
import { asUri, type social } from "@colibri-social/lexicons";

type GifViewOut = social.colibri.beta.embed.defs.GifView;

export const toGifView = (gif: GifView): GifViewOut => ({
	id: gif.id,
	url: asUri(gif.url),
	previewUrl: asUri(gif.previewUrl),
	width: gif.width,
	height: gif.height,
	title: gif.title,
	...(gif.videoUrl === undefined ? {} : { videoUrl: asUri(gif.videoUrl) }),
	...(gif.mimeType === undefined ? {} : { mimeType: gif.mimeType }),
});

export const toGifFavorite = (gif: GifViewOut): GifView => ({
	id: gif.id,
	url: gif.url,
	previewUrl: gif.previewUrl,
	width: gif.width,
	height: gif.height,
	...(gif.title === undefined ? {} : { title: gif.title }),
	...(gif.videoUrl === undefined ? {} : { videoUrl: gif.videoUrl }),
	...(gif.mimeType === undefined ? {} : { mimeType: gif.mimeType }),
});
