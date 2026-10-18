# @colibri-social/appview

## 2.21.0

### Minor Changes

- 384edf8: Every community has a Members role that everyone holds from the moment they join, so members can start threads. It can be edited but not deleted or taken away from anyone, it can't be mentioned, and communities and members missing it get it back automatically

### Patch Changes

- 384edf8: Notifications, push banners and edit pushes for bridged messages show the remote author's name and avatar instead of the community. `hydrateNotifications` takes a `NotificationAuthors` object with an optional `resolveMessageAuthor`, and `deliverMessageEdited` accepts a sender per recipient
- 384edf8: `blob.get` streams large blobs while it checks their CID, so the AppView no longer holds whole videos in memory. A CID mismatch found at the end aborts the connection. The blob cache only keeps blobs up to 16 MB, keys entries by DID, space and CID, and shares one upstream fetch between concurrent requests for the same blob. Blobs outside the media types are served as sandboxed `application/octet-stream` downloads, and missing and rejected blobs are logged with a code. `XrpcClient.stream` applies its timeout to the response headers only and aborts a body that sends nothing for `idleTimeoutMs`, 30 seconds by default
- 384edf8: Link previews for YouTube come from YouTube's oEmbed endpoint. Watch, `youtu.be`, Shorts, live, embed, mobile and YouTube Music links resolve to one canonical watch URL that keeps a `t` timestamp. The preview shows the video title, the channel name as its description, "YouTube" as the site name, and the largest available thumbnail with its real dimensions, vertical for Shorts where YouTube has one. When oEmbed refuses a video, the preview falls back to the watch page with a consent cookie and `hl=en`, and a consent page fails the preview. Every outbound embed fetch sends `accept-language: en-US,en;q=0.9`, and page fetches send an HTML `accept` header. Failed unfurls are logged with a code.
- Updated dependencies [384edf8]
- Updated dependencies [384edf8]
- Updated dependencies [384edf8]
- Updated dependencies [384edf8]
  - @colibri-social/notifications@1.8.0
  - @colibri-social/lexicons@2.22.0
  - @colibri-social/appview-db@0.14.0
  - @colibri-social/projections@1.11.0
  - @colibri-social/community@2.10.0
  - @colibri-social/blobs@0.1.0
  - @colibri-social/space@0.7.0
  - @colibri-social/embeds@0.1.0
  - @colibri-social/space-sync@0.5.4

## 2.20.0

### Minor Changes

- 3e21750: `thread.listMembers` lists who belongs to a thread: the author of the anchor message, everyone who posted in it or had messages moved into it, everyone mentioned in it directly or through a role they hold, and everyone who follows it

### Patch Changes

- Updated dependencies [3e21750]
  - @colibri-social/lexicons@2.21.0
  - @colibri-social/notifications@1.7.0
  - @colibri-social/community@2.9.2
  - @colibri-social/projections@1.10.1

## 2.19.0

### Minor Changes

- d2236e7: `social.colibri.beta.channel.defs#channelSummary` has an optional `facets` array with the latest message's annotations, so channel list previews can render custom emoji. Custom emoji the community's policy disallows are left out.
- d2236e7: Users can follow a custom emoji pack or a single custom emoji. A follow is a private `social.colibri.beta.emoji.follow` record in the user's preferences space that points at the owner's pack or emoji, so renames, new images and pack membership changes reach followers.
  
  - `emoji.putFollow` pushes a follow record to the AppView, and a call without `subject` removes it.
  - `emoji.getLibrary` returns the user's own emoji plus everything they follow, each with an `available`, `missing` or `unreachable` state.
  - `emojiLibraryEvent` carries the whole library to a user's connections when their own emoji change, their follows change, or the owner of something they follow changes their emoji. It replaces `emojiEvent` for a user's own emoji, and `emojiEvent` now only covers community emoji.
  - `emojiView` no longer has `copyOf`.
  - The account permission set covers the follow record, `emoji.putFollow` and `emoji.getLibrary`, so existing sessions ask for consent again on their next sign-in.

### Patch Changes

- 2881825: `social.colibri.beta.blob.get` responses allow any web origin to read them, so clients can fetch signed media links from script and read range headers
- Updated dependencies [d2236e7]
- Updated dependencies [d2236e7]
  - @colibri-social/lexicons@2.20.0
  - @colibri-social/appview-db@0.13.0
  - @colibri-social/projections@1.10.0
  - @colibri-social/emoji@0.2.0
  - @colibri-social/community@2.9.1
  - @colibri-social/notifications@1.6.2

## 2.18.0

### Minor Changes

- 56da297: Communities can have custom emoji and emoji packs. They're stored as Bluemoji records in the community's own repo, any repo's emoji can be listed with `emoji.getCatalog`, and changes reach clients live through `emojiEvent`.

### Patch Changes

- Updated dependencies [56da297]
  - @colibri-social/lexicons@2.19.0
  - @colibri-social/appview-db@0.12.0
  - @colibri-social/community@2.9.0
  - @colibri-social/space@0.6.0
  - @colibri-social/emoji@0.1.0
  - @colibri-social/notifications@1.6.1
  - @colibri-social/projections@1.9.4
  - @colibri-social/blobs@0.0.8
  - @colibri-social/space-sync@0.5.3

## 2.17.0

### Minor Changes

- bf32399: Adds optional `width` and `height` to message attachments. The AppView passes them through to `width` and `height` on attachment views when both are positive integers.
- 25670ca: Clearing the inbox now clears it on every device, the channel list shows each channel's latest message in one request, jumping to an older message opens right at it, notifications name their thread, and the invites list updates live.
- 7d1d763: Fills `embeds` on message views with link previews for up to five links per message, skipping links the author suppressed. Reads wait up to 2 seconds for previews that aren't cached yet. Live message events go out right away and are followed by an `update` event once a pending preview resolves. Direct image and video links become image or video embeds without fetching a page. Previews stay cached for 6 hours, and failed links are retried after 5 minutes.
- 8e4e6c1: Adds `social.colibri.beta.notification.markReadFromNotification`, an unauthenticated procedure that marks a channel or thread read from a signed push token, and grants it in `social.colibri.beta.permissionPush`. Push payloads carry `type`, `kind`, `spaceName`, `placeName`, `subtitle`, `body`, `badge`, `readUrl` and `readToken`. APNs alerts use the author as title, the in-app subtitle, the unread badge, `ping.caf` and the `message` category. Reading a channel, deleting a message and editing a message send `read`, `delete` and `edit` background pushes to APNs and FCM devices. Set `PUSH_ACTION_SECRET` to sign the read tokens.
- bf32399: Adds optional `camera` and `screen` flags to `social.colibri.beta.actor.defs#voiceState`. The AppView sets them from each participant's video producers and sends a voice `update` event to the community when a camera or screen share starts or stops, so clients can show who is sharing in channels they haven't joined.

### Patch Changes

- Updated dependencies [bf32399]
- Updated dependencies [25670ca]
- Updated dependencies [8e4e6c1]
- Updated dependencies [bf32399]
  - @colibri-social/lexicons@2.18.0
  - @colibri-social/notifications@1.6.0
  - @colibri-social/appview-db@0.11.0
  - @colibri-social/voice@0.2.0
  - @colibri-social/community@2.8.4
  - @colibri-social/projections@1.9.3

## 2.16.0

### Minor Changes

- 9034d25: `social.colibri.beta.message#attachment` takes an optional `alt` string of up to 2000 graphemes. `social.colibri.beta.channel.defs#attachmentView` serves it when the author set one.
- 9034d25: `social.colibri.beta.actor.profile` takes an optional `pronouns` string of up to 64 graphemes. The profile view in `social.colibri.beta.actor.defs` serves the resolved `pronouns`, which fall back to the Bluesky profile's pronouns when `syncBluesky` is on and the Colibri record sets none.

### Patch Changes

- Updated dependencies [9034d25]
- Updated dependencies [9034d25]
- Updated dependencies [58b7b76]
  - @colibri-social/lexicons@2.17.0
  - @colibri-social/community@2.8.3
  - @colibri-social/notifications@1.5.2
  - @colibri-social/projections@1.9.2

## 2.15.0

### Minor Changes

- 3f9768e: `social.colibri.beta.channel.update` takes `removeLinkEmbeds`, which clears a channel's link preview setting so the community default applies again. A `linkEmbeds` value in the same call takes precedence.

### Patch Changes

- Updated dependencies [3f9768e]
  - @colibri-social/lexicons@2.16.0
  - @colibri-social/community@2.8.2
  - @colibri-social/notifications@1.5.1
  - @colibri-social/projections@1.9.1

## 2.14.0

### Minor Changes

- ac08881: Adds an optional `spoiler` flag to `social.colibri.beta.message#attachment` and `social.colibri.beta.channel.defs#attachmentView`. The AppView copies the flag from each stored attachment into the message and forward views it serves.
- ac08881: Adds per-user state that follows a user across devices:
  
  - `social.colibri.beta.actor.clientPreferences` holds client settings such as gesture controls, theme, link options, the Bluesky client, developer mode, voice view options and experiments.
  - `social.colibri.beta.actor.composerState` holds emoji usage, skin tone and recent GIFs.
  - `social.colibri.beta.actor.spaceNotification` sets a notification level for one community, keyed by its DID. `social.colibri.beta.actor.putSpaceNotification` pushes it to the AppView.
  - `notificationLevel` accepts `nothing`, which drops every notification, mentions included.
  - `social.colibri.beta.actor.mute` accepts `#mutedThread` subjects.
  
  `putSettings` takes `clientPreferences` and `composerState`, and `getPreferences`, `putSettings` and `preferencesEvent` return them together with `spaceNotifications`. Notification fan-out uses a community's level over the global one. The account permission set covers the new collections and procedure.

### Patch Changes

- 4eac24a: Fixes message paging past the second page. `channel.listMessages` and thread message lists now return a cursor on every page that has more messages after it, in both directions, so clients can load a channel's full history.
- Updated dependencies [ac08881]
- Updated dependencies [ac08881]
- Updated dependencies [ac08881]
  - @colibri-social/lexicons@2.15.0
  - @colibri-social/space-sync@0.5.2
  - @colibri-social/appview-db@0.10.0
  - @colibri-social/projections@1.9.0
  - @colibri-social/notifications@1.5.0
  - @colibri-social/community@2.8.1

## 2.13.0

### Minor Changes

- d698add: Adds ownership transfer, category permissions and a custom emoji facet. The new `community.transferOwnership` procedure gives a member every protected owner role the caller holds and then removes those roles from the caller, who keeps their other roles. The category record, `category.create`, `category.update` and the category view gain `ownerOnly`, `allowedRoles`, `allowedMembers`, `visibleToRoles` and `visibleToMembers`, and the view adds `private`. A channel in a category inherits the category's read audience unless it sets its own `visibleToRoles` or `visibleToMembers`, and inherits its posting rules unless it sets its own `ownerOnly`, `allowedRoles` or `allowedMembers`. Space credentials, channel lists and live events all follow the inherited rules. The rich text facet gains `#customEmoji`, which points at an emoji record by `uri` and `cid` over the emoji's fallback text, and bridged messages keep that fallback text. The community settings record, `community.update` and the community view gain `customEmoji`, which is `all`, `local` or `none`. Message views drop custom emoji facets the community's policy disallows and keep the fallback text under them.
- d698add: Keeps read state in step across a user's sessions. The new `sync.defs#readCursorEvent` carries a community and the read cursors that moved, and `channel.putReadCursors` sends it to every session of the caller. A read record that arrives through sync sends it too. `putReadCursors` and the read record projection keep the newer cursor per channel or thread, and leave channels the write omits untouched, so a cursor from a stale device never moves read state backwards. The `@colibri-social/projections` package exports the merge as `mergeReadCursors`. Following or unfollowing a thread sends the follower's sessions a `threadEvent` update with their new viewer state. A `seenEvent` sent for `notification.updateSeenForMessage` names the message in a new optional `message` field, so other sessions can clear that notification.
- d698add: Lets the other side of a bridge disconnect it. `/colibri disconnect` disconnects a Discord server from Colibri, with an optional `community` option that autocompletes the communities the server is paired with. `BridgeContext` gains `connections()`, which lists a remote space's registrations, and `disconnect()`, which leaves all of them or the one community given and counts a registration already revoked in Colibri as disconnected. Bridge registration views carry an optional `communityName`.

### Patch Changes

- 94d8628: Keeps the last cached profile when refreshing it from the PDS fails, so a rate limit or timeout no longer returns a blank profile or overwrites the cache
- Updated dependencies [d698add]
- Updated dependencies [d698add]
- Updated dependencies [d698add]
  - @colibri-social/lexicons@2.14.0
  - @colibri-social/appview-db@0.9.0
  - @colibri-social/projections@1.8.0
  - @colibri-social/community@2.8.0
  - @colibri-social/notifications@1.4.1

## 2.12.0

### Minor Changes

- 8e3c854: Adds direct APNs push for iOS and macOS, configured with `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID`, and includes the sender's name and avatar in every push.
- 6b3d5ef: Adds role badges and a Space-wide name colour override. A role carries an optional `badge`, either an icon from the client's curated set with an optional colour or an uploaded image of up to 256 KB. `role.create` and `role.update` take an icon badge, `role.update` clears one with `removeBadge`, and the new `role.putBadgeImage` uploads an image badge as the community. Role views return the badge with image badges served through a signed members-space link. The community settings record, `community.create`, `community.update` and the community view gain `overrideUserNameColors`, which hides members' own name colours in chat so only role colours show, and a member without a coloured role gets the default name colour.
- 6b3d5ef: Raises the status text limit from 32 to 64 bytes and adds `expiresAt` and `showWhileOffline` to the status. `actor.setStatus` takes both fields and clears an expiry with `removeExpiresAt`. Presence views and events leave out a status once its expiry has passed. `showWhileOffline` defaults to false and is passed through for clients to apply.

### Patch Changes

- bb5a859: Serves community pictures and banners from the profile space through per-viewer signed links, and answers a missing public blob with 404.
- f7b360b: Allows the `sentry-trace` and `baggage` request headers in CORS preflights, so browsers can call `com.atproto.identity.resolveHandle` directly and users with DNS-only handles can sign in
- 5640cde: Stops retrying sync for authors whose DID document has no `#atproto_pds` service, and logs the message and cause of every `error` field.
- 08eebc0: Routes pushes for thread messages to the parent channel and thread, and sends Android pushes as data-only messages so tapping one opens the right message.
- ef70f83: Targets the 2026-10-01 atproto Spaces alpha. Space credentials are bound with HTTP Message Signatures and carry the audience of each request, a revoked or rejected credential is replaced once through a fresh delegation, sync follows `spaceRev` and catches up from `listRepos` after a gap, and `createSpace` sends `spaceType`. The vendored space lexicons move to atproto `679724ad`.
- Updated dependencies [8e3c854]
- Updated dependencies [bb5a859]
- Updated dependencies [5640cde]
- Updated dependencies [08eebc0]
- Updated dependencies [6b3d5ef]
- Updated dependencies [ef70f83]
- Updated dependencies [6b3d5ef]
  - @colibri-social/appview-db@0.8.0
  - @colibri-social/lexicons@2.13.0
  - @colibri-social/notifications@1.4.0
  - @colibri-social/blobs@0.0.7
  - @colibri-social/identity@0.2.1
  - @colibri-social/space-sync@0.5.1
  - @colibri-social/projections@1.7.0
  - @colibri-social/community@2.7.0
  - @colibri-social/space@0.5.0

## 2.11.1

### Patch Changes

- 326c689: Adds `bridge.leave` and `bridge.replaceAvatar`, so a bridge revokes its registration when a Discord server removes it, purges its local data for revoked registrations, and swaps a changed avatar on the author's earlier bridged records
- Updated dependencies [326c689]
  - @colibri-social/community@2.6.1
  - @colibri-social/lexicons@2.12.1
  - @colibri-social/notifications@1.3.3
  - @colibri-social/projections@1.6.1

## 2.11.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel
- c80c110: Adds the optional `DEFAULT_COMMUNITY_DID` setting, which `describeServer` reports as `defaultCommunity` so clients can join new users to it

### Patch Changes

- 88fba3e: Jetstream now drops a cursor the server rejects as too old and keeps a single reconnect in flight
- 68649af: The appview answers XRPC errors itself, so client errors no longer print a stack trace to the console
- c13dd17: The sync engine can now ask the appview whether a space is renewable at all, and parks the ones that are not without warning on every startup
- a949e8a: The notification routes now accept a thread space, so unseen counts and seen markers work inside threads
- Updated dependencies [6e75d20]
- Updated dependencies [c80c110]
- Updated dependencies [c13dd17]
- Updated dependencies [d8e32d1]
  - @colibri-social/appview-db@0.7.0
  - @colibri-social/community@2.6.0
  - @colibri-social/identity@0.2.0
  - @colibri-social/lexicons@2.12.0
  - @colibri-social/projections@1.6.0
  - @colibri-social/space@0.4.0
  - @colibri-social/space-sync@0.5.0
  - @colibri-social/notifications@1.3.2
  - @colibri-social/blobs@0.0.6

## 2.10.0

### Minor Changes

- 1ed3c64: Presence now carries one activity per service an actor shares from, including what they are playing on atmosphere.games

### Patch Changes

- Updated dependencies [1ed3c64]
  - @colibri-social/lexicons@2.11.0
  - @colibri-social/appview-db@0.6.0
  - @colibri-social/space@0.3.0
  - @colibri-social/community@2.5.2
  - @colibri-social/notifications@1.3.1
  - @colibri-social/projections@1.5.1
  - @colibri-social/blobs@0.0.5
  - @colibri-social/space-sync@0.4.1

## 2.9.0

### Minor Changes

- 4a7247d: A message can now carry a forwarded copy of another message, and the AppView serves it with its source channel or thread resolved

### Patch Changes

- b6f4239: Moved messages are now served at the correct point in time, not appended
- Updated dependencies [4a7247d]
- Updated dependencies [b6f4239]
  - @colibri-social/lexicons@2.10.0
  - @colibri-social/appview-db@0.5.0
  - @colibri-social/projections@1.5.0
  - @colibri-social/notifications@1.3.0
  - @colibri-social/community@2.5.1

## 2.8.0

### Minor Changes

- 58aea35: Give the owner role every permission, including ones added after the community was made: permission checks now treat the protected role the way they already treated the community itself, and a sweep at startup writes any missing permissions back onto the record
- 58aea35: Serve threads: a thread space projects to its own table, access follows the parent channel and the thread's own visibility, and the thread methods create, rename, repoint, delete and move messages between spaces. Notifications now check that the recipient may read the space, which stops a mention in a private channel or thread reaching someone outside it.

### Patch Changes

- 58aea35: Stamp the type on a thread's anchor message so getThread can serve it, keep a failing anchor lookup from taking the thread with it, carry the thread itself on activity frames so message counts stay current without a reload, and let a moved message be sent back to the channel it came from
- 58aea35: Let a thread follow the message it was opened from: thread.repoint takes an optional anchor so a rewritten message can be pointed at, and thread.moveMessages carries a thread whose anchor was moved into the destination channel
- 58aea35: Honour a write hint for any space the writer can read rather than only one it is subscribed to, so a message written into a thread nobody is watching is picked up at once, and announce a retracted move to both spaces so the message returns to its channel and leaves the thread without a reload
- Updated dependencies [58aea35]
- Updated dependencies [58aea35]
- Updated dependencies [58aea35]
  - @colibri-social/community@2.5.0
  - @colibri-social/lexicons@2.9.1
  - @colibri-social/appview-db@0.4.0
  - @colibri-social/notifications@1.2.0
  - @colibri-social/projections@1.4.0
  - @colibri-social/space-sync@0.4.0

## 2.7.2

### Patch Changes

- Updated dependencies [305fd99]
  - @colibri-social/lexicons@2.9.0
  - @colibri-social/community@2.4.1
  - @colibri-social/notifications@1.1.6
  - @colibri-social/projections@1.3.5

## 2.7.1

### Patch Changes

- 145f753: Show the wide link card for sites that ship an OpenGraph image without `og:image:width` and `og:image:height`
- b03c206: Exit on a fatal error so the container restarts clean, guard the async paths that could reach one, and cap the repo CAR buffer
- 4fe3ad3: Fixes a crash within the fetch handler
- Updated dependencies [145f753]
- Updated dependencies [b03c206]
- Updated dependencies [4fe3ad3]
  - @colibri-social/embeds@0.0.1
  - @colibri-social/space-sync@0.3.2
  - @colibri-social/voice@0.1.3

## 2.7.0

### Minor Changes

- 636530e: Find cover art for more tracks. Artwork resolution now tries MusicBrainz and Deezer alongside Cover Art Archive and iTunes, and `VIDEO_ARTWORK_ENABLED` adds a YouTube search for uploads no music database carries
- 64d9500: Improve actor hydration, cache handle/identity resolution, fix listMembers `cursor` and `role` parameters usage, `getUnseen` index building improvements, add `space` to `notifications_unseen_idx`
- d7c4b6f: Stop invitations from bypassing join approval
- 2b382d8: Read listening activity from rocksky.app and atradio.fm alongside teal.fm, and pick up the `fm.teal.alpha.actor.status` records a lot of accounts write instead of the current collection

### Patch Changes

- 1d48890: Stop retrying spaces the AppView cannot mint a credential for. A space that fails with `noDelegationToken` now goes dormant instead of retrying `registerNotify` every minute and failing every sweep, and a fresh grant from the client wakes it again. A space whose owning community is gone is dropped outright, and purging a community now tells the sync engine so its spaces leave the registration map
- 5c3cf2b: Only use a YouTube still when the video is the scrobbled track. Title and channel must both match, and anything short of that falls back to the activity icon
- Updated dependencies [1d48890]
- Updated dependencies [64d9500]
- Updated dependencies [d7c4b6f]
- Updated dependencies [f0d57a4]
  - @colibri-social/space-sync@0.3.1
  - @colibri-social/appview-db@0.3.0
  - @colibri-social/identity@0.1.0
  - @colibri-social/notifications@1.1.5
  - @colibri-social/community@2.4.0
  - @colibri-social/lexicons@2.8.0
  - @colibri-social/projections@1.3.4

## 2.6.0

### Minor Changes

- eebf5ef: Show what someone is listening to when they turn on shareActivity, read from the teal.fm records on their own account

### Patch Changes

- Updated dependencies [eebf5ef]
  - @colibri-social/lexicons@2.7.0
  - @colibri-social/appview-db@0.2.1
  - @colibri-social/projections@1.3.3
  - @colibri-social/community@2.3.2
  - @colibri-social/notifications@1.1.4

## 2.5.1

### Patch Changes

- f67763b: Tell an invited user they are banned, and keep moderation log entries to the moderators
- 45707d5: Leave a channel read when the newest message in it is your own
- 1669210: Wait for every mediasoup worker subprocess to exit before the appview process does, so a restart no longer fails on ports the old workers still hold
- 16a342d: Announce a voice join as soon as the peer joins, not when it creates its first transport
- f67763b: Ask Opus for DTX alongside inband FEC, and cap the initial outgoing bitrate estimate
- Updated dependencies [bad9064]
- Updated dependencies [1669210]
- Updated dependencies [16a342d]
- Updated dependencies [f67763b]
  - @colibri-social/lexicons@2.6.0
  - @colibri-social/voice@0.1.2
  - @colibri-social/community@2.3.1
  - @colibri-social/notifications@1.1.3
  - @colibri-social/projections@1.3.2

## 2.5.0

### Minor Changes

- b1bbb1a: Scope channel events and live delivery to the people who may read the channel
- 321e7dc: Tell every member when a community is deleted and drop its data straight away, so it stops being listed and stops being served the moment its owner deletes it instead of lingering until its PDS reports the deletion. Deleting a community now also deletes its channel spaces, and a community whose profile space disappears out of band is reconciled the same way.

### Patch Changes

- 38dc331: Sign an attachment's media link for each recipient of a live message event, so a blob in a permissioned space loads without waiting for a reload. Declare the viewer, exp and sig params on social.colibri.beta.blob.get
- dc9ea5c: Reconcile a mute by its subject rather than its record key, so the immediate `actor.putMutes` push and the later repo sync of the same mute no longer collide on the one-mute-per-subject index and strand the user's preferences space with an unapplied cursor
- b1e2b73: Run each actor's presence transitions in order, so a socket that opens and closes in quick succession can no longer swallow the offline broadcast and leave that member listed as online for everyone else
- dc9ea5c: Default the SFU's RTC port range to 40000-40100, the range the compose file publishes. With neither `SFU_RTC_MIN_PORT` nor `SFU_RTC_MAX_PORT` set, transports took a port from mediasoup's own 10000-59999 default, so almost every candidate pointed at a port nothing forwarded and calls failed to connect.
- f29b7d4: Publish the SFU's media port range for TCP as well as UDP, so the ICE over TCP fallback the SFU advertises can be reached. A port Docker does not forward drops the connection attempt without a reply, which fails ICE and leaves callers in silence.
- 324a3e6: Move commit verification and repo recovery onto worker threads, so a large repo no longer stalls message delivery for every other channel. Set SYNC_WORKER_THREADS to turn it on
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
- Updated dependencies [321e7dc]
- Updated dependencies [38dc331]
- Updated dependencies [dc9ea5c]
- Updated dependencies [dc9ea5c]
- Updated dependencies [324a3e6]
- Updated dependencies [07d1508]
  - @colibri-social/community@2.3.0
  - @colibri-social/space-sync@0.3.0
  - @colibri-social/lexicons@2.5.0
  - @colibri-social/projections@1.3.1
  - @colibri-social/voice@0.1.1
  - @colibri-social/notifications@1.1.2

## 2.4.0

### Minor Changes

- d2c8938: Gate voice joins on the same permission as posting, and disconnect a participant whose access changes mid-call

### Patch Changes

- a9cea8f: Give a new community a random handle, so provisioning no longer fails on the PDS handle length limit
- 1c863c7: Keep a community picture, banner and message attachment after it is saved, by converting blob references between their json and lexicon forms at every boundary
- d175422: Deliver messages as soon as they are written instead of sometimes waiting for the next sweep, by no longer dropping a write notification that arrives while a sync is already running, renewing the notify registration on its own schedule, and publishing a message before its notifications are indexed
- 88810f6: Serve your own profile straight from your PDS, so a change you just saved comes back instead of the cached one
- Updated dependencies [a9cea8f]
- Updated dependencies [1c863c7]
- Updated dependencies [d175422]
- Updated dependencies [a35adfc]
- Updated dependencies [132dd5a]
- Updated dependencies [d2c8938]
  - @colibri-social/community@2.2.1
  - @colibri-social/lexicons@2.4.0
  - @colibri-social/projections@1.3.0
  - @colibri-social/space-sync@0.2.1
  - @colibri-social/space@0.2.1
  - @colibri-social/notifications@1.1.1
  - @colibri-social/blobs@0.0.4

## 2.3.1

### Patch Changes

- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
  - @colibri-social/community@2.2.0
  - @colibri-social/space@0.2.0
  - @colibri-social/identity@0.0.1
  - @colibri-social/projections@1.2.1
  - @colibri-social/lexicons@2.3.0
  - @colibri-social/notifications@1.1.0
  - @colibri-social/space-sync@0.2.0
  - @colibri-social/blobs@0.0.3

## 2.3.0

### Minor Changes

- 22ad3fb: Announce channel, category, role, community, membership, profile and status changes to the community over the socket, and answer every voice frame a client waits on
- 22ad3fb: Keep a channel's visibility lists when projecting its record, and tell the community over the socket when a channel or category changes
- 22ad3fb: Resolve a community's handle from its DID document, and log every 5xx an XRPC route produces
- b5c5283: Answer CORS on `/xrpc`, including on error responses, and stop the catchall from shadowing the blob route
- 9c7e4d2: Serve embed images and video through the AppView again, answer handle and DID resolution for clients, deliver push notifications, honor muted channels, tell a peer when it is disconnected from a call, report errors to Sentry, and report progress while migrating
- 22ad3fb: Keep using a space credential that is still valid when nothing can mint a delegation token for it
- 912b790: Handle the typing and viewChannel frames, keep notifications quiet for the channel someone is reading, and send the notification, seen, application, moderation and community-progress events that were declared but never published
- 912b790: Report progress while migrating a legacy community, and announce a label the moment it is applied so a hidden message disappears live
- 22ad3fb: Add a `preferencesEvent` sync frame and send it to an actor's own devices when their preferences change
- 22ad3fb: Derive an actor's online state from their open event sockets, and broadcast it to the communities they belong to
- 22ad3fb: Sweep a channel space against its member list, so a member's repo is found and kept even when the authority's writer set leaves it out

### Patch Changes

- 9c7e4d2: Honor a role's per-channel overrides when checking `label.apply`, and keep every env file out of the Docker build context

## 2.2.0

### Minor Changes

- efcadc8: Make community migration work against a real legacy repo, and give it a picker
- efcadc8: Let a mute name a channel
- efcadc8: Follow profile records on Jetstream
- 0e3df75: Record every space in the `spaces` table at the moment it is created, so the sync
  engine can find it
- efcadc8: Refuse to boot on a bare-IP `did:web`
- efcadc8: Separate a peer's own mute from a moderator's

### Patch Changes

- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [0e3df75]
- Updated dependencies [efcadc8]
  - @colibri-social/lexicons@2.2.0
  - @colibri-social/community@2.1.0
  - @colibri-social/projections@1.2.0
  - @colibri-social/voice@0.1.0
  - @colibri-social/notifications@1.0.3

## 2.1.0

### Minor Changes

- 396e6ef: Report `software` and `flavor` from `server.describeServer` again, so a client can tell a Colibri AppView from any other host
- 396e6ef: Store a favourited GIF as the whole `embed.defs#gifView`, because an identifier cannot be turned back into one

### Patch Changes

- Updated dependencies [396e6ef]
- Updated dependencies [396e6ef]
  - @colibri-social/lexicons@2.1.0
  - @colibri-social/projections@1.1.0
  - @colibri-social/appview-db@0.2.0
  - @colibri-social/community@2.0.1
  - @colibri-social/notifications@1.0.2

## 2.0.0

### Major Changes

- 229dde3: Close the `blob.get` authorization hole without breaking browser media, also fixes the cache headers
- 229dde3: Make cross-AppView communities discoverable, and let a community bring its own DID

### Minor Changes

- a39c928: Give communities a working picture and banner write path

### Patch Changes

- Updated dependencies [a39c928]
- Updated dependencies [229dde3]
  - @colibri-social/lexicons@2.0.0
  - @colibri-social/community@2.0.0
  - @colibri-social/appview-db@0.1.0
  - @colibri-social/notifications@1.0.1
  - @colibri-social/projections@1.0.1

## 1.0.0

### Major Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

### Patch Changes

- bd2a38c: Enforce `hidden` labels server-side instead of forwarding them as advice
- Updated dependencies [49310eb]
- Updated dependencies [bd2a38c]
  - @colibri-social/lexicons@1.0.0
  - @colibri-social/space@0.1.1
  - @colibri-social/space-sync@0.1.1
  - @colibri-social/projections@1.0.0
  - @colibri-social/community@1.0.0
  - @colibri-social/notifications@1.0.0
  - @colibri-social/blobs@0.0.2

## 0.1.0

### Minor Changes

- 42ec07e: Initial release

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/lexicons@0.1.0
  - @colibri-social/space@0.1.0
  - @colibri-social/space-sync@0.1.0
  - @colibri-social/community@0.0.1
  - @colibri-social/notifications@0.0.1
  - @colibri-social/projections@0.0.1
  - @colibri-social/blobs@0.0.1
