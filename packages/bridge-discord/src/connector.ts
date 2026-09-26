import type {
	BridgeContext,
	DeletingConnector,
	EditingConnector,
	HistoryConnector,
	HistoryMessage,
	HistoryRequest,
	HistoryThread,
	ModeratingConnector,
	OutboundDelete,
	OutboundEdit,
	OutboundMessage,
	OutboundReaction,
	OutboundThread,
	OutboundThreadChange,
	OutboundThreadRef,
	ReactingConnector,
	RemoteLocation,
	RemoteRoomInfo,
	ThreadingConnector,
} from "@colibri-social/bridge-core";
import {
	type AnyThreadChannel,
	ApplicationCommandOptionType,
	ChannelType,
	type ChatInputCommandInteraction,
	Client,
	DiscordAPIError,
	Events,
	GatewayIntentBits,
	type Guild,
	type Message,
	MessageFlags,
	type MessageReaction,
	MessageReferenceType,
	type NewsChannel,
	type PartialMessage,
	type PartialMessageReaction,
	Partials,
	PermissionFlagsBits,
	RESTJSONErrorCodes,
	SnowflakeUtil,
	type TextChannel,
	type Webhook,
} from "discord.js";
import {
	colibriToDiscordMarkdown,
	discordToColibriMarkdown,
	forwardBlock,
	type GifvEmbed,
	inlineGifs,
	loneGifUrl,
	mentionedUsers,
	replyPrefix,
	webhookUsername,
} from "./markdown.js";

export type DiscordConnectorOptions = {
	token: string;
	commandName?: string;
	webhookName?: string;
	client?: Client;
};

type RelayChannel = TextChannel | NewsChannel;

function isDiscordError(error: unknown, code: RESTJSONErrorCodes): boolean {
	return error instanceof DiscordAPIError && error.code === code;
}

const RELAYED_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

const RELAYED_THREAD_TYPES = new Set([ChannelType.PublicThread, ChannelType.AnnouncementThread]);
const MAX_THREAD_NAME = 100;
const HISTORY_PAGE_SIZE = 100;

const isRelayChannel = (channel: unknown): channel is RelayChannel =>
	typeof channel === "object" &&
	channel !== null &&
	RELAYED_CHANNEL_TYPES.has((channel as { type: ChannelType }).type);

const isRelayThread = (channel: unknown): channel is AnyThreadChannel =>
	typeof channel === "object" &&
	channel !== null &&
	RELAYED_THREAD_TYPES.has((channel as { type: ChannelType }).type);

const discordThreadName = (name: string): string => [...name].slice(0, MAX_THREAD_NAME).join("");

const jumpUrl = (location: RemoteLocation & { id: string }): string =>
	`https://discord.com/channels/${location.remoteSpace}/${location.remoteThread ?? location.remoteRoom}/${location.id}`;

type MessageLocation = { remoteRoom: string; remoteThread?: string };

export class DiscordConnector
	implements
		EditingConnector,
		DeletingConnector,
		ReactingConnector,
		ThreadingConnector,
		ModeratingConnector,
		HistoryConnector
{
	readonly platform = "discord";
	private readonly client: Client;
	private readonly commandName: string;
	private readonly webhookName: string;
	private readonly webhooks = new Map<string, Promise<Webhook>>();
	private readonly ownWebhookIds = new Set<string>();
	private context: BridgeContext | null = null;

	constructor(private readonly options: DiscordConnectorOptions) {
		this.commandName = options.commandName ?? "colibri";
		this.webhookName = options.webhookName ?? "Colibri";
		this.client =
			options.client ??
			new Client({
				intents: [
					GatewayIntentBits.Guilds,
					GatewayIntentBits.GuildMessages,
					GatewayIntentBits.MessageContent,
					GatewayIntentBits.GuildMessageReactions,
				],
				partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
			});
	}

	async start(context: BridgeContext): Promise<void> {
		this.context = context;
		this.client.once(Events.ClientReady, (client) => {
			context.log.info(
				{ user: client.user.tag, guilds: client.guilds.cache.size },
				"discord.ready",
			);
			void this.registerCommands().catch((error) =>
				context.log.warn({ error: String(error) }, "discord.commands.registerFailed"),
			);
			for (const guild of client.guilds.cache.values()) this.roomsChanged(guild.id);
		});
		this.client.on(Events.Error, (error) =>
			context.log.error({ error: error.message }, "discord.client.error"),
		);
		this.client.on(Events.GuildCreate, (guild) => this.roomsChanged(guild.id));
		this.client.on(Events.GuildDelete, (guild) =>
			context.emit({ type: "spaceLeft", remoteSpace: guild.id }),
		);
		this.client.on(Events.ChannelCreate, (channel) => this.roomsChanged(channel.guildId));
		this.client.on(Events.ChannelUpdate, (_, channel) => {
			if ("guildId" in channel && channel.guildId) this.roomsChanged(channel.guildId);
		});
		this.client.on(Events.ChannelDelete, (channel) => {
			if ("guildId" in channel && channel.guildId) this.roomsChanged(channel.guildId);
		});
		this.client.on(Events.ThreadCreate, (thread, newlyCreated) => {
			if (newlyCreated) void this.onThreadCreate(thread);
		});
		this.client.on(Events.ThreadUpdate, (before, after) => this.onThreadUpdate(before, after));
		this.client.on(Events.ThreadDelete, (thread) => this.onThreadDelete(thread));
		this.client.on(Events.MessageCreate, (message) => this.onMessage(message));
		this.client.on(Events.MessageUpdate, (_, message) => void this.onMessageUpdate(message));
		this.client.on(Events.MessageDelete, (message) => this.onMessageDelete(message));
		this.client.on(Events.MessageBulkDelete, (messages) => {
			for (const message of messages.values()) this.onMessageDelete(message);
		});
		this.client.on(Events.MessageReactionAdd, (reaction, user) =>
			this.onReaction("reactionAdd", reaction, user.id, user.displayName ?? user.username ?? ""),
		);
		this.client.on(Events.MessageReactionRemove, (reaction, user) =>
			this.onReaction("reactionRemove", reaction, user.id, user.displayName ?? user.username ?? ""),
		);
		this.client.on(Events.InteractionCreate, (interaction) => {
			if (interaction.isChatInputCommand() && interaction.commandName === this.commandName) {
				void this.onCommand(interaction).catch((error) =>
					context.log.warn({ error: String(error) }, "discord.command.failed"),
				);
			}
		});
		await this.client.login(this.options.token);
	}

	async stop(): Promise<void> {
		await this.client.destroy();
	}

	private roomsChanged(guildId: string | null | undefined): void {
		if (guildId) this.context?.emit({ type: "roomsChanged", remoteSpace: guildId });
	}

	private async registerCommands(): Promise<void> {
		await this.client.application?.commands.set([
			{
				name: this.commandName,
				description: "Connect this server to a Colibri community",
				defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
				dmPermission: false,
				options: [
					{
						type: ApplicationCommandOptionType.Subcommand,
						name: "connect",
						description: "Get a code to pair this server with a Colibri community",
					},
					{
						type: ApplicationCommandOptionType.Subcommand,
						name: "status",
						description: "List the channels relayed to Colibri",
					},
				],
			},
		]);
	}

	private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		const context = this.context;
		const guild = interaction.guild;
		if (!context || !guild) return;
		if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
			await interaction.reply({
				content: "You need the Manage Server permission to do that.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (interaction.options.getSubcommand() === "status") {
			const rooms = context.linkedRooms(guild.id);
			await interaction.reply({
				content:
					rooms.length === 0
						? "No channels in this server are relayed to Colibri yet."
						: rooms.map((room) => `<#${room.remoteRoom}>`).join("\n"),
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const pairing = await context.pair({ remoteSpace: guild.id, remoteSpaceName: guild.name });
		const expires = Math.floor(new Date(pairing.expiresAt).getTime() / 1000);
		await interaction.reply({
			content: [
				`Your pairing code is **${pairing.code}**.`,
				"In Colibri, open your community's settings, go to Bridges, and enter the code.",
				`It works once and expires <t:${expires}:R>.`,
			].join("\n"),
			flags: MessageFlags.Ephemeral,
		});
	}

	private isOwnMessage(message: Message | PartialMessage): boolean {
		if (message.author?.id && message.author.id === this.client.user?.id) return true;
		if (!message.webhookId) return false;
		return (
			this.ownWebhookIds.has(message.webhookId) ||
			(message.applicationId !== null && message.applicationId === this.client.application?.id)
		);
	}

	private lookups(message: Message) {
		return {
			user: (id: string) => {
				const member = message.mentions.members?.get(id);
				const user = message.mentions.users.get(id);
				return member?.displayName ?? user?.displayName ?? user?.username;
			},
			role: (id: string) => message.guild?.roles.cache.get(id)?.name,
			channel: (id: string) => {
				const channel = message.guild?.channels.cache.get(id);
				return channel && "name" in channel ? channel.name : undefined;
			},
		};
	}

	private locate(message: Message | PartialMessage): MessageLocation | null {
		const channel = message.channel;
		if (isRelayThread(channel)) {
			return channel.parentId ? { remoteRoom: channel.parentId, remoteThread: channel.id } : null;
		}
		if (channel?.isThread()) return null;
		return { remoteRoom: message.channelId };
	}

	private async threadOwner(thread: AnyThreadChannel) {
		const owner = thread.ownerId
			? await thread.guild.members.fetch(thread.ownerId).catch(() => null)
			: null;
		return {
			id: thread.ownerId ?? "unknown",
			name: owner?.displayName ?? "Unknown",
			...(owner ? { avatarUrl: owner.displayAvatarURL({ extension: "png", size: 128 }) } : {}),
		};
	}

	private async onThreadCreate(thread: AnyThreadChannel): Promise<void> {
		if (!isRelayThread(thread) || !thread.parentId) return;
		if (thread.ownerId && thread.ownerId === this.client.user?.id) return;
		if (thread.joinable) await thread.join().catch(() => undefined);
		this.context?.emit({
			type: "threadCreate",
			remoteSpace: thread.guildId,
			remoteRoom: thread.parentId,
			id: thread.id,
			name: thread.name,
			anchor: thread.id,
			author: await this.threadOwner(thread),
		});
	}

	private onThreadUpdate(before: AnyThreadChannel, after: AnyThreadChannel): void {
		if (!isRelayThread(after) || !after.parentId || before.name === after.name) return;
		this.context?.emit({
			type: "threadUpdate",
			remoteSpace: after.guildId,
			remoteRoom: after.parentId,
			id: after.id,
			name: after.name,
		});
	}

	private onThreadDelete(thread: AnyThreadChannel): void {
		if (!isRelayThread(thread) || !thread.parentId) return;
		this.context?.emit({
			type: "threadDelete",
			remoteSpace: thread.guildId,
			remoteRoom: thread.parentId,
			id: thread.id,
		});
	}

	private forwardOf(message: Message) {
		if (message.reference?.type !== MessageReferenceType.Forward) return undefined;
		const snapshot = message.messageSnapshots.first();
		if (!snapshot) return undefined;
		return {
			...(message.reference.messageId ? { remoteMessage: message.reference.messageId } : {}),
			markdown: discordToColibriMarkdown(snapshot.content ?? "", this.lookups(message)),
			attachments: [...(snapshot.attachments?.values() ?? [])].map((attachment) => ({
				url: attachment.url,
				name: attachment.name,
				size: attachment.size,
			})),
			...(snapshot.createdTimestamp
				? { createdAt: new Date(snapshot.createdTimestamp).toISOString() }
				: {}),
		};
	}

	private contentOf(message: Message): string {
		return inlineGifs(message.content, message.embeds, (embed: GifvEmbed) =>
			this.context?.log.debug(
				{
					message: message.id,
					url: embed.url,
					thumbnail: embed.thumbnail?.url,
					image: embed.image?.url,
					video: embed.video?.url,
				},
				"discord.gifv.unresolved",
			),
		);
	}

	private relayable(message: Message): boolean {
		return Boolean(message.guildId) && !message.system && !this.isOwnMessage(message);
	}

	private messageFields(message: Message) {
		const forward = this.forwardOf(message);
		const replyTo =
			message.reference?.type === MessageReferenceType.Default ? message.reference.messageId : null;
		return {
			id: message.id,
			author: {
				id: message.author.id,
				name: message.member?.displayName ?? message.author.displayName,
				avatarUrl: (message.member ?? message.author).displayAvatarURL({
					extension: "png",
					size: 128,
				}),
			},
			markdown: discordToColibriMarkdown(this.contentOf(message), this.lookups(message)),
			...(replyTo ? { replyTo } : {}),
			attachments: [...message.attachments.values()].map((attachment) => ({
				url: attachment.url,
				name: attachment.name,
				size: attachment.size,
			})),
			...(forward ? { forward } : {}),
			createdAt: message.createdAt.toISOString(),
		};
	}

	private onMessage(message: Message): void {
		if (!message.guildId || !this.relayable(message)) return;
		const location = this.locate(message);
		if (!location) return;
		const channel = message.channel;
		this.context?.emit({
			type: "message",
			remoteSpace: message.guildId,
			...location,
			...this.messageFields(message),
			...(isRelayThread(channel)
				? { thread: { id: channel.id, name: channel.name, anchor: channel.id } }
				: {}),
		});
	}

	async fetchHistory(request: HistoryRequest): Promise<HistoryMessage[]> {
		const messages = await this.messagesIn(request);
		const until = Date.parse(request.until);
		let after =
			request.after ??
			(request.since
				? SnowflakeUtil.generate({ timestamp: Date.parse(request.since) - 1 }).toString()
				: "0");
		for (;;) {
			const page = [
				...(await messages.fetch({ after, limit: HISTORY_PAGE_SIZE, cache: false })).values(),
			].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
			const last = page.at(-1);
			if (!last) return [];
			const relayed = page.filter((message) => this.relayable(message));
			if (relayed.length > 0) {
				return relayed.map((message) => ({
					remoteSpace: request.remoteSpace,
					remoteRoom: request.remoteRoom,
					...(request.remoteThread ? { remoteThread: request.remoteThread } : {}),
					...this.messageFields(message),
				}));
			}
			if (last.createdTimestamp > until) return [];
			after = last.id;
		}
	}

	async listThreads(
		room: RemoteLocation & { since?: string; until: string },
	): Promise<HistoryThread[]> {
		const channel = await this.relayChannel(room.remoteRoom);
		const found = new Map<string, AnyThreadChannel>();
		for (const thread of (await channel.threads.fetchActive(false)).threads.values()) {
			found.set(thread.id, thread);
		}
		let before: AnyThreadChannel | undefined;
		for (;;) {
			const archived = await channel.threads.fetchArchived(
				{ type: "public", limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) },
				false,
			);
			const page = [...archived.threads.values()];
			for (const thread of page) found.set(thread.id, thread);
			before = page.at(-1);
			if (!archived.hasMore || !before) break;
		}
		const since = room.since ? Date.parse(room.since) : Number.NEGATIVE_INFINITY;
		const until = Date.parse(room.until);
		const threads: HistoryThread[] = [];
		for (const thread of found.values()) {
			if (!isRelayThread(thread) || thread.parentId !== room.remoteRoom) continue;
			const created = thread.createdTimestamp ?? SnowflakeUtil.timestampFrom(thread.id);
			if (created < since || created > until) continue;
			threads.push({
				id: thread.id,
				name: thread.name,
				anchor: thread.id,
				author: await this.threadOwner(thread),
				createdAt: new Date(created).toISOString(),
			});
		}
		return threads;
	}

	async roomCreatedAt(room: RemoteLocation): Promise<string> {
		return (await this.relayChannel(room.remoteRoom)).createdAt.toISOString();
	}

	private async onMessageUpdate(message: Message | PartialMessage): Promise<void> {
		const full = message.partial ? await message.fetch().catch(() => null) : message;
		if (!full?.guildId || this.isOwnMessage(full)) return;
		const content = this.contentOf(full);
		if (full.editedTimestamp === null && content === full.content) return;
		const location = this.locate(full);
		if (!location) return;
		this.context?.emit({
			type: "messageEdit",
			remoteSpace: full.guildId,
			...location,
			id: full.id,
			markdown: discordToColibriMarkdown(content, this.lookups(full)),
		});
	}

	private onMessageDelete(message: Message | PartialMessage): void {
		if (!message.guildId) return;
		const location = this.locate(message);
		if (!location) return;
		this.context?.emit({
			type: "messageDelete",
			remoteSpace: message.guildId,
			...location,
			id: message.id,
		});
	}

	private onReaction(
		type: "reactionAdd" | "reactionRemove",
		reaction: MessageReaction | PartialMessageReaction,
		userId: string,
		userName: string,
	): void {
		if (userId === this.client.user?.id) return;
		const message = reaction.message;
		if (!message.guildId) return;
		const emoji = reaction.emoji.id ? `:${reaction.emoji.name ?? "emoji"}:` : reaction.emoji.name;
		if (!emoji) return;
		const place = this.locate(message);
		if (!place) return;
		const location = {
			remoteSpace: message.guildId,
			...place,
			messageId: message.id,
			emoji,
		};
		this.context?.emit(
			type === "reactionAdd"
				? { type, ...location, author: { id: userId, name: userName } }
				: { type, ...location, authorId: userId },
		);
	}

	private async relayChannel(id: string): Promise<RelayChannel> {
		const channel = await this.client.channels.fetch(id);
		if (!isRelayChannel(channel)) throw new Error(`channel ${id} cannot be relayed to`);
		return channel;
	}

	private async messagesIn(location: RemoteLocation) {
		if (location.remoteThread) {
			const thread = await this.client.channels.fetch(location.remoteThread);
			if (!isRelayThread(thread)) {
				throw new Error(`thread ${location.remoteThread} cannot be relayed to`);
			}
			return thread.messages;
		}
		return (await this.relayChannel(location.remoteRoom)).messages;
	}

	private async relayThread(id: string): Promise<AnyThreadChannel> {
		const thread = await this.client.channels.fetch(id);
		if (!isRelayThread(thread)) throw new Error(`thread ${id} cannot be relayed to`);
		return thread;
	}

	private webhookFor(channel: RelayChannel): Promise<Webhook> {
		const cached = this.webhooks.get(channel.id);
		if (cached) return cached;
		const pending = (async () => {
			const existing = (await channel.fetchWebhooks()).find(
				(webhook) =>
					webhook.owner?.id === this.client.user?.id && webhook.name === this.webhookName,
			);
			const webhook =
				existing ??
				(await channel.createWebhook({ name: this.webhookName, reason: "Colibri bridge" }));
			this.ownWebhookIds.add(webhook.id);
			return webhook;
		})();
		pending.catch(() => this.webhooks.delete(channel.id));
		this.webhooks.set(channel.id, pending);
		return pending;
	}

	private async withWebhook<T>(
		channel: RelayChannel,
		work: (webhook: Webhook) => Promise<T>,
	): Promise<T> {
		const pending = this.webhookFor(channel);
		try {
			return await work(await pending);
		} catch (error) {
			if (!isDiscordError(error, RESTJSONErrorCodes.UnknownWebhook)) throw error;
			if (this.webhooks.get(channel.id) === pending) this.webhooks.delete(channel.id);
			return work(await this.webhookFor(channel));
		}
	}

	async listRooms(remoteSpace: string): Promise<RemoteRoomInfo[]> {
		const guild: Guild | undefined = this.client.guilds.cache.get(remoteSpace);
		if (!guild) return [];
		return [...guild.channels.cache.values()]
			.filter(isRelayChannel)
			.sort((a, b) => a.rawPosition - b.rawPosition)
			.map((channel) => ({
				id: channel.id,
				name: channel.name,
				kind: channel.type === ChannelType.GuildAnnouncement ? "announcement" : "text",
				...(channel.parent ? { parent: channel.parent.name } : {}),
			}));
	}

	async sendMessage(message: OutboundMessage): Promise<string> {
		const channel = await this.relayChannel(message.remoteRoom);
		const prefix = message.replyTo ? replyPrefix(jumpUrl({ ...message, id: message.replyTo })) : "";
		const forward = message.forward
			? forwardBlock(
					message.forward.markdown,
					message.forward.source ? jumpUrl(message.forward.source) : undefined,
				)
			: "";
		const gif = forward ? undefined : loneGifUrl(message.markdown);
		const markdown = gif
			? prefix.trimEnd()
			: [`${prefix}${message.markdown}`, forward].filter(Boolean).join("\n");
		const sent = await this.withWebhook(channel, (webhook) =>
			webhook.send({
				content: colibriToDiscordMarkdown(markdown) || undefined,
				...(gif ? { embeds: [{ image: { url: gif } }] } : {}),
				username: webhookUsername(message.author.name, message.author.handle),
				...(message.author.avatarUrl ? { avatarURL: message.author.avatarUrl } : {}),
				...(message.remoteThread ? { threadId: message.remoteThread } : {}),
				files: [...message.attachments, ...(message.forward?.attachments ?? [])].map(
					(attachment) => ({
						attachment: attachment.url,
						name: attachment.name ?? "attachment",
					}),
				),
				allowedMentions: { parse: [], users: mentionedUsers(markdown) },
			}),
		);
		return sent.id;
	}

	async editMessage(edit: OutboundEdit): Promise<void> {
		await this.withWebhook(await this.relayChannel(edit.remoteRoom), (webhook) =>
			webhook.editMessage(edit.id, {
				...this.editedContent(edit.markdown),
				allowedMentions: { parse: [], users: mentionedUsers(edit.markdown) },
				...(edit.remoteThread ? { threadId: edit.remoteThread } : {}),
			}),
		);
	}

	private editedContent(markdown: string) {
		const gif = loneGifUrl(markdown);
		return gif
			? { content: "", embeds: [{ image: { url: gif } }] }
			: { content: colibriToDiscordMarkdown(markdown), embeds: [] };
	}

	async deleteMessage(target: OutboundDelete): Promise<void> {
		try {
			await this.withWebhook(await this.relayChannel(target.remoteRoom), (webhook) =>
				webhook.deleteMessage(target.id, target.remoteThread),
			);
		} catch (error) {
			if (!isDiscordError(error, RESTJSONErrorCodes.UnknownMessage)) throw error;
			await this.removeMessage(target);
		}
	}

	async removeMessage(target: OutboundDelete): Promise<void> {
		try {
			await (await this.messagesIn(target)).delete(target.id);
		} catch (error) {
			if (!isDiscordError(error, RESTJSONErrorCodes.UnknownMessage)) throw error;
		}
	}

	async addReaction(reaction: OutboundReaction): Promise<void> {
		if (reaction.emoji.startsWith(":")) return;
		const message = await (await this.messagesIn(reaction)).fetch(reaction.messageId);
		await message.react(reaction.emoji);
	}

	async removeReaction(reaction: OutboundReaction): Promise<void> {
		if (reaction.emoji.startsWith(":")) return;
		const userId = this.client.user?.id;
		if (!userId) return;
		const message = await (await this.messagesIn(reaction)).fetch(reaction.messageId);
		await message.reactions.cache.get(reaction.emoji)?.users.remove(userId);
	}

	async createThread(thread: OutboundThread): Promise<string> {
		const channel = await this.relayChannel(thread.remoteRoom);
		const name = discordThreadName(thread.name);
		const created = thread.anchor
			? await (await channel.messages.fetch(thread.anchor)).startThread({ name })
			: await channel.threads.create({ name, reason: "Colibri bridge" });
		return created.id;
	}

	async renameThread(change: OutboundThreadChange): Promise<void> {
		const thread = await this.relayThread(change.id);
		const name = discordThreadName(change.name);
		if (thread.name !== name) await thread.setName(name);
	}

	async archiveThread(target: OutboundThreadRef): Promise<void> {
		const thread = await this.relayThread(target.id);
		await thread.setLocked(true);
		await thread.setArchived(true);
	}
}
