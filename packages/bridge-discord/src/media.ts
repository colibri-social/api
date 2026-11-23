import type {
	OutboundAttachment,
	OutboundEmbed,
	RemoteAttachment,
} from "@colibri-social/bridge-core";
import type { APIEmbed, AttachmentPayload } from "discord.js";

export type DiscordAttachment = {
	url: string;
	name: string;
	size: number;
	description: string | null;
	spoiler: boolean;
};

export const MAX_DISCORD_EMBEDS = 10;

const SPOILER_PREFIX = "SPOILER_";
const MAX_EMBED_TITLE = 256;
const MAX_EMBED_DESCRIPTION = 300;
const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

const truncate = (value: string, length: number): string => {
	return [...value].slice(0, length).join("");
};

export const remoteAttachment = (attachment: DiscordAttachment): RemoteAttachment => {
	const spoiler = attachment.spoiler || attachment.name.startsWith(SPOILER_PREFIX);
	const name = attachment.name.startsWith(SPOILER_PREFIX)
		? attachment.name.slice(SPOILER_PREFIX.length) || attachment.name
		: attachment.name;

	return {
		url: attachment.url,
		name,
		size: attachment.size,
		...(attachment.description ? { alt: attachment.description } : {}),
		...(spoiler ? { spoiler: true } : {}),
	};
};

export const attachmentPayload = (attachment: OutboundAttachment): AttachmentPayload => {
	const name = attachment.name ?? "attachment";

	return {
		attachment: attachment.url,
		name:
			attachment.spoiler && !name.startsWith(SPOILER_PREFIX) ? `${SPOILER_PREFIX}${name}` : name,
		...(attachment.alt ? { description: attachment.alt } : {}),
	};
};

export const embedColor = (themeColor: string | undefined): number | undefined => {
	const hex = themeColor?.trim().match(HEX_COLOR)?.[1];
	if (!hex) return undefined;

	const full = hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join("") : hex;

	return Number.parseInt(full, 16);
};

export const previewEmbeds = (
	embeds: OutboundEmbed[],
	texts: string[],
	room: number,
): APIEmbed[] => {
	return embeds
		.filter((embed) => !texts.some((text) => text.includes(embed.url)))
		.slice(0, Math.max(0, room))
		.map((embed) => {
			const color = embedColor(embed.themeColor);

			return {
				url: embed.url,
				title: truncate(embed.title || embed.siteName || embed.url, MAX_EMBED_TITLE),
				...(embed.description
					? { description: truncate(embed.description, MAX_EMBED_DESCRIPTION) }
					: {}),
				...(embed.imageUrl ? { image: { url: embed.imageUrl } } : {}),
				...(color !== undefined ? { color } : {}),
			};
		});
};
