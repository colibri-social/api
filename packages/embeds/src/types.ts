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

export type EmbedLayout = "summary" | "largeImage" | "player";

export type EmbedProvider = {
	name: string;
	url?: string;
	icon?: string;
};

export type EmbedAuthor = {
	name: string;
	handle?: string;
	url?: string;
	avatar?: string;
};

export type EmbedMedia = {
	kind: "image" | "video" | "gifv";
	url: string;
	previewUrl?: string;
	mimeType?: PlayableVideoType;
	width?: number;
	height?: number;
	alt?: string;
};

export type RichSpan = {
	text: string;
	bold?: boolean;
	italic?: boolean;
	href?: string;
};

export type RichBlock = {
	kind: "paragraph" | "quote";
	spans: RichSpan[];
};

export type EmbedStats = {
	replies?: number;
	reposts?: number;
	likes?: number;
	views?: number;
};

export type EmbedQuote = {
	uri: string;
	author: EmbedAuthor;
	body: RichBlock[];
	media?: EmbedMedia[];
	publishedAt?: string;
	translatedFrom?: string;
};

export type EmbedPost = {
	body: RichBlock[];
	sensitive?: boolean;
	contentWarning?: string;
	stats?: EmbedStats;
	quote?: EmbedQuote;
	translatedFrom?: string;
};

export type LinkEmbed = {
	uri: string;
	title?: string;
	description?: string;
	siteName?: string;
	image?: EmbedImage;
	video?: EmbedVideo;
	themeColor?: string;
	layout?: EmbedLayout;
	provider?: EmbedProvider;
	author?: EmbedAuthor;
	publishedAt?: string;
	media?: EmbedMedia[];
	post?: EmbedPost;
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
