# @colibri-social/appview-db

## 0.23.1

### Patch Changes

- 7447c85: Show where each node runs on the status page. Nodes have an optional location, set with `colibri-admin node add --location "Helsinki, Finland"` or `colibri-admin node location <id> [<text>]`, and listed by `node list`. Status page monitors use it as their name and fall back to the node ID. A changed location renames the monitor in place, so its uptime history stays. Region groups are titled by area (Europe, North America, South America, Asia, Oceania, Middle East, Africa) in that order, after the API. Adds a `location` column to `nodes` and `node_join_tokens`.

## 0.23.0

### Minor Changes

- aadf535: Copy a libSQL database into Postgres.
  
  - `colibri-admin db copy --from <libSQL url> --to <Postgres url> [--truncate]` applies the Postgres migrations, then copies every table in batches. JSON columns become `jsonb` and flags become booleans through the shared schema. It checks the row count of every table, and exits with 1 when the counts differ or it refuses to run.
  - It refuses a libSQL database that isn't on the current migrations, and a Postgres database that already has rows unless `--truncate` is passed.
  - `@colibri-social/appview-db` exports `appliedMigrations` and `knownMigrations`.
- 75c544f: Share live events, authorization changes and presence across AppView nodes.
  
  - Every announcement goes through an event bus. On SQLite it stays in memory. On Postgres it uses `LISTEN/NOTIFY` on the primary, in publish order, and payloads over the notify limit travel through `event_payloads`, which the main node clears after 10 minutes.
  - Per-viewer frames travel as recipes. A message carries its rendered view and each node signs it for its own viewers. A thread event names the thread, and each node renders it with the viewer's permissions after its replica has caught up to the publisher's WAL position (up to 2 seconds).
  - `Announcer` drops `toCommunityViewers` and closure frames for `message`, `thread` and `toTopics`. `toBridges` takes a frame.
  - Authorization changes reach every node, so a socket on any node loses a channel it may no longer read.
  - Presence counts sockets on every node. A user stays online while any node holds a fresh socket for them, and the main node sets users offline once no node has one.
  - Each process claims a unique notification clock ID through a Postgres advisory lock, so two writers never mint the same notification ID. `@colibri-social/notifications` exports `setClockId` and `CLOCK_IDS`.
  - `Database.waitForReplay()` waits for a read replica to reach a WAL position. `TestDatabase` exposes its `url`.
- 1205701: Fail the Postgres primary over to the failover node automatically and fence the old one.
  
  - `DATABASE_URL` can list several hosts. `@colibri-social/appview-db` connects to the one that accepts writes and has the highest epoch in `cluster_state`, rechecks every 10 seconds, and moves on read-only and connection errors. Advisory locks and the event bus follow it. It exports `FollowingPool`, `parsePostgresUrl`, `formatPostgresUrl`, `hostUrls`, `probeHost`, `pickPrimary` and `resolvePrimaryUrl`.
  - Every clustered node serves `GET /cluster/alive` on `CLUSTER_PORT` with the time it lost the primary. The failover node promotes its local Postgres (`LOCAL_POSTGRES_URL`, or `DATABASE_READ_URL`) once the primary has been unreachable for `FAILOVER_AFTER_SECONDS` (default 60) for it and for more than half of the nodes without the `main` or `failover` role. Promotion raises the epoch and creates replication slots for the other nodes. Without a witness node it doesn't promote on its own.
  - A writable Postgres with a lower epoch than the primary is fenced: it turns read-only and drops its client and replication connections. Nodes with the SSH key rebuild their own fenced Postgres with `rejoin-replica`, and the main node rebuilds other main and failover nodes.
  - `colibri-admin db failback [<node>]` moves the primary back to a node with the `main` role in a planned switchover. `colibri-admin db promote` promotes a failover node's Postgres by hand.
  - Replicas take a list of primary hosts in `PRIMARY_HOST` and stream with `target_session_attrs=read-write`. The main node's Postgres in `docker-compose.scaled.yml` uses the same entrypoint, so it can be rebuilt as a replica. Its AppView takes `DATABASE_URL` from `.env` when set.
  - Provisioning a failover node runs the new `database-hosts` playbook on every node. `rejoin-replica` takes `primary_hosts` and runs detached on the node that starts it.
- 573ec8e: Register AppView nodes and link them to the main node.
  
  - An AppView with `NODE_ID` set is a cluster node. It registers itself in `nodes` with its region, roles, `NODE_PUBLIC_URL` and `NODE_TAILNET_URL`, heartbeats every 15 seconds with its connection and call counts, and is marked `draining` and then `down` when it stops.
  - Nodes with the `main` or `failover` role listen on `CLUSTER_PORT` (default 3100) for joins and control links. Only the node holding the main lock accepts them.
  - A new node trades a `CLUSTER_JOIN_TOKEN` (valid for an hour, used once) for a node secret, kept in `NODE_SECRET_FILE`. Nodes without the `main` role hold a WebSocket control link to the main node with that secret and reconnect when it drops.
  - The main node handles shutdown and resume orders from the event bus. A shutdown checks the quorum floor (50% of 2, 66% of 3, 75% of 4, 80% of 5 or more nodes staying up) unless forced, then tells the node to drain. A drained node parks in `maintenance` or `retired`, answers every request with 503 and stays parked across restarts until it is resumed.
  - `social.colibri.beta.server.listNodes` lists active nodes that serve clients, with a `/health` probe URL. `describeServer` advertises the `nodes` feature on a clustered AppView.
  - `nodes` gains `secret_hash`.
- 070ae7a: Run AppView nodes by role and shut them down gracefully.
  
  - `ROLES` decides what a node runs. `api` serves XRPC, blobs and embeds. `live` accepts event sockets. `voice` starts the SFU and voice signaling. `main` runs ingest, sweeps, heals and migration jobs, but only on the one node holding the main Postgres advisory lock. Another `main` node waits and takes over when the holder goes away.
  - Migrations run only on `main` nodes, one at a time behind their own advisory lock.
  - `DATABASE_READ_URL` sends reads to a Postgres replica. Writes and transactions stay on `DATABASE_URL`.
  - On SIGTERM or SIGINT a node drains: `/health` answers 503 with the deadline, every event socket gets a `drainNotice`, and the node waits until its connections are gone or the deadline passes. The deadline is `DRAIN_GRACE_MINUTES` (default 120) when other active nodes can take the clients, and 15 seconds when the node is alone. A second signal skips the wait.
  - A node that loses the main lock shuts down with exit code 1, so its supervisor restarts it.
  - `@colibri-social/appview-db` exports `holdLock`, `postgresAdvisoryLock` and `grantedLock`, and `Database.advisoryLock()`.
  - The single-node `docker-compose.yml` gives the container 45 seconds to stop.
- 43899d5: Run voice calls across AppView nodes.
  
  - Each SFU worker listens on one UDP and TCP port through a mediasoup `WebRtcServer`, starting at `SFU_RTC_PORT` (default 40000). `SFU_RTC_MIN_PORT` and `SFU_RTC_MAX_PORT` are removed. The compose file publishes 40000-40031.
  - The SFU reads its settings from the AppView config. `SFU_INITIAL_OUTGOING_BITRATE` is part of it now, and `voiceSfuConfigFromEnv` is removed from `@colibri-social/voice`.
  - A call runs on one node. `voice_calls` pins it there, and a join on another node answers with `callElsewhere`. A call on a node that stopped reporting moves to the next node someone joins on.
  - Who is in a call lives in the new `voice_participants` table, so presence shows voice state from every node and `voice.moderate` reaches a call on any node over the event bus. The main node clears participants of nodes that stopped reporting and announces that they left.
  - Server mutes and deafens are stored per Space member in the new `voice_moderation` table. They apply in every voice channel of the Space and last across calls, restarts and nodes until a moderator lifts them.
  - A call that grows past `SFU_PARTICIPANTS_PER_WORKER` (default 20) participants per worker takes another worker, up to `SFU_WORKER_COUNT`. Its routers pipe every producer to each other, so everyone still hears everyone. New calls start on the worker with the fewest routers.
  - With `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` set, every transport gets Cloudflare TURN credentials valid for 24 hours, next to `SFU_ICE_SERVERS`.
  - When a voice node drains, every call gets a `migrationProposal` with the other voice nodes. Participants answer with `rttReport`, and after `VOICE_MIGRATION_NOTICE_SECONDS` (default 60) or a `moveNow` the call moves with `migrateTo` to the node with the lowest worst-case round trip. A node that shuts down tells remaining callers `nodeClosed`. `joined` carries the node ID and region.
  - `Database` exposes `primary` for reads that can't wait for a replica.

## 0.22.0

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

## 0.21.0

### Minor Changes

- d52006b: Add private user blocks. The `social.colibri.beta.actor.block` record lives in the personal preferences space, one record per blocked DID, and `social.colibri.beta.actor.putBlocks` pushes the whole list to the AppView. `defs#preferences` gains `blocks`, so `getPreferences` and the live preferences event carry it. A blocked author's messages produce no notification or push for the blocker, a ping from them no longer brings the blocker back into a thread they left, and their existing notifications leave the blocker's inbox, unread count and badge. The new `blocks` table is added by migration 0033 and is purged on account deletion.
- e3aa164: Hold back push notifications while the recipient is active on another device. Clients send the new `activity` sync frame while they are visible and focused, and each one keeps the account active for 5 minutes. Notification rows still land, so unread and mention badges keep counting. A message in a channel that any of the account's devices has open skips both the row and the push.
  
  Track the channel in view and the activity per connection in the new `presence_connections` table, so one device no longer overwrites another's view. Connections refresh their row every 30 seconds, and rows older than 2 minutes are ignored and swept at startup, which clears views left behind by a restart. The `viewing_channel` column on `user_presence` is dropped.
  
  Voice channel messages and edits no longer push to anyone, since the only people they reached were the call's participants. The notification rows stay.

## 0.20.1

### Patch Changes

- f583cda: Store a volume for in-app sound effects with the other client preferences, so the setting follows you across devices

## 0.20.0

### Minor Changes

- ea8de44: Add the `hide_owner_badge` column to `communities`.
- ea8de44: Add the `emoji` and `customEmoji` kinds to the `RoleBadge` type stored in the roles `badge` column.

## 0.19.0

### Minor Changes

- 7097dbf: Let `social.colibri.beta.actor.putMutes` carry an optional `leftThreads` list next to `mutes`, which is now optional too. Each list a request carries replaces the stored copy, and a list it leaves out stays as it is. `getPreferences` returns the list as `leftThreads`. A user who left a thread gets no plain message notifications for it and drops out of its member list unless they follow it. A mention or a reply in the thread brings them back and removes the entry. The new `left_threads` table holds the list.
- 73d1143: Let owners host a community on an account of their own through OAuth, and move a community account off this AppView's PDS. `social.colibri.beta.community.authorizeHost` starts a sign-in as the community account, which adopts it as a new community or reconnects an existing one, and `getHostAuthorization` reports the outcome. `getHosting` tells administrators where the account lives and whether the AppView needs a new sign-in. `handOverHost` sets the owner's email on an account this AppView hosts and returns a new password that works for 60 minutes, after which the AppView replaces it unless the account moved. A community whose account moved to another server asks for a sign-in again, and its password is no longer reset on this AppView's PDS. Host sign-in needs `HOST_OAUTH_PRIVATE_KEY`, and `HOST_OAUTH_RETURN_URL` sets where the browser lands afterwards. The permission set for managing communities includes the four new methods.

### Patch Changes

- 3116a04: Read a custom emoji the index hasn't seen yet straight from its owner's PDS and refresh an owner's emoji catalog once it's an hour old. Send the full message, attachments and reply included, with each notification. Answer `listMessages` without waiting for link previews, profiles, or handle checks, and send late link previews as message updates. Keep link previews in the new `link_previews` table so they survive restarts.

## 0.18.1

### Patch Changes

- aea592c: Keep the list of legacy communities a user removed from their sidebar when storing and serving client preferences

## 0.18.0

### Minor Changes

- 817469f: Run legacy community migrations as resumable background jobs that copy bans, serve legacy message history read-only in the migrated channels, mark that history as read for every member and retire the legacy community record when done. A community whose account this AppView can't sign in to moves into a newly provisioned account built from its public records, and its legacy record stays as it is

## 0.17.0

### Minor Changes

- cb51fa0: Moderators and owners can keep messages a moderator hid out of view, everywhere or in single Spaces. `actor.clientPreferences` and `actor.defs#clientPreferences` gain an optional `hideModeratedMessages` flag. The new `actor.spaceModeration` record, keyed by the community DID, overrides it for one community, and `actor.putSpaceModeration` pushes it with `hideModeratedMessages` or `remove`. `actor.defs#preferences` lists the overrides in `spaceModerations`, and the account permission set covers the new record and procedure. The AppView stores the overrides in the new `space_moderations` table.

## 0.16.0

### Minor Changes

- daa5699: A status can be emoji-only or use a custom emoji. `actor.defs#status` makes `text` optional and gains an optional `customEmoji` ref to a custom emoji record. `actor.setStatus` accepts `customEmoji` and `removeCustomEmoji`. The AppView keeps a status that has only an emoji, stores the custom emoji ref in the new `user_presence.status_custom_emoji` column, and rejects a uri that doesn't name an emoji record.

## 0.15.1

### Patch Changes

- 8eba18b: Store messages and reactions sent in voice channel chats, only push voice chat notifications and edits to people in the call, and add the `inboxPresentation` client preference

## 0.15.0

### Minor Changes

- 54abd78: Reactions can name the emoji record behind a custom shortcode. `social.colibri.beta.reaction` accepts an optional `customEmoji` reference, and `reactionView` and the live `reactionEvent` carry it. A reaction view reports the reference from the earliest reaction that named one.
- 54abd78: Threads can be closed and locked. `social.colibri.beta.thread.update` accepts `closed` and `locked`, and thread views carry `closedAt`, `locked` and the new `canEdit`, `canClose`, `canDelete` and `canLock` viewer flags. The member who opened a thread can rename, close, reopen and delete it while they can still read it. Members with `thread.manage` can do all of that on any thread and can lock it, which leaves writing to them alone. A new message in a closed thread reopens it.

## 0.14.0

### Minor Changes

- 384edf8: Every community has a Members role that everyone holds from the moment they join, so members can start threads. It can be edited but not deleted or taken away from anyone, it can't be mentioned, and communities and members missing it get it back automatically

## 0.13.0

### Minor Changes

- d2236e7: Users can follow a custom emoji pack or a single custom emoji. A follow is a private `social.colibri.beta.emoji.follow` record in the user's preferences space that points at the owner's pack or emoji, so renames, new images and pack membership changes reach followers.
  
  - `emoji.putFollow` pushes a follow record to the AppView, and a call without `subject` removes it.
  - `emoji.getLibrary` returns the user's own emoji plus everything they follow, each with an `available`, `missing` or `unreachable` state.
  - `emojiLibraryEvent` carries the whole library to a user's connections when their own emoji change, their follows change, or the owner of something they follow changes their emoji. It replaces `emojiEvent` for a user's own emoji, and `emojiEvent` now only covers community emoji.
  - `emojiView` no longer has `copyOf`.
  - The account permission set covers the follow record, `emoji.putFollow` and `emoji.getLibrary`, so existing sessions ask for consent again on their next sign-in.

## 0.12.0

### Minor Changes

- 56da297: Communities can have custom emoji and emoji packs. They're stored as Bluemoji records in the community's own repo, any repo's emoji can be listed with `emoji.getCatalog`, and changes reach clients live through `emojiEvent`.

## 0.11.0

### Minor Changes

- 25670ca: Clearing the inbox now clears it on every device, the channel list shows each channel's latest message in one request, jumping to an older message opens right at it, notifications name their thread, and the invites list updates live.

## 0.10.0

### Minor Changes

- ac08881: Adds per-user state that follows a user across devices:
  
  - `social.colibri.beta.actor.clientPreferences` holds client settings such as gesture controls, theme, link options, the Bluesky client, developer mode, voice view options and experiments.
  - `social.colibri.beta.actor.composerState` holds emoji usage, skin tone and recent GIFs.
  - `social.colibri.beta.actor.spaceNotification` sets a notification level for one community, keyed by its DID. `social.colibri.beta.actor.putSpaceNotification` pushes it to the AppView.
  - `notificationLevel` accepts `nothing`, which drops every notification, mentions included.
  - `social.colibri.beta.actor.mute` accepts `#mutedThread` subjects.
  
  `putSettings` takes `clientPreferences` and `composerState`, and `getPreferences`, `putSettings` and `preferencesEvent` return them together with `spaceNotifications`. Notification fan-out uses a community's level over the global one. The account permission set covers the new collections and procedure.

## 0.9.0

### Minor Changes

- d698add: Adds ownership transfer, category permissions and a custom emoji facet. The new `community.transferOwnership` procedure gives a member every protected owner role the caller holds and then removes those roles from the caller, who keeps their other roles. The category record, `category.create`, `category.update` and the category view gain `ownerOnly`, `allowedRoles`, `allowedMembers`, `visibleToRoles` and `visibleToMembers`, and the view adds `private`. A channel in a category inherits the category's read audience unless it sets its own `visibleToRoles` or `visibleToMembers`, and inherits its posting rules unless it sets its own `ownerOnly`, `allowedRoles` or `allowedMembers`. Space credentials, channel lists and live events all follow the inherited rules. The rich text facet gains `#customEmoji`, which points at an emoji record by `uri` and `cid` over the emoji's fallback text, and bridged messages keep that fallback text. The community settings record, `community.update` and the community view gain `customEmoji`, which is `all`, `local` or `none`. Message views drop custom emoji facets the community's policy disallows and keep the fallback text under them.

## 0.8.0

### Minor Changes

- 8e3c854: Adds direct APNs push for iOS and macOS, configured with `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID`, and includes the sender's name and avatar in every push.
- 6b3d5ef: Adds role badges and a Space-wide name colour override. A role carries an optional `badge`, either an icon from the client's curated set with an optional colour or an uploaded image of up to 256 KB. `role.create` and `role.update` take an icon badge, `role.update` clears one with `removeBadge`, and the new `role.putBadgeImage` uploads an image badge as the community. Role views return the badge with image badges served through a signed members-space link. The community settings record, `community.create`, `community.update` and the community view gain `overrideUserNameColors`, which hides members' own name colours in chat so only role colours show, and a member without a coloured role gets the default name colour.
- 6b3d5ef: Raises the status text limit from 32 to 64 bytes and adds `expiresAt` and `showWhileOffline` to the status. `actor.setStatus` takes both fields and clears an expiry with `removeExpiresAt`. Presence views and events leave out a status once its expiry has passed. `showWhileOffline` defaults to false and is passed through for clients to apply.

### Patch Changes

- ef70f83: Targets the 2026-10-01 atproto Spaces alpha. Space credentials are bound with HTTP Message Signatures and carry the audience of each request, a revoked or rejected credential is replaced once through a fresh delegation, sync follows `spaceRev` and catches up from `listRepos` after a gap, and `createSpace` sends `spaceType`. The vendored space lexicons move to atproto `679724ad`.

## 0.7.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel

## 0.6.0

### Minor Changes

- 1ed3c64: Presence now carries one activity per service an actor shares from, including what they are playing on atmosphere.games

## 0.5.0

### Minor Changes

- 4a7247d: A message can now carry a forwarded copy of another message, and the AppView serves it with its source channel or thread resolved

## 0.4.0

### Minor Changes

- 58aea35: Serve threads: a thread space projects to its own table, access follows the parent channel and the thread's own visibility, and the thread methods create, rename, repoint, delete and move messages between spaces. Notifications now check that the recipient may read the space, which stops a mention in a private channel or thread reaching someone outside it.

## 0.3.0

### Minor Changes

- 64d9500: Improve actor hydration, cache handle/identity resolution, fix listMembers `cursor` and `role` parameters usage, `getUnseen` index building improvements, add `space` to `notifications_unseen_idx`
- d7c4b6f: Stop invitations from bypassing join approval

## 0.2.1

### Patch Changes

- eebf5ef: Show what someone is listening to when they turn on shareActivity, read from the teal.fm records on their own account

## 0.2.0

### Minor Changes

- 396e6ef: Store a favourited GIF as the whole `embed.defs#gifView`, because an identifier cannot be turned back into one

## 0.1.0

### Minor Changes

- 229dde3: Make cross-AppView communities discoverable, and let a community bring its own DID
