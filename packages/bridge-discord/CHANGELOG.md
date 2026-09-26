# @colibri-social/bridge-discord

## 0.2.0

### Minor Changes

- 3ab9187: Relays GIFs between Discord and Colibri as inline images.

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
