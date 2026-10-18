import type {
	EmojiFormat,
	EmojiImage,
	EmojiProvider,
	ParsedEmoji,
	ParsedMembership,
	ParsedPack,
} from "../provider.js";

export const BLUEMOJI = {
	provider: "blue.moji",
	item: "blue.moji.collection.item",
	pack: "blue.moji.packs.pack",
	membership: "blue.moji.packs.packitem",
	formatsV1: "blue.moji.collection.item#formats_v1",
} as const;

type FormatKey = "png_128" | "webp_128" | "gif_128" | "apng_128" | "lottie";

const FORMATS: readonly { key: FormatKey; format: EmojiFormat }[] = [
	{ key: "webp_128", format: "webp" },
	{ key: "png_128", format: "png" },
	{ key: "apng_128", format: "apng" },
	{ key: "gif_128", format: "gif" },
	{ key: "lottie", format: "lottie" },
];

const ANIMATED: ReadonlySet<EmojiFormat> = new Set(["apng", "gif", "lottie"]);

const FORMAT_FOR_MIME: Record<string, FormatKey> = {
	"image/png": "png_128",
	"image/webp": "webp_128",
	"image/gif": "gif_128",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value : undefined;

const cidOf = (value: unknown): string | undefined => {
	if (!isObject(value)) return undefined;
	const ref = value.ref;
	if (isObject(ref) && typeof ref.$link === "string") return ref.$link;
	if (typeof value.cid === "string") return value.cid;
	return undefined;
};

const blobImage = (value: unknown, format: EmojiFormat, pixels?: number): EmojiImage | null => {
	const cid = cidOf(value);
	if (!cid || !isObject(value)) return null;
	return {
		cid,
		format,
		animated: ANIMATED.has(format),
		...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
		...(typeof value.size === "number" ? { size: value.size } : {}),
		...(pixels ? { pixels } : {}),
	};
};

const bareName = (name: string) => name.replace(/^:+/, "").replace(/:+$/, "");

const parseItem = (value: unknown): ParsedEmoji | null => {
	if (!isObject(value) || !isObject(value.formats)) return null;
	if (typeof value.name !== "string" || typeof value.createdAt !== "string") return null;

	const formats = value.formats;
	const images = FORMATS.flatMap(({ key, format }) => {
		const image = blobImage(formats[key], format, format === "lottie" ? undefined : 128);
		return image ? [image] : [];
	});
	if (images.length === 0) {
		const original = blobImage(formats.original, "other");
		if (original) images.push(original);
	}
	if (images.length === 0) return null;

	const name = bareName(value.name);
	if (!name) return null;

	return {
		name,
		images,
		createdAt: value.createdAt,
		...(optionalString(value.alt) ? { alt: value.alt as string } : {}),
		...(optionalString(value.fallbackText)
			? { fallback: (value.fallbackText as string).trim() }
			: {}),
		...(value.adultOnly === true ? { adultOnly: true } : {}),
	};
};

const parsePack = (value: unknown): ParsedPack | null => {
	if (!isObject(value)) return null;
	if (typeof value.name !== "string" || typeof value.createdAt !== "string") return null;
	return {
		name: value.name,
		createdAt: value.createdAt,
		...(optionalString(value.description) ? { description: value.description as string } : {}),
	};
};

const parseMembership = (value: unknown): ParsedMembership | null => {
	if (!isObject(value)) return null;
	if (typeof value.subject !== "string" || typeof value.pack !== "string") return null;
	return {
		subject: value.subject,
		pack: value.pack,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
	};
};

export const bluemojiProvider: EmojiProvider = {
	id: BLUEMOJI.provider,
	collections: {
		item: BLUEMOJI.item,
		pack: BLUEMOJI.pack,
		membership: BLUEMOJI.membership,
	},
	maxImageBytes: 128_000,
	imageTypes: new Set(Object.keys(FORMAT_FOR_MIME)),
	parseItem,
	parsePack,
	parseMembership,
	buildItem: ({ name, image, createdAt }) => {
		const key = FORMAT_FOR_MIME[image.mimeType] ?? "png_128";
		return {
			collection: BLUEMOJI.item,
			rkey: name,
			record: {
				$type: BLUEMOJI.item,
				name: `:${name}:`,
				createdAt,
				formats: {
					$type: BLUEMOJI.formatsV1,
					original: image,
					[key]: image,
				},
			},
		};
	},
	renameItem: ({ record, name }) => ({
		collection: BLUEMOJI.item,
		rkey: name,
		record: { ...record, $type: BLUEMOJI.item, name: `:${name}:` },
	}),
	buildPack: ({ rkey, name, description, createdAt }) => ({
		collection: BLUEMOJI.pack,
		rkey,
		record: {
			$type: BLUEMOJI.pack,
			name,
			createdAt,
			...(description ? { description } : {}),
		},
	}),
	buildMembership: ({ rkey, subject, pack, createdAt }) => ({
		collection: BLUEMOJI.membership,
		rkey,
		record: { $type: BLUEMOJI.membership, subject, pack, createdAt },
	}),
};
