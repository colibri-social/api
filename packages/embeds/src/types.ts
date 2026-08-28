import type { PlayableVideoType } from "./video.js";

export type MeasuredImage = {
	width: number;
	height: number;
};

export type EmbedImage = {
	url: string;
	width?: number;
	height?: number;
	alt?: string;
};

export type EmbedVideo = {
	url: string;
	mimeType: PlayableVideoType;
	width?: number;
	height?: number;
	duration?: number;
};

export type LinkEmbed = {
	uri: string;
	title?: string;
	description?: string;
	siteName?: string;
	image?: EmbedImage;
	video?: EmbedVideo;
};

export type GifView = {
	id: string;
	url: string;
	previewUrl: string;
	width: number;
	height: number;
	title?: string;
};

export type GifCategory = {
	name: string;
	previewUrl?: string;
};

export type GifPage = {
	gifs: GifView[];
	cursor?: string;
};
