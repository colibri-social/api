# @colibri-social/appview-db

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
