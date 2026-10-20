# @colibri-social/projections

## 1.13.1

### Patch Changes

- Updated dependencies [572ef3b]
  - @colibri-social/lexicons@2.27.0

## 1.13.0

### Minor Changes

- cb51fa0: Moderators and owners can keep messages a moderator hid out of view, everywhere or in single Spaces. `actor.clientPreferences` and `actor.defs#clientPreferences` gain an optional `hideModeratedMessages` flag. The new `actor.spaceModeration` record, keyed by the community DID, overrides it for one community, and `actor.putSpaceModeration` pushes it with `hideModeratedMessages` or `remove`. `actor.defs#preferences` lists the overrides in `spaceModerations`, and the account permission set covers the new record and procedure. The AppView stores the overrides in the new `space_moderations` table.

### Patch Changes

- Updated dependencies [cb51fa0]
  - @colibri-social/lexicons@2.26.0
  - @colibri-social/appview-db@0.17.0

## 1.12.2

### Patch Changes

- Updated dependencies [daa5699]
  - @colibri-social/lexicons@2.25.0
  - @colibri-social/appview-db@0.16.0

## 1.12.1

### Patch Changes

- 8eba18b: Store messages and reactions sent in voice channel chats, only push voice chat notifications and edits to people in the call, and add the `inboxPresentation` client preference
- Updated dependencies [8eba18b]
- Updated dependencies [8eba18b]
  - @colibri-social/lexicons@2.24.0
  - @colibri-social/appview-db@0.15.1

## 1.12.0

### Minor Changes

- 54abd78: Reactions can name the emoji record behind a custom shortcode. `social.colibri.beta.reaction` accepts an optional `customEmoji` reference, and `reactionView` and the live `reactionEvent` carry it. A reaction view reports the reference from the earliest reaction that named one.
- 54abd78: Threads can be closed and locked. `social.colibri.beta.thread.update` accepts `closed` and `locked`, and thread views carry `closedAt`, `locked` and the new `canEdit`, `canClose`, `canDelete` and `canLock` viewer flags. The member who opened a thread can rename, close, reopen and delete it while they can still read it. Members with `thread.manage` can do all of that on any thread and can lock it, which leaves writing to them alone. A new message in a closed thread reopens it.

### Patch Changes

- Updated dependencies [54abd78]
- Updated dependencies [54abd78]
  - @colibri-social/lexicons@2.23.0
  - @colibri-social/appview-db@0.15.0

## 1.11.0

### Minor Changes

- 384edf8: Every community has a Members role that everyone holds from the moment they join, so members can start threads. It can be edited but not deleted or taken away from anyone, it can't be mentioned, and communities and members missing it get it back automatically

### Patch Changes

- Updated dependencies [384edf8]
- Updated dependencies [384edf8]
  - @colibri-social/lexicons@2.22.0
  - @colibri-social/appview-db@0.14.0
  - @colibri-social/space@0.7.0

## 1.10.1

### Patch Changes

- Updated dependencies [3e21750]
  - @colibri-social/lexicons@2.21.0

## 1.10.0

### Minor Changes

- d2236e7: Users can follow a custom emoji pack or a single custom emoji. A follow is a private `social.colibri.beta.emoji.follow` record in the user's preferences space that points at the owner's pack or emoji, so renames, new images and pack membership changes reach followers.
  
  - `emoji.putFollow` pushes a follow record to the AppView, and a call without `subject` removes it.
  - `emoji.getLibrary` returns the user's own emoji plus everything they follow, each with an `available`, `missing` or `unreachable` state.
  - `emojiLibraryEvent` carries the whole library to a user's connections when their own emoji change, their follows change, or the owner of something they follow changes their emoji. It replaces `emojiEvent` for a user's own emoji, and `emojiEvent` now only covers community emoji.
  - `emojiView` no longer has `copyOf`.
  - The account permission set covers the follow record, `emoji.putFollow` and `emoji.getLibrary`, so existing sessions ask for consent again on their next sign-in.

### Patch Changes

- Updated dependencies [d2236e7]
- Updated dependencies [d2236e7]
  - @colibri-social/lexicons@2.20.0
  - @colibri-social/appview-db@0.13.0

## 1.9.4

### Patch Changes

- Updated dependencies [56da297]
  - @colibri-social/lexicons@2.19.0
  - @colibri-social/appview-db@0.12.0
  - @colibri-social/space@0.6.0

## 1.9.3

### Patch Changes

- Updated dependencies [bf32399]
- Updated dependencies [25670ca]
- Updated dependencies [8e4e6c1]
- Updated dependencies [bf32399]
  - @colibri-social/lexicons@2.18.0
  - @colibri-social/appview-db@0.11.0

## 1.9.2

### Patch Changes

- Updated dependencies [9034d25]
- Updated dependencies [9034d25]
- Updated dependencies [58b7b76]
  - @colibri-social/lexicons@2.17.0

## 1.9.1

### Patch Changes

- Updated dependencies [3f9768e]
  - @colibri-social/lexicons@2.16.0

## 1.9.0

### Minor Changes

- ac08881: Adds per-user state that follows a user across devices:
  
  - `social.colibri.beta.actor.clientPreferences` holds client settings such as gesture controls, theme, link options, the Bluesky client, developer mode, voice view options and experiments.
  - `social.colibri.beta.actor.composerState` holds emoji usage, skin tone and recent GIFs.
  - `social.colibri.beta.actor.spaceNotification` sets a notification level for one community, keyed by its DID. `social.colibri.beta.actor.putSpaceNotification` pushes it to the AppView.
  - `notificationLevel` accepts `nothing`, which drops every notification, mentions included.
  - `social.colibri.beta.actor.mute` accepts `#mutedThread` subjects.
  
  `putSettings` takes `clientPreferences` and `composerState`, and `getPreferences`, `putSettings` and `preferencesEvent` return them together with `spaceNotifications`. Notification fan-out uses a community's level over the global one. The account permission set covers the new collections and procedure.

### Patch Changes

- Updated dependencies [ac08881]
- Updated dependencies [ac08881]
  - @colibri-social/lexicons@2.15.0
  - @colibri-social/appview-db@0.10.0

## 1.8.0

### Minor Changes

- d698add: Adds ownership transfer, category permissions and a custom emoji facet. The new `community.transferOwnership` procedure gives a member every protected owner role the caller holds and then removes those roles from the caller, who keeps their other roles. The category record, `category.create`, `category.update` and the category view gain `ownerOnly`, `allowedRoles`, `allowedMembers`, `visibleToRoles` and `visibleToMembers`, and the view adds `private`. A channel in a category inherits the category's read audience unless it sets its own `visibleToRoles` or `visibleToMembers`, and inherits its posting rules unless it sets its own `ownerOnly`, `allowedRoles` or `allowedMembers`. Space credentials, channel lists and live events all follow the inherited rules. The rich text facet gains `#customEmoji`, which points at an emoji record by `uri` and `cid` over the emoji's fallback text, and bridged messages keep that fallback text. The community settings record, `community.update` and the community view gain `customEmoji`, which is `all`, `local` or `none`. Message views drop custom emoji facets the community's policy disallows and keep the fallback text under them.
- d698add: Keeps read state in step across a user's sessions. The new `sync.defs#readCursorEvent` carries a community and the read cursors that moved, and `channel.putReadCursors` sends it to every session of the caller. A read record that arrives through sync sends it too. `putReadCursors` and the read record projection keep the newer cursor per channel or thread, and leave channels the write omits untouched, so a cursor from a stale device never moves read state backwards. The `@colibri-social/projections` package exports the merge as `mergeReadCursors`. Following or unfollowing a thread sends the follower's sessions a `threadEvent` update with their new viewer state. A `seenEvent` sent for `notification.updateSeenForMessage` names the message in a new optional `message` field, so other sessions can clear that notification.

### Patch Changes

- Updated dependencies [d698add]
- Updated dependencies [d698add]
- Updated dependencies [d698add]
  - @colibri-social/lexicons@2.14.0
  - @colibri-social/appview-db@0.9.0

## 1.7.0

### Minor Changes

- 6b3d5ef: Adds role badges and a Space-wide name colour override. A role carries an optional `badge`, either an icon from the client's curated set with an optional colour or an uploaded image of up to 256 KB. `role.create` and `role.update` take an icon badge, `role.update` clears one with `removeBadge`, and the new `role.putBadgeImage` uploads an image badge as the community. Role views return the badge with image badges served through a signed members-space link. The community settings record, `community.create`, `community.update` and the community view gain `overrideUserNameColors`, which hides members' own name colours in chat so only role colours show, and a member without a coloured role gets the default name colour.

### Patch Changes

- Updated dependencies [8e3c854]
- Updated dependencies [6b3d5ef]
- Updated dependencies [ef70f83]
- Updated dependencies [6b3d5ef]
  - @colibri-social/appview-db@0.8.0
  - @colibri-social/lexicons@2.13.0
  - @colibri-social/space@0.5.0

## 1.6.1

### Patch Changes

- Updated dependencies [326c689]
  - @colibri-social/lexicons@2.12.1

## 1.6.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel

### Patch Changes

- Updated dependencies [6e75d20]
- Updated dependencies [c80c110]
- Updated dependencies [d8e32d1]
  - @colibri-social/appview-db@0.7.0
  - @colibri-social/lexicons@2.12.0
  - @colibri-social/space@0.4.0

## 1.5.1

### Patch Changes

- Updated dependencies [1ed3c64]
  - @colibri-social/lexicons@2.11.0
  - @colibri-social/appview-db@0.6.0
  - @colibri-social/space@0.3.0

## 1.5.0

### Minor Changes

- 4a7247d: A message can now carry a forwarded copy of another message, and the AppView serves it with its source channel or thread resolved

### Patch Changes

- Updated dependencies [4a7247d]
- Updated dependencies [b6f4239]
  - @colibri-social/lexicons@2.10.0
  - @colibri-social/appview-db@0.5.0

## 1.4.0

### Minor Changes

- 58aea35: Serve threads: a thread space projects to its own table, access follows the parent channel and the thread's own visibility, and the thread methods create, rename, repoint, delete and move messages between spaces. Notifications now check that the recipient may read the space, which stops a mention in a private channel or thread reaching someone outside it.

### Patch Changes

- Updated dependencies [58aea35]
- Updated dependencies [58aea35]
  - @colibri-social/lexicons@2.9.1
  - @colibri-social/appview-db@0.4.0

## 1.3.5

### Patch Changes

- Updated dependencies [305fd99]
  - @colibri-social/lexicons@2.9.0

## 1.3.4

### Patch Changes

- Updated dependencies [64d9500]
- Updated dependencies [d7c4b6f]
  - @colibri-social/appview-db@0.3.0
  - @colibri-social/lexicons@2.8.0

## 1.3.3

### Patch Changes

- eebf5ef: Show what someone is listening to when they turn on shareActivity, read from the teal.fm records on their own account
- Updated dependencies [eebf5ef]
  - @colibri-social/lexicons@2.7.0
  - @colibri-social/appview-db@0.2.1

## 1.3.2

### Patch Changes

- Updated dependencies [bad9064]
  - @colibri-social/lexicons@2.6.0

## 1.3.1

### Patch Changes

- dc9ea5c: Reconcile a mute by its subject rather than its record key, so the immediate `actor.putMutes` push and the later repo sync of the same mute no longer collide on the one-mute-per-subject index and strand the user's preferences space with an unapplied cursor
- Updated dependencies [38dc331]
- Updated dependencies [07d1508]
  - @colibri-social/lexicons@2.5.0

## 1.3.0

### Minor Changes

- d2c8938: Gate voice joins on the same permission as posting, and disconnect a participant whose access changes mid-call

### Patch Changes

- 1c863c7: Keep a community picture, banner and message attachment after it is saved, by converting blob references between their json and lexicon forms at every boundary
- Updated dependencies [1c863c7]
- Updated dependencies [d175422]
- Updated dependencies [132dd5a]
- Updated dependencies [d2c8938]
  - @colibri-social/lexicons@2.4.0
  - @colibri-social/space@0.2.1

## 1.2.1

### Patch Changes

- 152a8fb: Keep a channel's `visibleToRoles` and `visibleToMembers` when projecting its record
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
  - @colibri-social/space@0.2.0
  - @colibri-social/lexicons@2.3.0

## 1.2.0

### Minor Changes

- efcadc8: Let a mute name a channel

### Patch Changes

- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
  - @colibri-social/lexicons@2.2.0

## 1.1.0

### Minor Changes

- 396e6ef: Store a favourited GIF as the whole `embed.defs#gifView`, because an identifier cannot be turned back into one

### Patch Changes

- Updated dependencies [396e6ef]
- Updated dependencies [396e6ef]
  - @colibri-social/lexicons@2.1.0
  - @colibri-social/appview-db@0.2.0

## 1.0.1

### Patch Changes

- Updated dependencies [a39c928]
- Updated dependencies [229dde3]
  - @colibri-social/lexicons@2.0.0
  - @colibri-social/appview-db@0.1.0

## 1.0.0

### Major Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

### Patch Changes

- bd2a38c: Enforce `hidden` labels server-side instead of forwarding them as advice
- Updated dependencies [49310eb]
- Updated dependencies [bd2a38c]
  - @colibri-social/lexicons@1.0.0
  - @colibri-social/space@0.1.1

## 0.0.1

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/lexicons@0.1.0
  - @colibri-social/space@0.1.0
