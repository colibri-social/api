# @colibri-social/lexicons

## 2.31.0

### Minor Changes

- dd7a07e: Add `social.colibri.beta.emoji.getEmojis`, which returns up to 100 custom emoji by record URI across any number of repos in one request. Owners whose repo can't be read come back in `unreachable`. The method joins the `permissionCommunity` permission set next to `getCatalog`.

## 2.30.0

### Minor Changes

- 0b325da: Update Spaces support to the October 22 alpha (`0.0.0-spaces-alpha-20261022141228`). Space credentials are requested with a JSON body and presented with the `Atproto-Space-Credential` scheme. Space hosts resolve through `#atproto_pds`. Commits and records are verified with MACs keyed against each author's `#atproto_kem` key, and full repos arrive as STAR archives. Accounts that haven't published a KEM key can't be synced until their PDS publishes one.

### Patch Changes

- aea592c: Keep the list of legacy communities a user removed from their sidebar when storing and serving client preferences

## 2.29.0

### Minor Changes

- 817469f: Describe legacy community migration state: `legacyCommunityView` gains `state`, `blockedReason`, `owner`, `picture` and `progress`, `communityView` gains `migration`, `community.migrate` returns the queued legacy community, and `clientPreferences` gains `dismissedLegacyCommunities`
- 817469f: Serve Space banners as a 2:1 `spaceBanner` image variant so they fill the Space header without being cropped twice
- dc2a71b: Add `lastMessage` to `social.colibri.beta.thread.defs#threadView`, the latest message in the thread the requesting user may see, in the `channelSummary` shape channel previews use

### Patch Changes

- dc2a71b: Serve attachment images whose stored blob reference is nested, and store blob references in one plain form

## 2.28.0

### Minor Changes

- 5fd5282: Add `gifLoopLimit` to `social.colibri.beta.actor.defs#clientPreferences`, the number of times a GIF in chat plays before it pauses

## 2.27.0

### Minor Changes

- 572ef3b: Add `moveTo` to `social.colibri.beta.voice.moderate` and the `moved` voice signal frame, so moderators can move members between voice channels

## 2.26.0

### Minor Changes

- cb51fa0: Moderators and owners can keep messages a moderator hid out of view, everywhere or in single Spaces. `actor.clientPreferences` and `actor.defs#clientPreferences` gain an optional `hideModeratedMessages` flag. The new `actor.spaceModeration` record, keyed by the community DID, overrides it for one community, and `actor.putSpaceModeration` pushes it with `hideModeratedMessages` or `remove`. `actor.defs#preferences` lists the overrides in `spaceModerations`, and the account permission set covers the new record and procedure. The AppView stores the overrides in the new `space_moderations` table.

## 2.25.0

### Minor Changes

- daa5699: A status can be emoji-only or use a custom emoji. `actor.defs#status` makes `text` optional and gains an optional `customEmoji` ref to a custom emoji record. `actor.setStatus` accepts `customEmoji` and `removeCustomEmoji`. The AppView keeps a status that has only an emoji, stores the custom emoji ref in the new `user_presence.status_custom_emoji` column, and rejects a uri that doesn't name an emoji record.

## 2.24.0

### Minor Changes

- 8eba18b: Link previews carry more of what a page declares. `linkEmbed` gains `themeColor`, `layout`, `provider`, `author`, `publishedAt`, a `media` gallery and a `post` with formatted text, a content warning, engagement counts, a quoted post and the source language of a translation. The AppView reads `theme-color`, `twitter:card`, repeated `og:image` tags, the site icon and `article:published_time`, follows oEmbed links, resolves Mastodon statuses behind ActivityPub alternate links, and resolves X and fixer-domain post links through the FxEmbed API, honoring a trailing language code as a translation request.
- 8eba18b: Store messages and reactions sent in voice channel chats, only push voice chat notifications and edits to people in the call, and add the `inboxPresentation` client preference

## 2.23.0

### Minor Changes

- 54abd78: Reactions can name the emoji record behind a custom shortcode. `social.colibri.beta.reaction` accepts an optional `customEmoji` reference, and `reactionView` and the live `reactionEvent` carry it. A reaction view reports the reference from the earliest reaction that named one.
- 54abd78: Threads can be closed and locked. `social.colibri.beta.thread.update` accepts `closed` and `locked`, and thread views carry `closedAt`, `locked` and the new `canEdit`, `canClose`, `canDelete` and `canLock` viewer flags. The member who opened a thread can rename, close, reopen and delete it while they can still read it. Members with `thread.manage` can do all of that on any thread and can lock it, which leaves writing to them alone. A new message in a closed thread reopens it.

## 2.22.0

### Minor Changes

- 384edf8: Every community has a Members role that everyone holds from the moment they join, so members can start threads. It can be edited but not deleted or taken away from anyone, it can't be mentioned, and communities and members missing it get it back automatically

## 2.21.0

### Minor Changes

- 3e21750: `thread.listMembers` lists who belongs to a thread: the author of the anchor message, everyone who posted in it or had messages moved into it, everyone mentioned in it directly or through a role they hold, and everyone who follows it

## 2.20.0

### Minor Changes

- d2236e7: `social.colibri.beta.channel.defs#channelSummary` has an optional `facets` array with the latest message's annotations, so channel list previews can render custom emoji. Custom emoji the community's policy disallows are left out.
- d2236e7: Users can follow a custom emoji pack or a single custom emoji. A follow is a private `social.colibri.beta.emoji.follow` record in the user's preferences space that points at the owner's pack or emoji, so renames, new images and pack membership changes reach followers.
  
  - `emoji.putFollow` pushes a follow record to the AppView, and a call without `subject` removes it.
  - `emoji.getLibrary` returns the user's own emoji plus everything they follow, each with an `available`, `missing` or `unreachable` state.
  - `emojiLibraryEvent` carries the whole library to a user's connections when their own emoji change, their follows change, or the owner of something they follow changes their emoji. It replaces `emojiEvent` for a user's own emoji, and `emojiEvent` now only covers community emoji.
  - `emojiView` no longer has `copyOf`.
  - The account permission set covers the follow record, `emoji.putFollow` and `emoji.getLibrary`, so existing sessions ask for consent again on their next sign-in.

## 2.19.0

### Minor Changes

- 56da297: Communities can have custom emoji and emoji packs. They're stored as Bluemoji records in the community's own repo, any repo's emoji can be listed with `emoji.getCatalog`, and changes reach clients live through `emojiEvent`.

## 2.18.0

### Minor Changes

- bf32399: Adds optional `width` and `height` to message attachments. The AppView passes them through to `width` and `height` on attachment views when both are positive integers.
- 25670ca: Clearing the inbox now clears it on every device, the channel list shows each channel's latest message in one request, jumping to an older message opens right at it, notifications name their thread, and the invites list updates live.
- 8e4e6c1: Adds `social.colibri.beta.notification.markReadFromNotification`, an unauthenticated procedure that marks a channel or thread read from a signed push token, and grants it in `social.colibri.beta.permissionPush`. Push payloads carry `type`, `kind`, `spaceName`, `placeName`, `subtitle`, `body`, `badge`, `readUrl` and `readToken`. APNs alerts use the author as title, the in-app subtitle, the unread badge, `ping.caf` and the `message` category. Reading a channel, deleting a message and editing a message send `read`, `delete` and `edit` background pushes to APNs and FCM devices. Set `PUSH_ACTION_SECRET` to sign the read tokens.
- bf32399: Adds optional `camera` and `screen` flags to `social.colibri.beta.actor.defs#voiceState`. The AppView sets them from each participant's video producers and sends a voice `update` event to the community when a camera or screen share starts or stops, so clients can show who is sharing in channels they haven't joined.

## 2.17.0

### Minor Changes

- 9034d25: `social.colibri.beta.message#attachment` takes an optional `alt` string of up to 2000 graphemes. `social.colibri.beta.channel.defs#attachmentView` serves it when the author set one.
- 9034d25: `social.colibri.beta.actor.profile` takes an optional `pronouns` string of up to 64 graphemes. The profile view in `social.colibri.beta.actor.defs` serves the resolved `pronouns`, which fall back to the Bluesky profile's pronouns when `syncBluesky` is on and the Colibri record sets none.
- 58b7b76: The `social.colibri.beta.permissionMessaging` permission set now grants `read`, `create`, `update` and `delete` on `social.colibri.beta.message` and `social.colibri.beta.reaction` in voice channel spaces

## 2.16.0

### Minor Changes

- 3f9768e: `social.colibri.beta.channel.update` takes `removeLinkEmbeds`, which clears a channel's link preview setting so the community default applies again. A `linkEmbeds` value in the same call takes precedence.

## 2.15.0

### Minor Changes

- ac08881: Adds an optional `spoiler` flag to `social.colibri.beta.message#attachment` and `social.colibri.beta.channel.defs#attachmentView`. The AppView copies the flag from each stored attachment into the message and forward views it serves.
- ac08881: Adds per-user state that follows a user across devices:
  
  - `social.colibri.beta.actor.clientPreferences` holds client settings such as gesture controls, theme, link options, the Bluesky client, developer mode, voice view options and experiments.
  - `social.colibri.beta.actor.composerState` holds emoji usage, skin tone and recent GIFs.
  - `social.colibri.beta.actor.spaceNotification` sets a notification level for one community, keyed by its DID. `social.colibri.beta.actor.putSpaceNotification` pushes it to the AppView.
  - `notificationLevel` accepts `nothing`, which drops every notification, mentions included.
  - `social.colibri.beta.actor.mute` accepts `#mutedThread` subjects.
  
  `putSettings` takes `clientPreferences` and `composerState`, and `getPreferences`, `putSettings` and `preferencesEvent` return them together with `spaceNotifications`. Notification fan-out uses a community's level over the global one. The account permission set covers the new collections and procedure.

## 2.14.0

### Minor Changes

- d698add: Adds ownership transfer, category permissions and a custom emoji facet. The new `community.transferOwnership` procedure gives a member every protected owner role the caller holds and then removes those roles from the caller, who keeps their other roles. The category record, `category.create`, `category.update` and the category view gain `ownerOnly`, `allowedRoles`, `allowedMembers`, `visibleToRoles` and `visibleToMembers`, and the view adds `private`. A channel in a category inherits the category's read audience unless it sets its own `visibleToRoles` or `visibleToMembers`, and inherits its posting rules unless it sets its own `ownerOnly`, `allowedRoles` or `allowedMembers`. Space credentials, channel lists and live events all follow the inherited rules. The rich text facet gains `#customEmoji`, which points at an emoji record by `uri` and `cid` over the emoji's fallback text, and bridged messages keep that fallback text. The community settings record, `community.update` and the community view gain `customEmoji`, which is `all`, `local` or `none`. Message views drop custom emoji facets the community's policy disallows and keep the fallback text under them.
- d698add: Keeps read state in step across a user's sessions. The new `sync.defs#readCursorEvent` carries a community and the read cursors that moved, and `channel.putReadCursors` sends it to every session of the caller. A read record that arrives through sync sends it too. `putReadCursors` and the read record projection keep the newer cursor per channel or thread, and leave channels the write omits untouched, so a cursor from a stale device never moves read state backwards. The `@colibri-social/projections` package exports the merge as `mergeReadCursors`. Following or unfollowing a thread sends the follower's sessions a `threadEvent` update with their new viewer state. A `seenEvent` sent for `notification.updateSeenForMessage` names the message in a new optional `message` field, so other sessions can clear that notification.
- d698add: Lets the other side of a bridge disconnect it. `/colibri disconnect` disconnects a Discord server from Colibri, with an optional `community` option that autocompletes the communities the server is paired with. `BridgeContext` gains `connections()`, which lists a remote space's registrations, and `disconnect()`, which leaves all of them or the one community given and counts a registration already revoked in Colibri as disconnected. Bridge registration views carry an optional `communityName`.

## 2.13.0

### Minor Changes

- 8e3c854: Adds direct APNs push for iOS and macOS, configured with `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID`, and includes the sender's name and avatar in every push.
- 6b3d5ef: Adds role badges and a Space-wide name colour override. A role carries an optional `badge`, either an icon from the client's curated set with an optional colour or an uploaded image of up to 256 KB. `role.create` and `role.update` take an icon badge, `role.update` clears one with `removeBadge`, and the new `role.putBadgeImage` uploads an image badge as the community. Role views return the badge with image badges served through a signed members-space link. The community settings record, `community.create`, `community.update` and the community view gain `overrideUserNameColors`, which hides members' own name colours in chat so only role colours show, and a member without a coloured role gets the default name colour.
- ef70f83: Targets the 2026-10-01 atproto Spaces alpha. Space credentials are bound with HTTP Message Signatures and carry the audience of each request, a revoked or rejected credential is replaced once through a fresh delegation, sync follows `spaceRev` and catches up from `listRepos` after a gap, and `createSpace` sends `spaceType`. The vendored space lexicons move to atproto `679724ad`.
- 6b3d5ef: Raises the status text limit from 32 to 64 bytes and adds `expiresAt` and `showWhileOffline` to the status. `actor.setStatus` takes both fields and clears an expiry with `removeExpiresAt`. Presence views and events leave out a status once its expiry has passed. `showWhileOffline` defaults to false and is passed through for clients to apply.

## 2.12.1

### Patch Changes

- 326c689: Adds `bridge.leave` and `bridge.replaceAvatar`, so a bridge revokes its registration when a Discord server removes it, purges its local data for revoked registrations, and swaps a changed avatar on the author's earlier bridged records

## 2.12.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel
- c80c110: Adds the optional `DEFAULT_COMMUNITY_DID` setting, which `describeServer` reports as `defaultCommunity` so clients can join new users to it
- d8e32d1: Spaces now carry separate read and write policies, and a space credential no longer implies the right to post

## 2.11.0

### Minor Changes

- 1ed3c64: Presence now carries one activity per service an actor shares from, including what they are playing on atmosphere.games

## 2.10.0

### Minor Changes

- 4a7247d: A message can now carry a forwarded copy of another message, and the AppView serves it with its source channel or thread resolved

### Patch Changes

- b6f4239: Moved messages are now served at the correct point in time, not appended

## 2.9.1

### Patch Changes

- 58aea35: Let a thread follow the message it was opened from: thread.repoint takes an optional anchor so a rewritten message can be pointed at, and thread.moveMessages carries a thread whose anchor was moved into the destination channel

## 2.9.0

### Minor Changes

- 305fd99: Add the thread space type, the thread and follow records, the thread methods, and the `moved` label that serves a message from another space

## 2.8.0

### Minor Changes

- d7c4b6f: Stop invitations from bypassing join approval

## 2.7.0

### Minor Changes

- eebf5ef: Show what someone is listening to when they turn on shareActivity, read from the teal.fm records on their own account

## 2.6.0

### Minor Changes

- bad9064: Add an optional `indent` to `social.colibri.beta.richtext.facet#list` so nested list items can carry their depth

## 2.5.0

### Minor Changes

- 07d1508: Give each account a single voice session. Joining a voice channel now retires that account's other voice sockets with a `superseded` reason, so a second device takes the call over instead of running alongside it, and nobody can sit in two channels at once. A handover within the same channel keeps the participant record, so the rest of the room sees the media move rather than a leave followed by a rejoin.
  
  Along with it, a set of voice fixes:
  
  - A frame the SFU cannot serve is answered with an error instead of rejecting unhandled, which could take the process down when Sentry was not configured.
  - A server mute now pauses every audio producer rather than only the one declaring `mic`, survives the muted account reconnecting, and can be applied before that account carries any media.
  - Voice connections release their topic subscriptions when they close, and frames from one socket are handled in order, so a socket can no longer leave a channel claiming it forever.
  - A transport mediasoup reports as closed or failed is closed rather than only forgotten, releasing its ports and its producers instead of replaying dead producers to everyone who joins.
  - The speaking indicator settles after the debounce window even when no further audio arrives, and clears when a speaker leaves mid-word.
  - A room whose worker died is torn down, so presence stops reporting its participants as being in a call.
  - `produce`, `consume` and `setSelfState` no longer conjure a participant from a frame naming an unknown transport, which used to announce a phantom join to the whole community.
  - Joining replays who is already in the room and what moderation applies to them, and producer frames carry `paused`.
  - Presence is claimed before the room is created, so two devices racing to create transports cannot leave one of them live in an untracked room.
  - `SFU_ICE_SERVERS` reaches clients through `transportOptions`, so configured STUN and TURN servers are used instead of silently dropped.

### Patch Changes

- 38dc331: Sign an attachment's media link for each recipient of a live message event, so a blob in a permissioned space loads without waiting for a reload. Declare the viewer, exp and sig params on social.colibri.beta.blob.get

## 2.4.0

### Minor Changes

- 1c863c7: Keep a community picture, banner and message attachment after it is saved, by converting blob references between their json and lexicon forms at every boundary
- d175422: Deliver messages as soon as they are written instead of sometimes waiting for the next sweep, by no longer dropping a write notification that arrives while a sync is already running, renewing the notify registration on its own schedule, and publishing a message before its notifications are indexed
- d2c8938: Gate voice joins on the same permission as posting, and disconnect a participant whose access changes mid-call

## 2.3.0

### Minor Changes

- 152a8fb: Publish the `sync.defs#preferencesEvent` and `voice.defs#disconnected` frames, which shipped in the AppView but never reached the package

## 2.2.0

### Minor Changes

- efcadc8: Type `voice.defs#transportOptions.iceCandidates` as an array of unknown
- efcadc8: Make community migration work against a real legacy repo, and give it a picker
- efcadc8: Let a mute name a channel
- efcadc8: Separate a peer's own mute from a moderator's

## 2.1.0

### Minor Changes

- 396e6ef: Report `software` and `flavor` from `server.describeServer` again, so a client can tell a Colibri AppView from any other host
- 396e6ef: Store a favourited GIF as the whole `embed.defs#gifView`, because an identifier cannot be turned back into one

## 2.0.0

### Major Changes

- 229dde3: Make cross-AppView communities discoverable, and let a community bring its own DID

### Minor Changes

- a39c928: Give communities a working picture and banner write path

## 1.0.0

### Major Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

### Patch Changes

- bd2a38c: Enforce `hidden` labels server-side instead of forwarding them as advice

## 0.1.0

### Minor Changes

- 42ec07e: Initial release
