# @colibri-social/community

## 2.14.0

### Minor Changes

- b3f77f4: Update Spaces support to the October 29 alpha (`0.0.0-spaces-alpha-20261029171913`). The vendored atproto lexicons move to `5d88b414` and replace `com.atproto.simplespace` with the `com.atproto.space` lifecycle methods and the `memberspace`, `managedspace` and `personalspace` policies. `PdsClient.createSpace` and `updateSpace` take a single `policy`, built with `memberspacePolicy` or `managedspacePolicy`. Community profile spaces are created as a member space with `publicRead`, and every other community space as a managed space. The AppView serves `com.atproto.managedspace.checkUserAccess`, treats `SpaceNotFound` from `getSpaceCredential` as a refusal, and on startup moves existing profile spaces to the public member space policy.

### Patch Changes

- Updated dependencies [7480051]
- Updated dependencies [a6eb9be]
- Updated dependencies [b3f77f4]
  - @colibri-social/lexicons@2.35.0
  - @colibri-social/space@0.10.0
  - @colibri-social/projections@1.14.2

## 2.13.2

### Patch Changes

- Updated dependencies [4ab879d]
- Updated dependencies [f583cda]
  - @colibri-social/projections@1.14.1
  - @colibri-social/lexicons@2.34.0
  - @colibri-social/appview-db@0.20.1

## 2.13.1

### Patch Changes

- ea8de44: Leave legacy messages dated more than 15 minutes ahead of the import out of a migrated Space's history.
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
  - @colibri-social/projections@1.14.0
  - @colibri-social/appview-db@0.20.0
  - @colibri-social/lexicons@2.33.0

## 2.13.0

### Minor Changes

- 73d1143: Let owners host a community on an account of their own through OAuth, and move a community account off this AppView's PDS. `social.colibri.beta.community.authorizeHost` starts a sign-in as the community account, which adopts it as a new community or reconnects an existing one, and `getHostAuthorization` reports the outcome. `getHosting` tells administrators where the account lives and whether the AppView needs a new sign-in. `handOverHost` sets the owner's email on an account this AppView hosts and returns a new password that works for 60 minutes, after which the AppView replaces it unless the account moved. A community whose account moved to another server asks for a sign-in again, and its password is no longer reset on this AppView's PDS. Host sign-in needs `HOST_OAUTH_PRIVATE_KEY`, and `HOST_OAUTH_RETURN_URL` sets where the browser lands afterwards. The permission set for managing communities includes the four new methods.

### Patch Changes

- 7097dbf: Refuse a message whose record key isn't a TID, or whose record key or `createdAt` is more than 15 minutes ahead of the server clock. Refuse a newly created message whose record key is more than 24 hours older than the commit that created it, except for history a bridge imported. A thread's last activity never moves past the server clock. Add `pnpm --filter @colibri-social/appview purge-future-messages`, which lists projected messages dated more than 15 minutes ahead and the thread activity it would rewind, and deletes them with `--apply`.
- Updated dependencies [3116a04]
- Updated dependencies [a3a2f09]
- Updated dependencies [7097dbf]
- Updated dependencies [7097dbf]
- Updated dependencies [73d1143]
  - @colibri-social/appview-db@0.19.0
  - @colibri-social/identity@0.3.1
  - @colibri-social/projections@1.13.6
  - @colibri-social/lexicons@2.32.0
  - @colibri-social/space@0.9.0

## 2.12.2

### Patch Changes

- Updated dependencies [dd7a07e]
  - @colibri-social/lexicons@2.31.0
  - @colibri-social/projections@1.13.5

## 2.12.1

### Patch Changes

- Updated dependencies [aea592c]
- Updated dependencies [0b325da]
  - @colibri-social/lexicons@2.30.0
  - @colibri-social/projections@1.13.4
  - @colibri-social/appview-db@0.18.1
  - @colibri-social/space@0.8.0
  - @colibri-social/identity@0.3.0

## 2.12.0

### Minor Changes

- 817469f: Run legacy community migrations as resumable background jobs that copy bans, serve legacy message history read-only in the migrated channels, mark that history as read for every member and retire the legacy community record when done. A community whose account this AppView can't sign in to moves into a newly provisioned account built from its public records, and its legacy record stays as it is

### Patch Changes

- Updated dependencies [817469f]
- Updated dependencies [817469f]
- Updated dependencies [dc2a71b]
- Updated dependencies [817469f]
- Updated dependencies [dc2a71b]
  - @colibri-social/appview-db@0.18.0
  - @colibri-social/lexicons@2.29.0
  - @colibri-social/projections@1.13.3

## 2.11.5

### Patch Changes

- Updated dependencies [5fd5282]
  - @colibri-social/lexicons@2.28.0
  - @colibri-social/projections@1.13.2

## 2.11.4

### Patch Changes

- Updated dependencies [42b0ba6]
- Updated dependencies [572ef3b]
  - @colibri-social/identity@0.2.2
  - @colibri-social/lexicons@2.27.0
  - @colibri-social/projections@1.13.1

## 2.11.3

### Patch Changes

- Updated dependencies [cb51fa0]
  - @colibri-social/lexicons@2.26.0
  - @colibri-social/appview-db@0.17.0
  - @colibri-social/projections@1.13.0

## 2.11.2

### Patch Changes

- Updated dependencies [daa5699]
  - @colibri-social/lexicons@2.25.0
  - @colibri-social/appview-db@0.16.0
  - @colibri-social/projections@1.12.2

## 2.11.1

### Patch Changes

- Updated dependencies [8eba18b]
- Updated dependencies [8eba18b]
  - @colibri-social/lexicons@2.24.0
  - @colibri-social/projections@1.12.1
  - @colibri-social/appview-db@0.15.1

## 2.11.0

### Minor Changes

- 54abd78: Threads can be closed and locked. `social.colibri.beta.thread.update` accepts `closed` and `locked`, and thread views carry `closedAt`, `locked` and the new `canEdit`, `canClose`, `canDelete` and `canLock` viewer flags. The member who opened a thread can rename, close, reopen and delete it while they can still read it. Members with `thread.manage` can do all of that on any thread and can lock it, which leaves writing to them alone. A new message in a closed thread reopens it.

### Patch Changes

- Updated dependencies [54abd78]
- Updated dependencies [54abd78]
  - @colibri-social/lexicons@2.23.0
  - @colibri-social/appview-db@0.15.0
  - @colibri-social/projections@1.12.0

## 2.10.0

### Minor Changes

- 384edf8: Every community has a Members role that everyone holds from the moment they join, so members can start threads. It can be edited but not deleted or taken away from anyone, it can't be mentioned, and communities and members missing it get it back automatically

### Patch Changes

- Updated dependencies [384edf8]
- Updated dependencies [384edf8]
  - @colibri-social/lexicons@2.22.0
  - @colibri-social/appview-db@0.14.0
  - @colibri-social/projections@1.11.0
  - @colibri-social/space@0.7.0

## 2.9.2

### Patch Changes

- Updated dependencies [3e21750]
  - @colibri-social/lexicons@2.21.0
  - @colibri-social/projections@1.10.1

## 2.9.1

### Patch Changes

- Updated dependencies [d2236e7]
- Updated dependencies [d2236e7]
  - @colibri-social/lexicons@2.20.0
  - @colibri-social/appview-db@0.13.0
  - @colibri-social/projections@1.10.0

## 2.9.0

### Minor Changes

- 56da297: Communities can have custom emoji and emoji packs. They're stored as Bluemoji records in the community's own repo, any repo's emoji can be listed with `emoji.getCatalog`, and changes reach clients live through `emojiEvent`.

### Patch Changes

- Updated dependencies [56da297]
  - @colibri-social/lexicons@2.19.0
  - @colibri-social/appview-db@0.12.0
  - @colibri-social/space@0.6.0
  - @colibri-social/projections@1.9.4

## 2.8.4

### Patch Changes

- Updated dependencies [bf32399]
- Updated dependencies [25670ca]
- Updated dependencies [8e4e6c1]
- Updated dependencies [bf32399]
  - @colibri-social/lexicons@2.18.0
  - @colibri-social/appview-db@0.11.0
  - @colibri-social/projections@1.9.3

## 2.8.3

### Patch Changes

- Updated dependencies [9034d25]
- Updated dependencies [9034d25]
- Updated dependencies [58b7b76]
  - @colibri-social/lexicons@2.17.0
  - @colibri-social/projections@1.9.2

## 2.8.2

### Patch Changes

- Updated dependencies [3f9768e]
  - @colibri-social/lexicons@2.16.0
  - @colibri-social/projections@1.9.1

## 2.8.1

### Patch Changes

- Updated dependencies [ac08881]
- Updated dependencies [ac08881]
  - @colibri-social/lexicons@2.15.0
  - @colibri-social/appview-db@0.10.0
  - @colibri-social/projections@1.9.0

## 2.8.0

### Minor Changes

- d698add: Adds ownership transfer, category permissions and a custom emoji facet. The new `community.transferOwnership` procedure gives a member every protected owner role the caller holds and then removes those roles from the caller, who keeps their other roles. The category record, `category.create`, `category.update` and the category view gain `ownerOnly`, `allowedRoles`, `allowedMembers`, `visibleToRoles` and `visibleToMembers`, and the view adds `private`. A channel in a category inherits the category's read audience unless it sets its own `visibleToRoles` or `visibleToMembers`, and inherits its posting rules unless it sets its own `ownerOnly`, `allowedRoles` or `allowedMembers`. Space credentials, channel lists and live events all follow the inherited rules. The rich text facet gains `#customEmoji`, which points at an emoji record by `uri` and `cid` over the emoji's fallback text, and bridged messages keep that fallback text. The community settings record, `community.update` and the community view gain `customEmoji`, which is `all`, `local` or `none`. Message views drop custom emoji facets the community's policy disallows and keep the fallback text under them.

### Patch Changes

- Updated dependencies [d698add]
- Updated dependencies [d698add]
- Updated dependencies [d698add]
  - @colibri-social/lexicons@2.14.0
  - @colibri-social/appview-db@0.9.0
  - @colibri-social/projections@1.8.0

## 2.7.0

### Minor Changes

- 6b3d5ef: Adds role badges and a Space-wide name colour override. A role carries an optional `badge`, either an icon from the client's curated set with an optional colour or an uploaded image of up to 256 KB. `role.create` and `role.update` take an icon badge, `role.update` clears one with `removeBadge`, and the new `role.putBadgeImage` uploads an image badge as the community. Role views return the badge with image badges served through a signed members-space link. The community settings record, `community.create`, `community.update` and the community view gain `overrideUserNameColors`, which hides members' own name colours in chat so only role colours show, and a member without a coloured role gets the default name colour.

### Patch Changes

- ef70f83: Targets the 2026-10-01 atproto Spaces alpha. Space credentials are bound with HTTP Message Signatures and carry the audience of each request, a revoked or rejected credential is replaced once through a fresh delegation, sync follows `spaceRev` and catches up from `listRepos` after a gap, and `createSpace` sends `spaceType`. The vendored space lexicons move to atproto `679724ad`.
- Updated dependencies [8e3c854]
- Updated dependencies [5640cde]
- Updated dependencies [6b3d5ef]
- Updated dependencies [ef70f83]
- Updated dependencies [6b3d5ef]
  - @colibri-social/appview-db@0.8.0
  - @colibri-social/lexicons@2.13.0
  - @colibri-social/identity@0.2.1
  - @colibri-social/projections@1.7.0
  - @colibri-social/space@0.5.0

## 2.6.1

### Patch Changes

- 326c689: Adds `bridge.leave` and `bridge.replaceAvatar`, so a bridge revokes its registration when a Discord server removes it, purges its local data for revoked registrations, and swaps a changed avatar on the author's earlier bridged records
- Updated dependencies [326c689]
  - @colibri-social/lexicons@2.12.1
  - @colibri-social/projections@1.6.1

## 2.6.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel

### Patch Changes

- Updated dependencies [6e75d20]
- Updated dependencies [c80c110]
- Updated dependencies [d8e32d1]
  - @colibri-social/appview-db@0.7.0
  - @colibri-social/identity@0.2.0
  - @colibri-social/lexicons@2.12.0
  - @colibri-social/projections@1.6.0
  - @colibri-social/space@0.4.0

## 2.5.2

### Patch Changes

- Updated dependencies [1ed3c64]
  - @colibri-social/lexicons@2.11.0
  - @colibri-social/appview-db@0.6.0
  - @colibri-social/space@0.3.0
  - @colibri-social/projections@1.5.1

## 2.5.1

### Patch Changes

- Updated dependencies [4a7247d]
- Updated dependencies [b6f4239]
  - @colibri-social/lexicons@2.10.0
  - @colibri-social/appview-db@0.5.0
  - @colibri-social/projections@1.5.0

## 2.5.0

### Minor Changes

- 58aea35: Give the owner role every permission, including ones added after the community was made: permission checks now treat the protected role the way they already treated the community itself, and a sweep at startup writes any missing permissions back onto the record
- 58aea35: Serve threads: a thread space projects to its own table, access follows the parent channel and the thread's own visibility, and the thread methods create, rename, repoint, delete and move messages between spaces. Notifications now check that the recipient may read the space, which stops a mention in a private channel or thread reaching someone outside it.

### Patch Changes

- Updated dependencies [58aea35]
- Updated dependencies [58aea35]
  - @colibri-social/lexicons@2.9.1
  - @colibri-social/appview-db@0.4.0
  - @colibri-social/projections@1.4.0

## 2.4.1

### Patch Changes

- Updated dependencies [305fd99]
  - @colibri-social/lexicons@2.9.0
  - @colibri-social/projections@1.3.5

## 2.4.0

### Minor Changes

- d7c4b6f: Stop invitations from bypassing join approval

### Patch Changes

- Updated dependencies [64d9500]
- Updated dependencies [d7c4b6f]
  - @colibri-social/appview-db@0.3.0
  - @colibri-social/identity@0.1.0
  - @colibri-social/lexicons@2.8.0
  - @colibri-social/projections@1.3.4

## 2.3.2

### Patch Changes

- Updated dependencies [eebf5ef]
  - @colibri-social/lexicons@2.7.0
  - @colibri-social/appview-db@0.2.1
  - @colibri-social/projections@1.3.3

## 2.3.1

### Patch Changes

- Updated dependencies [bad9064]
  - @colibri-social/lexicons@2.6.0
  - @colibri-social/projections@1.3.2

## 2.3.0

### Minor Changes

- 321e7dc: Tell every member when a community is deleted and drop its data straight away, so it stops being listed and stops being served the moment its owner deletes it instead of lingering until its PDS reports the deletion. Deleting a community now also deletes its channel spaces, and a community whose profile space disappears out of band is reconciled the same way.

### Patch Changes

- Updated dependencies [38dc331]
- Updated dependencies [dc9ea5c]
- Updated dependencies [07d1508]
  - @colibri-social/lexicons@2.5.0
  - @colibri-social/projections@1.3.1

## 2.2.1

### Patch Changes

- a9cea8f: Give a new community a random handle, so provisioning no longer fails on the PDS handle length limit
- a35adfc: Let members with role.manage edit their own roles, granting and revoking any role below their own position
- Updated dependencies [1c863c7]
- Updated dependencies [d175422]
- Updated dependencies [132dd5a]
- Updated dependencies [d2c8938]
  - @colibri-social/lexicons@2.4.0
  - @colibri-social/projections@1.3.0
  - @colibri-social/space@0.2.1

## 2.2.0

### Minor Changes

- 152a8fb: Report progress while migrating a legacy community, find one from read cursors and message history when nothing else names it, and honor a role's per-channel overrides when checking `label.apply`

### Patch Changes

- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
  - @colibri-social/space@0.2.0
  - @colibri-social/identity@0.0.1
  - @colibri-social/projections@1.2.1
  - @colibri-social/lexicons@2.3.0

## 2.1.0

### Minor Changes

- efcadc8: Make community migration work against a real legacy repo, and give it a picker
- 0e3df75: Record every space in the `spaces` table at the moment it is created, so the sync
  engine can find it

### Patch Changes

- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
  - @colibri-social/lexicons@2.2.0
  - @colibri-social/projections@1.2.0

## 2.0.1

### Patch Changes

- Updated dependencies [396e6ef]
- Updated dependencies [396e6ef]
  - @colibri-social/lexicons@2.1.0
  - @colibri-social/projections@1.1.0
  - @colibri-social/appview-db@0.2.0

## 2.0.0

### Major Changes

- 229dde3: Make cross-AppView communities discoverable, and let a community bring its own DID

### Minor Changes

- a39c928: Give communities a working picture and banner write path

### Patch Changes

- Updated dependencies [a39c928]
- Updated dependencies [229dde3]
  - @colibri-social/lexicons@2.0.0
  - @colibri-social/appview-db@0.1.0
  - @colibri-social/projections@1.0.1

## 1.0.0

### Major Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

### Patch Changes

- Updated dependencies [49310eb]
- Updated dependencies [bd2a38c]
  - @colibri-social/lexicons@1.0.0
  - @colibri-social/space@0.1.1
  - @colibri-social/projections@1.0.0

## 0.0.1

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/lexicons@0.1.0
  - @colibri-social/space@0.1.0
  - @colibri-social/projections@0.0.1
