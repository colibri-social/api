export type EmojiFormat = "png" | "webp" | "gif" | "apng" | "lottie" | "other";

export type EmojiImage = {
	cid: string;
	format: EmojiFormat;
	mimeType?: string;
	size?: number;
	animated: boolean;
	pixels?: number;
};

export type BlobRef = {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
};

export type ParsedEmoji = {
	name: string;
	alt?: string;
	fallback?: string;
	images: EmojiImage[];
	adultOnly?: boolean;
	copyOf?: string;
	createdAt: string;
};

export type ParsedPack = {
	name: string;
	description?: string;
	createdAt: string;
};

export type ParsedMembership = {
	subject: string;
	pack: string;
	createdAt: string;
};

export type ProviderWrite = {
	collection: string;
	rkey: string;
	record: Record<string, unknown>;
};

export type EmojiCollectionKind = "item" | "pack" | "membership";

export type EmojiProvider = {
	id: string;
	collections: {
		item: string;
		pack?: string;
		membership?: string;
	};
	maxImageBytes: number;
	imageTypes: ReadonlySet<string>;
	parseItem: (value: unknown) => ParsedEmoji | null;
	parsePack?: (value: unknown) => ParsedPack | null;
	parseMembership?: (value: unknown) => ParsedMembership | null;
	buildItem: (input: {
		name: string;
		image: BlobRef;
		createdAt: string;
		newKey: () => string;
	}) => ProviderWrite;
	renameItem: (input: {
		rkey: string;
		record: Record<string, unknown>;
		name: string;
	}) => ProviderWrite;
	buildPack?: (input: {
		rkey: string;
		name: string;
		description?: string;
		createdAt: string;
	}) => ProviderWrite;
	buildMembership?: (input: {
		rkey: string;
		subject: string;
		pack: string;
		createdAt: string;
	}) => ProviderWrite;
};

export type PackCapableProvider = EmojiProvider &
	Required<
		Pick<EmojiProvider, "parsePack" | "parseMembership" | "buildPack" | "buildMembership">
	> & {
		collections: Required<EmojiProvider["collections"]>;
	};

export const supportsPacks = (provider: EmojiProvider): provider is PackCapableProvider =>
	provider.collections.pack !== undefined &&
	provider.collections.membership !== undefined &&
	provider.parsePack !== undefined &&
	provider.parseMembership !== undefined &&
	provider.buildPack !== undefined &&
	provider.buildMembership !== undefined;

export const EMOJI_NAME = /^[a-z0-9_]{2,32}$/;

export const PACK_NAME_MAX = 64;
