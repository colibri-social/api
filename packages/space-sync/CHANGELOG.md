# @colibri-social/space-sync

## 0.6.1

### Patch Changes

- 7097dbf: Refuse a message whose record key isn't a TID, or whose record key or `createdAt` is more than 15 minutes ahead of the server clock. Refuse a newly created message whose record key is more than 24 hours older than the commit that created it, except for history a bridge imported. A thread's last activity never moves past the server clock. Add `pnpm --filter @colibri-social/appview purge-future-messages`, which lists projected messages dated more than 15 minutes ahead and the thread activity it would rewind, and deletes them with `--apply`.
- Updated dependencies [7097dbf]
- Updated dependencies [73d1143]
  - @colibri-social/space@0.9.0

## 0.6.0

### Minor Changes

- 0b325da: Update Spaces support to the October 22 alpha (`0.0.0-spaces-alpha-20261022141228`). Space credentials are requested with a JSON body and presented with the `Atproto-Space-Credential` scheme. Space hosts resolve through `#atproto_pds`. Commits and records are verified with MACs keyed against each author's `#atproto_kem` key, and full repos arrive as STAR archives. Accounts that haven't published a KEM key can't be synced until their PDS publishes one.

### Patch Changes

- Updated dependencies [0b325da]
  - @colibri-social/space@0.8.0

## 0.5.4

### Patch Changes

- Updated dependencies [384edf8]
  - @colibri-social/space@0.7.0

## 0.5.3

### Patch Changes

- Updated dependencies [56da297]
  - @colibri-social/space@0.6.0

## 0.5.2

### Patch Changes

- ac08881: Logs sync failures against a PDS without spaces support at debug level. Those repos still retry on the usual backoff.

## 0.5.1

### Patch Changes

- 5640cde: Stops retrying sync for authors whose DID document has no `#atproto_pds` service, and logs the message and cause of every `error` field.
- ef70f83: Targets the 2026-10-01 atproto Spaces alpha. Space credentials are bound with HTTP Message Signatures and carry the audience of each request, a revoked or rejected credential is replaced once through a fresh delegation, sync follows `spaceRev` and catches up from `listRepos` after a gap, and `createSpace` sends `spaceType`. The vendored space lexicons move to atproto `679724ad`.
- Updated dependencies [ef70f83]
  - @colibri-social/space@0.5.0

## 0.5.0

### Minor Changes

- d8e32d1: Spaces now carry separate read and write policies, and a space credential no longer implies the right to post

### Patch Changes

- c13dd17: The sync engine can now ask the appview whether a space is renewable at all, and parks the ones that are not without warning on every startup
- Updated dependencies [6e75d20]
- Updated dependencies [d8e32d1]
  - @colibri-social/space@0.4.0

## 0.4.1

### Patch Changes

- Updated dependencies [1ed3c64]
  - @colibri-social/space@0.3.0

## 0.4.0

### Minor Changes

- 58aea35: Serve threads: a thread space projects to its own table, access follows the parent channel and the thread's own visibility, and the thread methods create, rename, repoint, delete and move messages between spaces. Notifications now check that the recipient may read the space, which stops a mention in a private channel or thread reaching someone outside it.

## 0.3.2

### Patch Changes

- b03c206: Exit on a fatal error so the container restarts clean, guard the async paths that could reach one, and cap the repo CAR buffer

## 0.3.1

### Patch Changes

- 1d48890: Stop retrying spaces the AppView cannot mint a credential for. A space that fails with `noDelegationToken` now goes dormant instead of retrying `registerNotify` every minute and failing every sweep, and a fresh grant from the client wakes it again. A space whose owning community is gone is dropped outright, and purging a community now tells the sync engine so its spaces leave the registration map

## 0.3.0

### Minor Changes

- 324a3e6: Move commit verification and repo recovery onto worker threads, so a large repo no longer stalls message delivery for every other channel. Set SYNC_WORKER_THREADS to turn it on

### Patch Changes

- 321e7dc: Tell every member when a community is deleted and drop its data straight away, so it stops being listed and stops being served the moment its owner deletes it instead of lingering until its PDS reports the deletion. Deleting a community now also deletes its channel spaces, and a community whose profile space disappears out of band is reconciled the same way.

## 0.2.1

### Patch Changes

- d175422: Deliver messages as soon as they are written instead of sometimes waiting for the next sweep, by no longer dropping a write notification that arrives while a sync is already running, renewing the notify registration on its own schedule, and publishing a message before its notifications are indexed
- Updated dependencies [132dd5a]
  - @colibri-social/space@0.2.1

## 0.2.0

### Minor Changes

- 152a8fb: Let a store name the repos a space expects, so a sweep keeps a member's repo even when the authority's writer set leaves it out

### Patch Changes

- Updated dependencies [152a8fb]
  - @colibri-social/space@0.2.0

## 0.1.1

### Patch Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace
- Updated dependencies [49310eb]
  - @colibri-social/space@0.1.1

## 0.1.0

### Minor Changes

- 42ec07e: Initial release

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/space@0.1.0
