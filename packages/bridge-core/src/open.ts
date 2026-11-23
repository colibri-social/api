import type { MessageView } from "./client.js";
import type { OutboundAttachment, OutboundEmbed } from "./connector.js";

type AttachmentSource = {
	url: string;
	mimeType: string;
	name?: string;
	size?: number;
	alt?: string;
	spoiler?: boolean;
	width?: number;
	height?: number;
};

type EmbedSource = {
	uri: string;
	title?: string;
	description?: string;
	siteName?: string;
	image?: { url: string };
	themeColor?: string;
};

export class BoundedSet {
	private readonly entries = new Set<string>();

	constructor(private readonly capacity: number) {}

	add(value: string): void {
		this.entries.delete(value);
		this.entries.add(value);

		for (const oldest of this.entries) {
			if (this.entries.size <= this.capacity) break;
			this.entries.delete(oldest);
		}
	}

	has(value: string): boolean {
		return this.entries.has(value);
	}

	take(value: string): boolean {
		return this.entries.delete(value);
	}
}

export class ExpiringCache<V> {
	private readonly entries = new Map<string, { value: V; expiresAt: number }>();

	constructor(
		private readonly capacity: number,
		private readonly ttlMs: number,
		private readonly now: () => number = Date.now,
	) {}

	get(key: string): V | undefined {
		const entry = this.entries.get(key);

		if (!entry) return undefined;

		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);

			return undefined;
		}

		return entry.value;
	}

	set(key: string, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });

		for (const oldest of this.entries.keys()) {
			if (this.entries.size <= this.capacity) break;
			this.entries.delete(oldest);
		}
	}
}

export const outboundAttachments = (
	attachments: ReadonlyArray<AttachmentSource> = [],
): OutboundAttachment[] => {
	return attachments.map((attachment) => ({
		url: attachment.url,
		mimeType: attachment.mimeType,
		...(attachment.name ? { name: attachment.name } : {}),
		...(attachment.size !== undefined ? { size: attachment.size } : {}),
		...(attachment.alt ? { alt: attachment.alt } : {}),
		...(attachment.spoiler ? { spoiler: true } : {}),
		...(attachment.width !== undefined ? { width: attachment.width } : {}),
		...(attachment.height !== undefined ? { height: attachment.height } : {}),
	}));
};

export const outboundEmbeds = (message: MessageView): OutboundEmbed[] => {
	const embeds = (message.embeds ?? []) as ReadonlyArray<EmbedSource>;
	const suppressed = new Set<string>(message.suppressedEmbeds ?? []);

	return embeds
		.filter((embed) => !suppressed.has(embed.uri))
		.map((embed) => ({
			url: embed.uri,
			...(embed.title ? { title: embed.title } : {}),
			...(embed.description ? { description: embed.description } : {}),
			...(embed.siteName ? { siteName: embed.siteName } : {}),
			...(embed.image?.url ? { imageUrl: embed.image.url } : {}),
			...(embed.themeColor ? { themeColor: embed.themeColor } : {}),
		}));
};
