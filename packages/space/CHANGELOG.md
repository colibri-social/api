# @colibri-social/space

## 0.4.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel
- d8e32d1: Spaces now carry separate read and write policies, and a space credential no longer implies the right to post

## 0.3.0

### Minor Changes

- 1ed3c64: Presence now carries one activity per service an actor shares from, including what they are playing on atmosphere.games

## 0.2.1

### Patch Changes

- 132dd5a: Send the repo parameter com.atproto.space.getBlob requires, so a message attachment in a permissioned space is served instead of failing with UpstreamFailure

## 0.2.0

### Minor Changes

- 152a8fb: Keep using a space credential that is still valid when nothing can mint a delegation token for it

## 0.1.1

### Patch Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

## 0.1.0

### Minor Changes

- 42ec07e: Initial release
