# @colibri-social/bridge-discord

## 0.4.2

### Patch Changes

- @colibri-social/bridge-core@0.5.2

## 0.4.1

### Patch Changes

- @colibri-social/bridge-core@0.5.1

## 0.4.0

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

### Patch Changes

- Updated dependencies [6cd05d3]
  - @colibri-social/bridge-core@0.5.0

## 0.3.31

### Patch Changes

- Updated dependencies [0d28440]
  - @colibri-social/bridge-core@0.4.0

## 0.3.30

### Patch Changes

- @colibri-social/bridge-core@0.3.3

## 0.3.29

### Patch Changes

- @colibri-social/bridge-core@0.3.2

## 0.3.28

### Patch Changes

- @colibri-social/bridge-core@0.3.1

## 0.3.27

### Patch Changes

- Updated dependencies [d49a097]
  - @colibri-social/bridge-core@0.3.0

## 0.3.26

### Patch Changes

- @colibri-social/bridge-core@0.2.26

## 0.3.25

### Patch Changes

- @colibri-social/bridge-core@0.2.25

## 0.3.24

### Patch Changes

- 7ce42b9: Bridge timestamps in both directions. A `<t:...>` timestamp from a bridged platform arrives as a `#time` facet with the matching style, and a `#time` facet goes out as a native timestamp. Time references use the `bridge:time/<seconds>:<style>` form.
- Updated dependencies [7ce42b9]
  - @colibri-social/bridge-core@0.2.24

## 0.3.23

### Patch Changes

- Updated dependencies [19be678]
  - @colibri-social/bridge-core@0.2.23

## 0.3.22

### Patch Changes

- @colibri-social/bridge-core@0.2.22

## 0.3.21

### Patch Changes

- @colibri-social/bridge-core@0.2.21

## 0.3.20

### Patch Changes

- @colibri-social/bridge-core@0.2.20

## 0.3.19

### Patch Changes

- @colibri-social/bridge-core@0.2.19

## 0.3.18

### Patch Changes

- @colibri-social/bridge-core@0.2.18

## 0.3.17

### Patch Changes

- @colibri-social/bridge-core@0.2.17

## 0.3.16

### Patch Changes

- @colibri-social/bridge-core@0.2.16

## 0.3.15

### Patch Changes

- @colibri-social/bridge-core@0.2.15

## 0.3.14

### Patch Changes

- @colibri-social/bridge-core@0.2.14

## 0.3.13

### Patch Changes

- @colibri-social/bridge-core@0.2.13

## 0.3.12

### Patch Changes

- @colibri-social/bridge-core@0.2.12

## 0.3.11

### Patch Changes

- @colibri-social/bridge-core@0.2.11

## 0.3.10

### Patch Changes

- @colibri-social/bridge-core@0.2.10

## 0.3.9

### Patch Changes

- @colibri-social/bridge-core@0.2.9

## 0.3.8

### Patch Changes

- @colibri-social/bridge-core@0.2.8

## 0.3.7

### Patch Changes

- @colibri-social/bridge-core@0.2.7

## 0.3.6

### Patch Changes

- Updated dependencies [e23e784]
  - @colibri-social/bridge-core@0.2.6

## 0.3.5

### Patch Changes

- @colibri-social/bridge-core@0.2.5

## 0.3.4

### Patch Changes

- @colibri-social/bridge-core@0.2.4

## 0.3.3

### Patch Changes

- @colibri-social/bridge-core@0.2.3

## 0.3.2

### Patch Changes

- @colibri-social/bridge-core@0.2.2

## 0.3.1

### Patch Changes

- @colibri-social/bridge-core@0.2.1

## 0.3.0

### Minor Changes

- d698add: Lets the other side of a bridge disconnect it. `/colibri disconnect` disconnects a Discord server from Colibri, with an optional `community` option that autocompletes the communities the server is paired with. `BridgeContext` gains `connections()`, which lists a remote space's registrations, and `disconnect()`, which leaves all of them or the one community given and counts a registration already revoked in Colibri as disconnected. Bridge registration views carry an optional `communityName`.

### Patch Changes

- Updated dependencies [d698add]
- Updated dependencies [d698add]
  - @colibri-social/bridge-core@0.2.0

## 0.2.0

### Minor Changes

- 3ab9187: Relays GIFs between Discord and Colibri as inline images.

### Patch Changes

- @colibri-social/bridge-core@0.1.2

## 0.1.1

### Patch Changes

- 326c689: Adds `bridge.leave` and `bridge.replaceAvatar`, so a bridge revokes its registration when a Discord server removes it, purges its local data for revoked registrations, and swaps a changed avatar on the author's earlier bridged records
- Updated dependencies [326c689]
  - @colibri-social/bridge-core@0.1.1

## 0.1.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel

### Patch Changes

- Updated dependencies [6e75d20]
  - @colibri-social/bridge-core@0.1.0
