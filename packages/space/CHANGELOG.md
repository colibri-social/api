# @colibri-social/space

## 0.9.0

### Minor Changes

- 73d1143: Let owners host a community on an account of their own through OAuth, and move a community account off this AppView's PDS. `social.colibri.beta.community.authorizeHost` starts a sign-in as the community account, which adopts it as a new community or reconnects an existing one, and `getHostAuthorization` reports the outcome. `getHosting` tells administrators where the account lives and whether the AppView needs a new sign-in. `handOverHost` sets the owner's email on an account this AppView hosts and returns a new password that works for 60 minutes, after which the AppView replaces it unless the account moved. A community whose account moved to another server asks for a sign-in again, and its password is no longer reset on this AppView's PDS. Host sign-in needs `HOST_OAUTH_PRIVATE_KEY`, and `HOST_OAUTH_RETURN_URL` sets where the browser lands afterwards. The permission set for managing communities includes the four new methods.

### Patch Changes

- 7097dbf: Refuse a message whose record key isn't a TID, or whose record key or `createdAt` is more than 15 minutes ahead of the server clock. Refuse a newly created message whose record key is more than 24 hours older than the commit that created it, except for history a bridge imported. A thread's last activity never moves past the server clock. Add `pnpm --filter @colibri-social/appview purge-future-messages`, which lists projected messages dated more than 15 minutes ahead and the thread activity it would rewind, and deletes them with `--apply`.

## 0.8.0

### Minor Changes

- 0b325da: Update Spaces support to the October 22 alpha (`0.0.0-spaces-alpha-20261022141228`). Space credentials are requested with a JSON body and presented with the `Atproto-Space-Credential` scheme. Space hosts resolve through `#atproto_pds`. Commits and records are verified with MACs keyed against each author's `#atproto_kem` key, and full repos arrive as STAR archives. Accounts that haven't published a KEM key can't be synced until their PDS publishes one.

## 0.7.0

### Minor Changes

- 384edf8: `blob.get` streams large blobs while it checks their CID, so the AppView no longer holds whole videos in memory. A CID mismatch found at the end aborts the connection. The blob cache only keeps blobs up to 16 MB, keys entries by DID, space and CID, and shares one upstream fetch between concurrent requests for the same blob. Blobs outside the media types are served as sandboxed `application/octet-stream` downloads, and missing and rejected blobs are logged with a code. `XrpcClient.stream` applies its timeout to the response headers only and aborts a body that sends nothing for `idleTimeoutMs`, 30 seconds by default

## 0.6.0

### Minor Changes

- 56da297: Communities can have custom emoji and emoji packs. They're stored as Bluemoji records in the community's own repo, any repo's emoji can be listed with `emoji.getCatalog`, and changes reach clients live through `emojiEvent`.

## 0.5.0

### Minor Changes

- ef70f83: Targets the 2026-10-01 atproto Spaces alpha. Space credentials are bound with HTTP Message Signatures and carry the audience of each request, a revoked or rejected credential is replaced once through a fresh delegation, sync follows `spaceRev` and catches up from `listRepos` after a gap, and `createSpace` sends `spaceType`. The vendored space lexicons move to atproto `679724ad`.

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
