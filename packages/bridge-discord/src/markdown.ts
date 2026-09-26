import { referenceMarkdown } from "@colibri-social/bridge-core";

export type MentionLookups = {
	user(id: string): string | undefined;
	role(id: string): string | undefined;
	channel(id: string): string | undefined;
};

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat("en-GB", {
	dateStyle: "medium",
	timeStyle: "short",
	timeZone: "UTC",
});

const timestampText = (seconds: string): string => {
	const date = new Date(Number(seconds) * 1000);
	return Number.isNaN(date.getTime()) ? seconds : `${TIMESTAMP_FORMAT.format(date)} UTC`;
};

export const discordToColibriMarkdown = (content: string, lookups: MentionLookups): string =>
	content
		.replace(/<@!?(\d+)>/g, (_, id: string) =>
			referenceMarkdown(`@${lookups.user(id) ?? "unknown-user"}`, { kind: "user", id }),
		)
		.replace(/<@&(\d+)>/g, (_, id: string) => `@${lookups.role(id) ?? "unknown-role"}`)
		.replace(/<#(\d+)>/g, (_, id: string) =>
			referenceMarkdown(`#${lookups.channel(id) ?? "unknown-channel"}`, { kind: "room", id }),
		)
		.replace(/<a?:(\w+):\d+>/g, (_, name: string) => `:${name}:`)
		.replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_, seconds: string) => timestampText(seconds))
		.replace(/<\/([\w -]+):\d+>/g, (_, command: string) => `/${command}`);

export const MAX_DISCORD_CONTENT = 2000;

const USER_REFERENCE = /\[[^\]]*\]\(bridge:user\/(\d+)\)/g;
const ROOM_REFERENCE = /\[[^\]]*\]\(bridge:room\/(\d+)\)/g;

export const mentionedUsers = (markdown: string): string[] => [
	...new Set([...markdown.matchAll(USER_REFERENCE)].flatMap((match) => match[1] ?? [])),
];

const URL_LABELLED_LINK = /\[([^\]\s]+)\]\(([^)\s]+)\)/g;

export const colibriToDiscordMarkdown = (markdown: string): string => {
	const native = markdown
		.replace(USER_REFERENCE, (_, id: string) => `<@${id}>`)
		.replace(ROOM_REFERENCE, (_, id: string) => `<#${id}>`)
		.replace(URL_LABELLED_LINK, (link, label: string, url: string) => (label === url ? url : link));
	return native.length <= MAX_DISCORD_CONTENT
		? native
		: `${native.slice(0, MAX_DISCORD_CONTENT - 3)}...`;
};

const RESERVED_NAME = /discord|clyde/gi;
const MAX_USERNAME = 80;
const FALLBACK_USERNAME = "Colibri user";

const LOOKALIKES: Record<string, string> = { "@": "\uff20", "#": "\uff03", ":": "\uff1a" };

const defuse = (value: string): string =>
	value
		.replace(RESERVED_NAME, (match) => `${match[0]}\u200b${match.slice(1)}`)
		.replaceAll("```", "")
		.replace(/[@#:]/g, (match) => LOOKALIKES[match] ?? match);

export const webhookUsername = (name: string, handle?: string): string => {
	const suffix = handle ? ` (${defuse(`@${handle}`)})` : "";
	const room = Math.max(MAX_USERNAME - suffix.length, 1);
	const shown = defuse(name).trim().slice(0, room).trim() || FALLBACK_USERNAME.slice(0, room);
	return `${shown}${suffix}`.slice(0, MAX_USERNAME);
};

export const replyPrefix = (jumpUrl: string): string => `-# Replying to ${jumpUrl}\n`;

export const forwardBlock = (markdown: string, jumpUrl?: string): string => {
	const heading = jumpUrl ? `-# Forwarded from ${jumpUrl}` : "-# Forwarded";
	const body = markdown.trim()
		? markdown
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")
		: "";
	return body ? `${heading}\n${body}` : heading;
};

const INLINE_GIF_PATH = /\.(gif|webp)$/i;

export const isInlineGifUrl = (value: string): boolean => {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "https:" || url.protocol === "http:") && INLINE_GIF_PATH.test(url.pathname)
		);
	} catch {
		return false;
	}
};

const LONE_URL = /^(?:\[(\S+)\]\((\S+)\)|(\S+))$/;

export const loneGifUrl = (markdown: string): string | undefined => {
	const match = LONE_URL.exec(markdown.trim());
	if (!match) return undefined;
	const [, label, target, bare] = match;
	const url = bare ?? (label === target ? target : undefined);
	return url && isInlineGifUrl(url) ? url : undefined;
};

type EmbedMedia = { url?: string | null } | null | undefined;

export type GifvEmbed = {
	data?: { type?: string };
	url?: string | null;
	thumbnail?: EmbedMedia;
	image?: EmbedMedia;
	video?: EmbedMedia;
};

export const inlineGifs = (
	content: string,
	embeds: readonly GifvEmbed[],
	onUnresolved: (embed: GifvEmbed) => void = () => undefined,
): string => {
	let out = content;
	for (const embed of embeds) {
		if (embed.data?.type !== "gifv" || !embed.url || !out.includes(embed.url)) continue;
		const media = [embed.thumbnail, embed.image, embed.video]
			.map((candidate) => candidate?.url)
			.find((url): url is string => Boolean(url) && isInlineGifUrl(url as string));
		if (!media) {
			onUnresolved(embed);
			continue;
		}
		out = out.replaceAll(embed.url, `[${media}](${media})`);
	}
	return out;
};
