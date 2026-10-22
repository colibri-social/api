# @colibri-social/bridge-core

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
