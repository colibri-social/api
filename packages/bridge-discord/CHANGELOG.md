# @colibri-social/bridge-discord

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
