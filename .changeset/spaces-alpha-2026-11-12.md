---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/community": patch
"@colibri-social/identity": minor
"@colibri-social/lexicons": minor
"@colibri-social/space": minor
"@colibri-social/space-sync": minor
---

Moves Spaces support to the November 12, 2026 alpha (`0.0.0-spaces-alpha-20261112204144`). PDSes on the November 5 alpha can't talk to this release.

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
