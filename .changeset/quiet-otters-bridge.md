---
"@colibri-social/bridge-core": minor
"@colibri-social/bridge-discord": minor
"@colibri-social/lexicons": minor
"@colibri-social/community": minor
"@colibri-social/appview": minor
"@colibri-social/identity": minor
---

Open-channel bridges get the same events and actions as linked rooms.

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
