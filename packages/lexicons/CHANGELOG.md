# @colibri-social/lexicons

## 2.46.1

### Patch Changes

- 5e5d3b2: `federation.deliverNotification`, `federation.deliverRead` and `federation.retract` declare an empty JSON output, like every other method, and the AppView answers them with an empty object.

## 2.46.0

### Minor Changes

- 8e55a30: Delivers notifications to the other AppViews a user declared:
  
  - When a message notifies someone, the managing AppView queues a `federation.deliverNotification` call for each AppView in the recipient's `actor.appview` record other than itself. The call carries the rendered notification plus the Space and channel names for the push banner. `deliverNotification` has new optional `spaceName` and `channelName` inputs.
  - The main node sends queued deliveries right away and checks the queue every 15 seconds. A failed delivery is tried again after 30 seconds, 2, 10 and 30 minutes, then hourly. Deliveries still undelivered after 24 hours are dropped, as are deliveries the other AppView refuses for good. They live in the new `federation_deliveries` table, added by migration 0050.
  - The receiving AppView accepts a delivery when the caller manages the notification's Space and the recipient declared the receiving AppView. Blocked peers and the per-peer rate limit apply. It stores the notification with its view, sends it to the user's sockets, counts it toward the badge and pushes it. A repeated delivery for the same message is ignored.
  - `listNotifications` serves a delivered notification from its stored view.
- 5621e4c: Hosts a polyfilled user's repo for a Space on the AppView that manages that Space:
  
  - `polyfill.uploadBlob` and `polyfill.getBlob` take an optional `space` parameter. When another AppView manages that Space, the call goes there, so a blob sits next to the repo that references it. Without the parameter, both calls stay on this AppView.
  - `polyfill.beginMigration` also starts the migration on every AppView that manages one of the caller's remote Spaces and returns their spaces with its own. An AppView that refuses or doesn't answer is skipped, and calling `beginMigration` again picks it back up.
- 01dc960: `actor.grantSpaceAccess` takes an optional `community`, which sends the grant to the AppView that manages that community. The new `remote_spaces` table holds the user's `actor.remoteSpace` records, and `actor.listCommunities` lists those communities next to local ones in the stored order. Communities whose AppView doesn't answer within 3 seconds come back in `unavailable`
- fb47131: `getCommunity` reports in `viewer.preferencesAccessUntil` until when this AppView can read the caller's preferences space. The field is missing when it holds no access, so a client on another AppView knows to grant access again. `SpaceCredentials` has a new `expiry(space)` method that returns the expiry of a held credential.
- 56371fd: Add per-group sound volumes and keep polyfilled blobs readable while the main node drains:
  
  - `social.colibri.beta.actor.clientPreferences` and `actor.defs#clientPreferences` have a `soundVolumes` object (`actor.defs#soundVolumes`) with a volume in percent for the `ping`, `presence`, `mic` and `video` sound groups. The AppView stores and returns it with the other client preferences.
  - Every node reads and writes SeaweedFS directly at `POLYFILL_S3_CLUSTER_ENDPOINT` and falls back to reading through the main node when SeaweedFS can't be reached. The SeaweedFS bucket, region, keys and path style setting are shared cluster config, so a failover node holding the main role serves blobs, accepts uploads and sweeps unreferenced blobs.
- 1c16c11: Add the federation lexicons: `community.host` and `actor.appview` records, the `actor.remoteSpace` preferences record, and the `federation.deliverNotification`, `deliverRead` and `retract` procedures, which answer `FederationDisabled` on an AppView that opted out. `community.getInvitation` takes an optional `community`, `actor.listCommunities` returns unreachable communities in `unavailable`, `describeServer` knows the `federation` feature, and `permissionAccount` covers the new user records

### Patch Changes

- 5137ec8: The `actor.remoteSpace` record description now covers every community the user joined, whichever AppView manages it.
- 858fcd1: Tighten federation between AppViews:
  
  - `deliverNotification`, `deliverRead` and `retract` answer `NotJoined` when the recipient has no `remote_spaces` row for the community, and `deliverNotification` refuses a channel or thread outside the notification's community. A failed host or declaration lookup answers `UpstreamFailure` with a 502.
  - A delivered notification is dropped when the recipient blocked its author or muted the author, community, channel or thread. Listing delivered notifications applies the recipient's blocks.
  - A `colibri-acting-for` request is only accepted on forwarded methods and `polyfill.beginMigration`. Other methods answer `ActingForNotAllowed`.
  - Forwards and deliveries refuse endpoints on private, loopback, link-local or unique-local addresses outside development and test. An oversized or interrupted answer counts as unreachable and the router answers 502.
  - With `FEDERATION_ENABLED=false`, the router decides from the local `communities` table alone. Personal spaces never trigger a host lookup.
  - Deliveries retry `NotDeclared` and `NotJoined`, and each queued row is claimed before it's sent, so two runners never send the same row. A failed declared AppViews lookup is cached as empty for a minute.
  - Checks against this AppView's DID accept every alias in `APPVIEW_DID_ALIASES`.
  - Migration 0051 removes duplicate notifications, keeping the earliest, and adds a unique index on `notifications (recipient, space, message_author, message_rkey)`. Inserts into `notifications` ignore conflicts.

## 2.45.0

### Minor Changes

- dbd18da: Move to the `0.0.0-spaces-alpha-20261124235736` atproto packages, which address spaces as `at:space/{did}/{type}/{skey}`, drop the `legacySpaceUris` feature and `LEGACY_SPACE_URIS`, rewrite stored `at://{did}/space/...` URIs to the new form, and keep indexing records that still embed the old form

## 2.44.0

### Minor Changes

- c8bfd4b: Add the `legacySpaceUris` feature to `describeServer`, controlled by `LEGACY_SPACE_URIS` (on by default), which tells clients to send space URIs in the `at://{did}/space/...` form

## 2.43.0

### Minor Changes

- ff95f38: Serve community profile images to invited non-members, and add the bridged author's profile to channel summaries as `authorProfile`

## 2.42.0

### Minor Changes

- 6cd05d3: Open-channel bridges get the same events and actions as linked rooms.
  
  **Breaking changes in `@colibri-social/bridge-core`:**
  
  - `NetworkConnector` is split into `Connector` (`platform`, `start`, `stop`) and `RelayConnector`, which adds `listRooms` and `sendMessage`. A connector that only works in open channels implements `OpenChannelConnector` and skips both.
  - `receiveChannelMessage` is replaced by `openMessage`, which receives the author with their `standing` (member, owner, roles, permissions), `replyTo`, `attachments`, `embeds`, `forward` and the message's `did` and `rkey`.
  - `BridgeContext.reply()` is replaced by `openEmit()`. It posts, edits, deletes and hides messages, adds and removes reactions, and creates, renames and deletes threads in open channels. Posted authors can have an avatar. It returns the new record key and any attachments it could not upload.
  - `ColibriClient.listMessages` takes an options object and returns `{ messages, cursor }`.
  - `OutboundMessage` and `OutboundEdit` carry `embeds`.
  
  **New in `@colibri-social/bridge-core`:**
  
  - Optional open-channel callbacks `openEditMessage`, `openDeleteMessage`, `openRemoveMessage` (a moderator hid the message), `openAddReaction`, `openRemoveReaction`, `openCreateThread`, `openUpdateThread`, `openDeleteThread` and `openChannelsChanged` (the bridge was installed or removed, or its open channels changed).
  - Threads under open channels are subscribed and delivered with `thread` set.
  - `BridgeContext` gains `openChannels()`, `message()`, `history()` and `member()`.
  - Attachments carry `alt` and `spoiler` both ways, plus `size`, `width` and `height` outbound. Dropped attachments are logged as `bridge.attachment.dropped`.
  - Frames for the bridge's own open-channel deletes, hides and threads are not delivered back to it.
  
  **`@colibri-social/bridge-discord`:** alt text and spoilers carry across both ways. Colibri link previews that Discord can't unfurl are sent as embeds, on edits too.
  
  **AppView and lexicons:**
  
  - New query `social.colibri.beta.bridge.getMember` returns an account's membership, ownership, roles and effective permissions, optionally for one channel.
  - `social.colibri.beta.bridge.createThread` accepts open channels.
  - Bridges can call `social.colibri.beta.thread.listThreads` with a `channel` and `getThread` for threads they may read. `listMessages` includes thread views for those threads. `permissionBridge` covers `getMember`, `listThreads` and `getThread`.
  - A bridge's message posts, edits, deletes and reaction adds stream one frame each. The pipeline no longer repeats the frame the bridge route already announced. Bridge message delete frames include `subjectUri`.
  - Bridge lexicon descriptions and `ChannelNotLinked` errors name linked or open channels.
  - `social.colibri.beta.bridge.install` accepts a bridge whose DID document has no `#atproto_pds` service, such as one from `bridgeDidDocument()`. It resolves the bridge with the new `IdentityResolver.resolveServiceIdentity`, which needs only a signing key.
  - `snowglobe.yml` has a `bridge` app with the DID `did:web:bridge.app.colibri.local.snowglobe.at`, and `pnpm dev:bridge:snowglobe` runs the bridge on the local network.
- 1a985c7: Add `social.colibri.beta.sync.defs#bridgeUpdateEvent`. The AppView sends it to members with `community.manage` when a bridge reports remote rooms or history import progress.

## 2.41.0

### Minor Changes

- 0d28440: Bridges that set up rooms with commands, such as Lightning, can connect to a community without a pairing code. `social.colibri.beta.bridge.install` takes a community and the bridge's handle or DID and writes a registration with platform `external`, the community DID as its remote space, and no linked or open channels. It answers `BridgeNotFound` when the handle or DID doesn't resolve and `AlreadyRegistered` when the bridge is already installed.
  
  Registrations gain an optional `channels` list of open channels, set through `bridge.update`. A bridge may read, subscribe to and post in an open channel and in its unrestricted threads without a room on the other service. `links` keep working as before.
  
  `social.colibri.beta.bridge.listChannels` lists a community's text channels that every member can read to the bridge holding the registration, with `viewer.canRead` and `viewer.canPost` set for the channels open to it. `permissionBridge` includes it, and `permissionCommunity` includes `bridge.install`. In `@colibri-social/bridge-core`, `ColibriClient.listChannels` calls it and `BridgeContext` gains `channels(community, registration)`.
  
  A bridge-core connector that implements `receiveChannelMessage` hears every new message in the open channels of its enabled registrations, as `OpenChannelMessage` with the author and the text as markdown. It skips edits, imported history and the bridge's own posts. `BridgeContext.reply()` posts in an open channel under a remote author's name, optionally as a reply to a message, and returns the new record key.

## 2.40.0

### Minor Changes

- 6cf84e8: Add the `message.react` channel permission. It controls adding and removing reactions apart from `message.send`, so members can react in channels where they can't post. Every member holds it by default, existing Spaces get it on their default role, and channel and category overrides can allow or deny it. Reacting in a voice channel's chat also needs `voice.chat`. A channel's legacy posting allow list applies to reactions too. Projection admission checks each collection in a change on its own.
  
  Unfurl Klipy GIF page links through the Klipy items API. `embed.defs#gifView` gains optional `videoUrl` and `mimeType` fields for GIFs served as video, and saved GIF favorites keep both fields.

## 2.39.2

### Patch Changes

- 38bbf47: Create the profile space of new and migrated Spaces as a managed space that only members can read. Non-members still get the name, description and images from the AppView. The AppView no longer switches existing profile spaces to public reads on startup. The workspace uses pnpm 12.21.0

## 2.39.1

### Patch Changes

- bb5fbb6: List every collection of the preferences space and the voice channel space in their lexicons, drop `voiceSelfState` from the client frames in the events socket description, remove the unused `MESSAGE_RETENTION_DAYS` and `ADMIN_PASSWORD` settings, require Node 24.22.3, and move the README's guides to the documentation site.

## 2.39.0

### Minor Changes

- e7543ed: Adds per-category and per-channel permission overrides for roles and single members. Each override sets a channel permission to Allow or Deny, and anything it leaves out inherits.
  
  The AppView resolves a permission in a channel in this order:
  
  - The member's own override wins.
  - Otherwise the highest role the member holds that sets the permission decides it. The default role ranks lowest.
  - A channel that leaves the permission open falls back to its category, then to the member's role permissions.
  
  Seeing and posting are now permissions: `channel.view`, `message.send` and `voice.connect`. Without `channel.view` a member has no other permission in that channel. Owners and holders of the owner role still get everything.
  
  Permission changes reach connected clients right away. The event socket sends each affected viewer a `channelEvent` update carrying their new `channelView`, and the voice socket mutes, closes producers or disconnects members who lose `voice.speak`, a sharing permission, `voice.connect` or `channel.view`. A member moved into a hidden voice channel keeps their voice permissions there. Notifications now check `channel.view` and `voice.chat` for every recipient.
  
  At startup the Members role gains `channel.view`, `message.send` and `voice.connect` once, and every category, channel and role record is rewritten from the old audience fields to overrides. Until a Space is rewritten, the AppView keeps honoring the old fields and grants the three new permissions to every member.
  
  Lexicons:
  - New `social.colibri.beta.defs#permissionOverride` with `role` or `member`, `allow` and `deny`.
  - `permissionOverrides` on the `channel` and `category` records, the `channel.create`, `channel.update`, `category.create` and `category.update` inputs, and `channelView` and `categoryView`. Setting overrides needs `role.manage`, a permission you hold for every changed key, and a target role below your own.
  - `ownerOnly`, `allowedRoles`, `allowedMembers`, `visibleToRoles` and `visibleToMembers` are gone from those inputs and views. On the records they are deprecated.
  - `channelOverrides` is gone from `roleView` and `role.update`, and deprecated on the `role` record.
  - New permissions `channel.view`, `message.send` and `voice.connect`, plus `CHANNEL_PERMISSIONS` and `normalizePermissionOverrides`.
  
  `@colibri-social/community` adds `healPermissionOverrides`, `legacyToOverrides`, `isPrivateScope` and `BASELINE_PERMISSIONS`. `has` takes a `ChannelState` instead of a channel key. `@colibri-social/appview-db` adds a `permission_overrides` column to `channels` and `categories`.
- 61e8260: Adds `social.colibri.beta.polyfill.*`, the methods through which the AppView hosts space repos for accounts whose PDS can't host spaces yet, and moves them to the PDS once it can:
  
  - `getStatus` reports where the caller's repos live (`polyfill`, `migrating` or `native`) and whether their PDS supports spaces.
  - `applyWrites`, `getRecord` and `listRecords` write and read the caller's hosted repos.
  - `uploadBlob` and `getBlob` store and return the caller's attachments.
  - `beginMigration`, `listForMigration` and `completeMigration` copy the hosted repos to the PDS and verify each one.
  
  `social.colibri.beta.permissionAccount` now grants all of them.
- 6c5818a: Adds `recordExplorer` to `social.colibri.beta.actor.clientPreferences` and `social.colibri.beta.actor.defs#clientPreferences`. It names the site developer mode links open in, `pdsls` or `atprotoAt`, and the AppView stores and returns it with the other client preferences.

## 2.38.0

### Minor Changes

- c9104d3: Adds lexicons for four methods the AppView serves:
  
  - `social.colibri.beta.sync.subscribeEvents`, the live updates WebSocket. Its messages are the server frames in `social.colibri.beta.sync.defs`.
  - `social.colibri.beta.voice.subscribeSignals`, the voice signaling WebSocket. Its messages are the server frames in `social.colibri.beta.voice.defs`.
  - `social.colibri.beta.embed.getImage` and `getVideo`, which proxy link embed media through signed URLs.
  
  `social.colibri.beta.permissionMessaging` now grants all four.
- 3b3b2b7: Moves Spaces support to the November 12, 2026 alpha (`0.0.0-spaces-alpha-20261112204144`). PDSes on the November 5 alpha can't talk to this release.
  
  The AppView now serves three new protocol methods and drops the old ones:
  
  - `com.atproto.managedspace.checkAccess` replaces `checkUserAccess`. It answers `read` and `write` together, and answers both as `false` when the request names no repo.
  - `com.atproto.space.confirmRegistration` echoes the challenge when the token is the one the AppView issued for that space.
  - `com.atproto.space.notifySpaceUpdate` replaces `notifyWrite` and `notifySpaceDeleted`. It authenticates with the per-space token in the body and rejects any other token with `InvalidRequest`. A deletion notice only drops the space once reauthorizing answers `SpaceDeleted`.
  
  The sync engine registers for notifications through `authorizeSpaceSync` and reauthorizes every space before its credential expires. A writer the space host lists as removed is dropped. A repo whose host answers `RepoNotFound` is kept as an empty repo.
  
  `notify_registrations` stores a stable random token per space in place of the service ID. The migration drops existing registrations, and the AppView registers again on its next authorization.
  
  Lexicons:
  - The vendored `com.atproto.space`, `memberspace`, `managedspace` and `personalspace` lexicons follow atproto `d4def6e9`.
  - The eight `social.colibri.beta` space types name themselves with `title` in place of `name`.
  
  `@colibri-social/space`:
  - `SpaceClient.listWriters` and `allWriters` replace `listRepos` and `allRepos`, and return `repoWrite` and `repoRemoved` entries. `registerNotify` and `unregisterNotify` are gone.
  - `SpaceCredentials` takes a `notify` provider, reports `spaceRev`, and adds `reauthorize`. `AccountNotAuthorized` counts as a refusal. `RegistrationNotConfirmed` and `UpstreamFailure` count as upstream failures.
  - MACs use `Accept-Signature` and HTTP Message Signatures. `MacProof` carries `keyShare`, `sharedSecret` and the response `headers`.
  - `PdsClient.putMembers` and `removeMembers` replace `putMember` and `removeMember`. `createSpace`, `getSpace` and `listSpaces` return `space` in place of `uri`.
  
  `@colibri-social/identity`:
  - `IdentityResolver` takes an optional `fetch`. The alpha `@atproto/identity` resolves through an SSRF-protected fetch that refuses `http:` and private addresses, so the AppView passes the platform fetch outside production and whenever `PLC_URL` is plain `http:`. `DidDocumentSpaceHostResolver` in `@colibri-social/space` takes the same option.
  
  `@colibri-social/space-sync`:
  - `SpaceSyncEngine` drops the `syncerService` option and adds `notifyRepoRemoved`, `confirmSpaceDeleted` and `renewLapsedRegistration`.
- 4bcbcf0: Moderators with `voice.moderate` in the destination can move a member into a voice channel that member can't see. The member joins the call there, without access to its text chat. Access ends when they leave, disconnect or join another channel, so they can't rejoin on their own. `social.colibri.beta.voice.moderate` no longer returns `DestinationForbidden`.
  
  `@colibri-social/appview-db` adds the `voice_move_grants` table.
- 4bcbcf0: Adds voice permissions that admins can set per role and per channel. Every member keeps them by default.
  
  - `voice.speak`: members without it stay muted. Their screen share sound still plays.
  - `voice.listen`: members without it can't hear the call. Cameras and screen shares still show.
  - `voice.camera` and `voice.screenshare`: members without them can't turn on their camera or share their screen.
  - `voice.chat`: members without it can't read or post in the voice channel's text chat.
  
  When an admin changes these mid-call, the AppView applies them right away, stops any camera or screen share the member lost, and tells their client. A moderator unmute never lifts a mute that comes from a missing permission.
  
  The Members role of every Space gains the five permissions once at startup. Removing them later sticks. Spaces whose credentials are missing keep their current Members role until the owner signs in again.
  
  Lexicons:
  - `social.colibri.beta.voice.defs#joined` lists the member's voice permissions in `permissions`.
  - New `social.colibri.beta.voice.defs#permissionsChanged` frame with the updated list.
  - `social.colibri.beta.voice.defs#moved` carries the destination's `channelView` in `view`, and in `after` the nearest channel before it in its category that the member can read.
  - `serverMuted` and `serverDeafened` also cover a missing `voice.speak` or `voice.listen`.
  
  `@colibri-social/community` adds `voiceCapabilities` and `voicePermissionKeys`. `@colibri-social/voice` adds `VoiceSfu.setRestriction`, `restrictionOf` and `moderationOf`.

## 2.37.0

### Minor Changes

- aea9292: Add the foundation for running the AppView as a network of nodes.
  
  Lexicons:
  - `social.colibri.beta.server.listNodes` lists the nodes that accept clients, each with a region, roles, an endpoint and a probe URL.
  - `describeServer` can report the `nodes` feature.
  - The sync socket gains a `drainNotice` frame, a `writeState` frame and a `ReadOnly` error.
  - Voice signaling gains `migrationProposal`, `rttReport`, `migrateTo`, `moveNow` and `callElsewhere`. `joined` carries the node ID and region, and `disconnected` adds the `nodeClosed` and `migrated` reasons.
  - `attachmentView` has an optional `previewUrl` for a smaller inline image.
  - `listMessages` can name `unavailableAuthors` when a page is missing messages from an unreachable PDS.
  
  Database:
  - New tables for the node registry, join tokens, cluster config and state, voice call placement, oversized event payloads and telemetry state.
  - New columns: `presence_connections.node_id`, `space_repos.host` and `messages.rehydrated_at`.
  - `Database.ping()` checks the connection on SQLite and Postgres.
  - `openTestDatabase` creates a throwaway Postgres database when `TEST_DATABASE_URL` is set.
  
  AppView:
  - `/health` works on Postgres.
  - New settings: `ROLES`, `NODE_ID`, `NODE_REGION`, `MAIN_NODE_URL`, `DATABASE_READ_URL`, `DRAIN_GRACE_MINUTES`, `WRITE_QUEUE_SECONDS`, `MESSAGE_RETENTION_DAYS`, `SFU_RTC_PORT`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`, `BLOB_DISK_CACHE_DIR`, `BLOB_DISK_CACHE_MAX_BYTES`, `COLIBRI_TELEMETRY_DISABLED` and `DO_NOT_TRACK`. Nothing reads them yet.

### Patch Changes

- 19be678: Update Spaces support to the November 5 alpha (`0.0.0-spaces-alpha-20261105160032`). STAR archives from `getRepo` use the new control-byte framing through the `@atproto/space` helpers, so the AppView needs a PDS on the same alpha. `@atproto/star` is pinned to the alpha build, because its caret range otherwise resolves to a broken `0.0.0-stage` release. The vendored atproto space lexicons move to `704b9e2a`, which adds `RepoTakendown` and `RepoDeactivated` to `getSpaceCredential` and `listRepos`. A suspended space keeps its synced data and retries, as before.

## 2.36.0

### Minor Changes

- d52006b: Add private user blocks. The `social.colibri.beta.actor.block` record lives in the personal preferences space, one record per blocked DID, and `social.colibri.beta.actor.putBlocks` pushes the whole list to the AppView. `defs#preferences` gains `blocks`, so `getPreferences` and the live preferences event carry it. A blocked author's messages produce no notification or push for the blocker, a ping from them no longer brings the blocker back into a thread they left, and their existing notifications leave the blocker's inbox, unread count and badge. The new `blocks` table is added by migration 0033 and is purged on account deletion.
- 9d42e5c: Add the `setConsumerPreference` voice frame. A viewer sets the highest simulcast or SVC layer it wants for one of its consumers and can pause it while its tile is off screen. A viewer pause survives `resumeConsumer` and undeafen, and deafen still keeps audio paused. Screen share video gets twice the priority of cameras when bandwidth is short, and send transports cap incoming media at 20 Mbps.
- e3aa164: Hold back push notifications while the recipient is active on another device. Clients send the new `activity` sync frame while they are visible and focused, and each one keeps the account active for 5 minutes. Notification rows still land, so unread and mention badges keep counting. A message in a channel that any of the account's devices has open skips both the row and the push.
  
  Track the channel in view and the activity per connection in the new `presence_connections` table, so one device no longer overwrites another's view. Connections refresh their row every 30 seconds, and rows older than 2 minutes are ignored and swept at startup, which clears views left behind by a restart. The `viewing_channel` column on `user_presence` is dropped.
  
  Voice channel messages and edits no longer push to anyone, since the only people they reached were the call's participants. The notification rows stay.
- e3aa164: Address reactions and replies by full record URI. `social.colibri.beta.reaction` gains an optional `uri` and `social.colibri.beta.message` an optional `parentUri`, next to the existing `target` and `parent` references. The projections read the URI first and fall back to the reference when the URI is missing, unparseable, in another space, or in another collection. `bridge.addReaction` takes an optional `uri`, and `bridge.postMessage` and `bridge.importMessages` take an optional `parentUri`. Records the community writes for a bridge carry both forms.
  
  `reactionEvent` gains `uri` for the target message and `reaction` for the reaction record itself, and its `target` now follows the URI when the record has one. Deleting a reaction record now publishes a `reactionEvent` with `event: "delete"`. A `messageEvent` delete carries `subjectUri`. `RecordDelete` in `@colibri-social/space-sync` carries the removed record's `previous` value when the store held it. `@colibri-social/space` adds `sameSpaceRecordPointer`, `tryParseSpaceRecordUri` and `trySpaceRecordUri`.

## 2.35.0

### Minor Changes

- 7480051: Add the `setSpeaking` voice frame. A client that sends it decides its own speaking state, and the server stops using the audio level for that member. Clients that never send it keep the level-based state. Muting, by the member or a moderator, always clears the speaking state. Every speaking change now also goes out as a `voiceEvent` with `event: "speaking"` on the community's live feed.
- a6eb9be: Add the `codecUnsupported` voice frame. When a viewer can't decode the video codec of a screen share, the SFU answers the viewer's `consume` with a `NotFound` error and sends `codecUnsupported` with the `producerId` to the sharer's session, at most once per producer. The sharer can then produce the screen share again with a more widely supported codec. Microphone and camera consumption are unchanged.
- b3f77f4: Update Spaces support to the October 29 alpha (`0.0.0-spaces-alpha-20261029171913`). The vendored atproto lexicons move to `5d88b414` and replace `com.atproto.simplespace` with the `com.atproto.space` lifecycle methods and the `memberspace`, `managedspace` and `personalspace` policies. `PdsClient.createSpace` and `updateSpace` take a single `policy`, built with `memberspacePolicy` or `managedspacePolicy`. Community profile spaces are created as a member space with `publicRead`, and every other community space as a managed space. The AppView serves `com.atproto.managedspace.checkUserAccess`, treats `SpaceNotFound` from `getSpaceCredential` as a refusal, and on startup moves existing profile spaces to the public member space policy.

## 2.34.0

### Minor Changes

- f583cda: Store a volume for in-app sound effects with the other client preferences, so the setting follows you across devices

## 2.33.0

### Minor Changes

- ea8de44: Add the optional `hideOwnerBadge` boolean to `social.colibri.beta.community.settings`, the community view in `social.colibri.beta.community.defs`, and the `social.colibri.beta.community.update` input.
- ea8de44: Add emoji role badges: `#emojiBadge` in the `social.colibri.beta.role` badge union, `roleEmojiBadge` and `roleEmojiBadgeView` in `social.colibri.beta.community.defs`, and the optional `emojiBadge` input on `social.colibri.beta.role.create` and `social.colibri.beta.role.update`. A badge holds either a Unicode `emoji` or a `customEmoji` reference.

## 2.32.0

### Minor Changes

- 7097dbf: Let `social.colibri.beta.actor.putMutes` carry an optional `leftThreads` list next to `mutes`, which is now optional too. Each list a request carries replaces the stored copy, and a list it leaves out stays as it is. `getPreferences` returns the list as `leftThreads`. A user who left a thread gets no plain message notifications for it and drops out of its member list unless they follow it. A mention or a reply in the thread brings them back and removes the entry. The new `left_threads` table holds the list.
- 73d1143: Let owners host a community on an account of their own through OAuth, and move a community account off this AppView's PDS. `social.colibri.beta.community.authorizeHost` starts a sign-in as the community account, which adopts it as a new community or reconnects an existing one, and `getHostAuthorization` reports the outcome. `getHosting` tells administrators where the account lives and whether the AppView needs a new sign-in. `handOverHost` sets the owner's email on an account this AppView hosts and returns a new password that works for 60 minutes, after which the AppView replaces it unless the account moved. A community whose account moved to another server asks for a sign-in again, and its password is no longer reset on this AppView's PDS. Host sign-in needs `HOST_OAUTH_PRIVATE_KEY`, and `HOST_OAUTH_RETURN_URL` sets where the browser lands afterwards. The permission set for managing communities includes the four new methods.

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
