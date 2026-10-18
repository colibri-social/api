import type {
	ClientPreferences,
	ComposerState,
	GifFavorite,
	NotificationLevel,
} from "@colibri-social/appview-db";
import type { social } from "@colibri-social/lexicons";

type ClientPreferencesIn = Omit<social.colibri.beta.actor.defs.ClientPreferences, "$type">;
type ComposerStateIn = Omit<social.colibri.beta.actor.defs.ComposerState, "$type">;
type GifViewIn = social.colibri.beta.embed.defs.GifView;

const NOTIFICATION_LEVELS: ReadonlySet<string> = new Set<NotificationLevel>([
	"all",
	"mentionsAndReplies",
	"nothing",
]);

export const isNotificationLevel = (value: string): value is NotificationLevel =>
	NOTIFICATION_LEVELS.has(value);

const withoutUndefined = <T extends object>(value: T): T =>
	Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

export const toGifFavorite = (gif: GifViewIn): GifFavorite => ({
	id: gif.id,
	url: gif.url,
	previewUrl: gif.previewUrl,
	width: gif.width,
	height: gif.height,
	...(gif.title === undefined ? {} : { title: gif.title }),
});

export const toStoredClientPreferences = (value: ClientPreferencesIn): ClientPreferences =>
	withoutUndefined({
		controls:
			value.controls &&
			withoutUndefined({
				swipeLeftAction: value.controls.swipeLeftAction,
				doubleTapEnabled: value.controls.doubleTapEnabled,
				doubleTapAction: value.controls.doubleTapAction,
				doubleTapReactionEmoji: value.controls.doubleTapReactionEmoji,
			}),
		theme: value.theme,
		messagePreviews: value.messagePreviews,
		linkEmbedsByDefault: value.linkEmbedsByDefault,
		warnOnExternalLinks: value.warnOnExternalLinks,
		blueskyClient: value.blueskyClient,
		customBlueskyClientBase: value.customBlueskyClientBase,
		developerMode: value.developerMode,
		inboxPresentation: value.inboxPresentation,
		voiceView:
			value.voiceView &&
			withoutUndefined({
				confirmJoin: value.voiceView.confirmJoin,
				showNonVideoParticipants: value.voiceView.showNonVideoParticipants,
				showOwnCamera: value.voiceView.showOwnCamera,
			}),
		experiments: value.experiments && [...value.experiments],
	});

export const toStoredComposerState = (value: ComposerStateIn): ComposerState =>
	withoutUndefined({
		emojiUsage: value.emojiUsage?.map((use) => ({
			emoji: use.emoji,
			count: use.count,
			lastUsed: use.lastUsed,
		})),
		skinTone: value.skinTone,
		recentGifs: value.recentGifs?.map(toGifFavorite),
	});
