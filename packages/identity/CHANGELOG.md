# @colibri-social/identity

## 0.6.0

### Minor Changes

- a48d881: Resolve which AppView manages a community from its `community.host` record, with a 10 minute cache in `space_hosts` and a 1 minute cache for communities without one. `IdentityResolver.serviceEndpointFor` reads a service endpoint from a DID document. The federation tables are now part of the exported schema

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

## 0.4.1

### Patch Changes

- 9e7d1d7: `IdentityResolver.resolveDid` and `resolveAtIdentifier` resolve a DID whose document publishes no handle, such as one with `alsoKnownAs: ["at://"]`, and return `handle: null`. The document still needs a signing key and an `#atproto_pds` service. `social.colibri.beta.bridge.install` accepts such a bridge DID and names the registration after the DID.

## 0.4.0

### Minor Changes

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

## 0.3.2

### Patch Changes

- 19be678: Update Spaces support to the November 5 alpha (`0.0.0-spaces-alpha-20261105160032`). STAR archives from `getRepo` use the new control-byte framing through the `@atproto/space` helpers, so the AppView needs a PDS on the same alpha. `@atproto/star` is pinned to the alpha build, because its caret range otherwise resolves to a broken `0.0.0-stage` release. The vendored atproto space lexicons move to `704b9e2a`, which adds `RepoTakendown` and `RepoDeactivated` to `getSpaceCredential` and `listRepos`. A suspended space keeps its synced data and retries, as before.

## 0.3.1

### Patch Changes

- 3116a04: Read a custom emoji the index hasn't seen yet straight from its owner's PDS and refresh an owner's emoji catalog once it's an hour old. Send the full message, attachments and reply included, with each notification. Answer `listMessages` without waiting for link previews, profiles, or handle checks, and send late link previews as message updates. Keep link previews in the new `link_previews` table so they survive restarts.

## 0.3.0

### Minor Changes

- 0b325da: Update Spaces support to the October 22 alpha (`0.0.0-spaces-alpha-20261022141228`). Space credentials are requested with a JSON body and presented with the `Atproto-Space-Credential` scheme. Space hosts resolve through `#atproto_pds`. Commits and records are verified with MACs keyed against each author's `#atproto_kem` key, and full repos arrive as STAR archives. Accounts that haven't published a KEM key can't be synced until their PDS publishes one.

## 0.2.2

### Patch Changes

- 42b0ba6: Retries failed handle verifications after 5 minutes, so new accounts no longer show `handle.invalid` for a day

## 0.2.1

### Patch Changes

- 5640cde: Stops retrying sync for authors whose DID document has no `#atproto_pds` service, and logs the message and cause of every `error` field.

## 0.2.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel

## 0.1.0

### Minor Changes

- 64d9500: Improve actor hydration, cache handle/identity resolution, fix listMembers `cursor` and `role` parameters usage, `getUnseen` index building improvements, add `space` to `notifications_unseen_idx`

## 0.0.1

### Patch Changes

- 152a8fb: Name the audiences a service does answer as when a service-auth token names a different one
