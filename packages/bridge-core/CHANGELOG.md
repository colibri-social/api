# @colibri-social/bridge-core

## 0.5.6

### Patch Changes

- Updated dependencies [5e5d3b2]
  - @colibri-social/lexicons@2.46.1

## 0.5.5

### Patch Changes

- Updated dependencies [5137ec8]
- Updated dependencies [8e55a30]
- Updated dependencies [5621e4c]
- Updated dependencies [858fcd1]
- Updated dependencies [01dc960]
- Updated dependencies [fb47131]
- Updated dependencies [56371fd]
- Updated dependencies [1c16c11]
  - @colibri-social/lexicons@2.46.0

## 0.5.4

### Patch Changes

- 06e34d7: Stop bridges from posting old Colibri messages again. Bridges match their stored messages and threads under both space URI formats, send nothing for an edit of a message they never sent, and skip new messages older than a day. The AppView no longer streams or notifies messages older than a day that a repo recovery picks up.

## 0.5.3

### Patch Changes

- Updated dependencies [dbd18da]
  - @colibri-social/lexicons@2.45.0

## 0.5.2

### Patch Changes

- Updated dependencies [c8bfd4b]
  - @colibri-social/lexicons@2.44.0

## 0.5.1

### Patch Changes

- Updated dependencies [ff95f38]
  - @colibri-social/lexicons@2.43.0

## 0.5.0

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
- Updated dependencies [1a985c7]
  - @colibri-social/lexicons@2.42.0

## 0.4.0

### Minor Changes

- 0d28440: Bridges that set up rooms with commands, such as Lightning, can connect to a community without a pairing code. `social.colibri.beta.bridge.install` takes a community and the bridge's handle or DID and writes a registration with platform `external`, the community DID as its remote space, and no linked or open channels. It answers `BridgeNotFound` when the handle or DID doesn't resolve and `AlreadyRegistered` when the bridge is already installed.
  
  Registrations gain an optional `channels` list of open channels, set through `bridge.update`. A bridge may read, subscribe to and post in an open channel and in its unrestricted threads without a room on the other service. `links` keep working as before.
  
  `social.colibri.beta.bridge.listChannels` lists a community's text channels that every member can read to the bridge holding the registration, with `viewer.canRead` and `viewer.canPost` set for the channels open to it. `permissionBridge` includes it, and `permissionCommunity` includes `bridge.install`. In `@colibri-social/bridge-core`, `ColibriClient.listChannels` calls it and `BridgeContext` gains `channels(community, registration)`.
  
  A bridge-core connector that implements `receiveChannelMessage` hears every new message in the open channels of its enabled registrations, as `OpenChannelMessage` with the author and the text as markdown. It skips edits, imported history and the bridge's own posts. `BridgeContext.reply()` posts in an open channel under a remote author's name, optionally as a reply to a message, and returns the new record key.

### Patch Changes

- Updated dependencies [0d28440]
  - @colibri-social/lexicons@2.41.0

## 0.3.3

### Patch Changes

- Updated dependencies [6cf84e8]
  - @colibri-social/lexicons@2.40.0

## 0.3.2

### Patch Changes

- Updated dependencies [38bbf47]
  - @colibri-social/lexicons@2.39.2

## 0.3.1

### Patch Changes

- Updated dependencies [bb5fbb6]
  - @colibri-social/lexicons@2.39.1

## 0.3.0

### Minor Changes

- d49a097: Open the bridge event socket on the fastest Colibri node, move it to another node before the current one drains, and hold writes while the network is read-only

## 0.2.26

### Patch Changes

- Updated dependencies [e7543ed]
- Updated dependencies [61e8260]
- Updated dependencies [6c5818a]
  - @colibri-social/lexicons@2.39.0

## 0.2.25

### Patch Changes

- Updated dependencies [c9104d3]
- Updated dependencies [3b3b2b7]
- Updated dependencies [4bcbcf0]
- Updated dependencies [4bcbcf0]
  - @colibri-social/lexicons@2.38.0

## 0.2.24

### Patch Changes

- 7ce42b9: Bridge timestamps in both directions. A `<t:...>` timestamp from a bridged platform arrives as a `#time` facet with the matching style, and a `#time` facet goes out as a native timestamp. Time references use the `bridge:time/<seconds>:<style>` form.

## 0.2.23

### Patch Changes

- 19be678: Update Spaces support to the November 5 alpha (`0.0.0-spaces-alpha-20261105160032`). STAR archives from `getRepo` use the new control-byte framing through the `@atproto/space` helpers, so the AppView needs a PDS on the same alpha. `@atproto/star` is pinned to the alpha build, because its caret range otherwise resolves to a broken `0.0.0-stage` release. The vendored atproto space lexicons move to `704b9e2a`, which adds `RepoTakendown` and `RepoDeactivated` to `getSpaceCredential` and `listRepos`. A suspended space keeps its synced data and retries, as before.
- Updated dependencies [aea9292]
- Updated dependencies [19be678]
  - @colibri-social/lexicons@2.37.0

## 0.2.22

### Patch Changes

- Updated dependencies [d52006b]
- Updated dependencies [9d42e5c]
- Updated dependencies [e3aa164]
- Updated dependencies [e3aa164]
  - @colibri-social/lexicons@2.36.0

## 0.2.21

### Patch Changes

- Updated dependencies [7480051]
- Updated dependencies [a6eb9be]
- Updated dependencies [b3f77f4]
  - @colibri-social/lexicons@2.35.0

## 0.2.20

### Patch Changes

- Updated dependencies [f583cda]
  - @colibri-social/lexicons@2.34.0

## 0.2.19

### Patch Changes

- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
  - @colibri-social/lexicons@2.33.0

## 0.2.18

### Patch Changes

- Updated dependencies [7097dbf]
- Updated dependencies [73d1143]
  - @colibri-social/lexicons@2.32.0

## 0.2.17

### Patch Changes

- Updated dependencies [dd7a07e]
  - @colibri-social/lexicons@2.31.0

## 0.2.16

### Patch Changes

- Updated dependencies [aea592c]
- Updated dependencies [0b325da]
  - @colibri-social/lexicons@2.30.0

## 0.2.15

### Patch Changes

- Updated dependencies [817469f]
- Updated dependencies [dc2a71b]
- Updated dependencies [817469f]
- Updated dependencies [dc2a71b]
  - @colibri-social/lexicons@2.29.0

## 0.2.14

### Patch Changes

- Updated dependencies [5fd5282]
  - @colibri-social/lexicons@2.28.0

## 0.2.13

### Patch Changes

- Updated dependencies [572ef3b]
  - @colibri-social/lexicons@2.27.0

## 0.2.12

### Patch Changes

- Updated dependencies [cb51fa0]
  - @colibri-social/lexicons@2.26.0

## 0.2.11

### Patch Changes

- Updated dependencies [daa5699]
  - @colibri-social/lexicons@2.25.0

## 0.2.10

### Patch Changes

- Updated dependencies [8eba18b]
- Updated dependencies [8eba18b]
  - @colibri-social/lexicons@2.24.0

## 0.2.9

### Patch Changes

- Updated dependencies [54abd78]
- Updated dependencies [54abd78]
  - @colibri-social/lexicons@2.23.0

## 0.2.8

### Patch Changes

- Updated dependencies [384edf8]
  - @colibri-social/lexicons@2.22.0

## 0.2.7

### Patch Changes

- Updated dependencies [3e21750]
  - @colibri-social/lexicons@2.21.0

## 0.2.6

### Patch Changes

- e23e784: Bare `http` and `https` URLs in bridged messages become link facets, so they get link previews and a message that is only a GIF URL shows the GIF. URLs inside code stay plain text, and `www.` and email literals aren't linked.
- Updated dependencies [d2236e7]
- Updated dependencies [d2236e7]
  - @colibri-social/lexicons@2.20.0

## 0.2.5

### Patch Changes

- Updated dependencies [56da297]
  - @colibri-social/lexicons@2.19.0

## 0.2.4

### Patch Changes

- Updated dependencies [bf32399]
- Updated dependencies [25670ca]
- Updated dependencies [8e4e6c1]
- Updated dependencies [bf32399]
  - @colibri-social/lexicons@2.18.0

## 0.2.3

### Patch Changes

- Updated dependencies [9034d25]
- Updated dependencies [9034d25]
- Updated dependencies [58b7b76]
  - @colibri-social/lexicons@2.17.0

## 0.2.2

### Patch Changes

- Updated dependencies [3f9768e]
  - @colibri-social/lexicons@2.16.0

## 0.2.1

### Patch Changes

- Updated dependencies [ac08881]
- Updated dependencies [ac08881]
  - @colibri-social/lexicons@2.15.0

## 0.2.0

### Minor Changes

- d698add: Lets the other side of a bridge disconnect it. `/colibri disconnect` disconnects a Discord server from Colibri, with an optional `community` option that autocompletes the communities the server is paired with. `BridgeContext` gains `connections()`, which lists a remote space's registrations, and `disconnect()`, which leaves all of them or the one community given and counts a registration already revoked in Colibri as disconnected. Bridge registration views carry an optional `communityName`.

### Patch Changes

- d698add: Adds ownership transfer, category permissions and a custom emoji facet. The new `community.transferOwnership` procedure gives a member every protected owner role the caller holds and then removes those roles from the caller, who keeps their other roles. The category record, `category.create`, `category.update` and the category view gain `ownerOnly`, `allowedRoles`, `allowedMembers`, `visibleToRoles` and `visibleToMembers`, and the view adds `private`. A channel in a category inherits the category's read audience unless it sets its own `visibleToRoles` or `visibleToMembers`, and inherits its posting rules unless it sets its own `ownerOnly`, `allowedRoles` or `allowedMembers`. Space credentials, channel lists and live events all follow the inherited rules. The rich text facet gains `#customEmoji`, which points at an emoji record by `uri` and `cid` over the emoji's fallback text, and bridged messages keep that fallback text. The community settings record, `community.update` and the community view gain `customEmoji`, which is `all`, `local` or `none`. Message views drop custom emoji facets the community's policy disallows and keep the fallback text under them.
- Updated dependencies [d698add]
- Updated dependencies [d698add]
- Updated dependencies [d698add]
  - @colibri-social/lexicons@2.14.0

## 0.1.2

### Patch Changes

- Updated dependencies [8e3c854]
- Updated dependencies [6b3d5ef]
- Updated dependencies [ef70f83]
- Updated dependencies [6b3d5ef]
  - @colibri-social/lexicons@2.13.0

## 0.1.1

### Patch Changes

- 326c689: Adds `bridge.leave` and `bridge.replaceAvatar`, so a bridge revokes its registration when a Discord server removes it, purges its local data for revoked registrations, and swaps a changed avatar on the author's earlier bridged records
- Updated dependencies [326c689]
  - @colibri-social/lexicons@2.12.1

## 0.1.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel

### Patch Changes

- Updated dependencies [6e75d20]
- Updated dependencies [c80c110]
- Updated dependencies [d8e32d1]
  - @colibri-social/lexicons@2.12.0
