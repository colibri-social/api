# @colibri-social/space-sync

## 0.10.0

### Minor Changes

- 61e8260: Hosts the space repos of accounts whose PDS can't serve spaces, and hands them back once it can.
  
  - `social.colibri.beta.polyfill.getStatus` reports where an account's repos live and whether its PDS serves spaces. It checks the PDS through the service descriptor first and a probe second, caching a yes for 24 hours and a no for an hour. An account whose PDS lacks spaces is hosted from its first status check or write.
  - `social.colibri.beta.polyfill.applyWrites` authorizes a write the way the space authority would, stores it, projects it, and emits the same live events as a synced write. A repo on the account's PDS gets `RepoNotHosted`.
  - `social.colibri.beta.polyfill.getRecord` and `listRecords` read the account's hosted records.
  - `social.colibri.beta.polyfill.beginMigration`, `listForMigration` and `completeMigration` move each repo to the PDS. Completion reads the PDS copy with MAC verification and compares its set hash with the hosted copy. A match hands the repo to the sync engine with its cursor in place. A mismatch keeps the repo hosted and lists the records that differ.
  - An account whose sync fails because its PDS dropped spaces is hosted again once a fresh check confirms it.
  - The uploadBlob and getBlob routes are registered, writes mark the blobs they reference, and the blob sweeper runs on main nodes.
  
  `@colibri-social/appview-db` adds the `polyfill_actors`, `polyfill_repos`, `polyfill_pds_support` and `polyfill_blobs` tables.
  
  `@colibri-social/space-sync` skips repos the AppView hosts in sweeps and write hints, reports members whose PDS lacks spaces through `SyncStore.spacesUnsupported`, and adds `SpaceSyncEngine.publish`, `fetchVerifiedRepo` and `recordCid`.
  
  `@colibri-social/projections` accepts a message whose record key is more than a day older than its commit when the AppView already holds it.

## 0.9.0

### Minor Changes

- 3b3b2b7: Moves Spaces support to the November 12, 2026 alpha (`0.0.0-spaces-alpha-20261112204144`). PDSes on the November 5 alpha can't talk to this release.
  
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

### Patch Changes

- Updated dependencies [3b3b2b7]
  - @colibri-social/space@0.12.0

## 0.8.0

### Minor Changes

- ac153a2: Report metrics, traces and logs, and send an anonymous daily heartbeat.
  
  - The AppView serves Prometheus metrics on `METRICS_HOST:METRICS_PORT` (default `127.0.0.1:9464`, `0` turns them off), labeled with the node and region: XRPC duration by method and status, client sockets, Jetstream lag and events, the space sync queue, lag and failures, push deliveries by provider and outcome, drain state, write mode and queued writes, calls and participants, SFU worker CPU, bitrate, packet loss and transports by ICE state, and TURN credential requests.
  - Sentry traces every request except `/health` and keeps those over 1 second, those that failed, and `SENTRY_TRACES_SAMPLE_RATE` (default 0.1) of the rest. Voice joins, transport setup, space repo syncs and push sends get their own spans. Logs at info and above go to Sentry Logs. Clustered nodes tag events with their ID, region and roles.
  - The main node sends an anonymous heartbeat once a day to `COLIBRI_TELEMETRY_URL` (default `https://telemetry.colibri.social/v1/heartbeat`), an hour after the first start logs a notice. Counts are rounded into ranges. `COLIBRI_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` turns it off.
  - `@colibri-social/telemetry` builds, buckets and sends the heartbeat.
  - `VoiceSfu.stats()` reports calls, participants, transport stats and worker CPU. `WorkerPool.usage()` reads worker CPU time.
  - `SpaceSyncEngine.queueStats` reports pending and running repo syncs.

## 0.7.1

### Patch Changes

- 19be678: Update Spaces support to the November 5 alpha (`0.0.0-spaces-alpha-20261105160032`). STAR archives from `getRepo` use the new control-byte framing through the `@atproto/space` helpers, so the AppView needs a PDS on the same alpha. `@atproto/star` is pinned to the alpha build, because its caret range otherwise resolves to a broken `0.0.0-stage` release. The vendored atproto space lexicons move to `704b9e2a`, which adds `RepoTakendown` and `RepoDeactivated` to `getSpaceCredential` and `listRepos`. A suspended space keeps its synced data and retries, as before.
- Updated dependencies [19be678]
  - @colibri-social/space@0.11.1

## 0.7.0

### Minor Changes

- e3aa164: Address reactions and replies by full record URI. `social.colibri.beta.reaction` gains an optional `uri` and `social.colibri.beta.message` an optional `parentUri`, next to the existing `target` and `parent` references. The projections read the URI first and fall back to the reference when the URI is missing, unparseable, in another space, or in another collection. `bridge.addReaction` takes an optional `uri`, and `bridge.postMessage` and `bridge.importMessages` take an optional `parentUri`. Records the community writes for a bridge carry both forms.
  
  `reactionEvent` gains `uri` for the target message and `reaction` for the reaction record itself, and its `target` now follows the URI when the record has one. Deleting a reaction record now publishes a `reactionEvent` with `event: "delete"`. A `messageEvent` delete carries `subjectUri`. `RecordDelete` in `@colibri-social/space-sync` carries the removed record's `previous` value when the store held it. `@colibri-social/space` adds `sameSpaceRecordPointer`, `tryParseSpaceRecordUri` and `trySpaceRecordUri`.

### Patch Changes

- Updated dependencies [e3aa164]
  - @colibri-social/space@0.11.0

## 0.6.3

### Patch Changes

- Updated dependencies [b3f77f4]
  - @colibri-social/space@0.10.0

## 0.6.2

### Patch Changes

- 9ab78a0: Stop a full repo resync from notifying, pushing or streaming messages that were already indexed unchanged. Only new or changed records go through the notification pipeline.
- 28372a2: Fix attachments, avatars and role images that failed to load after a repo was synced for the first time, such as messages in a new channel or thread. On startup, the AppView resyncs every repo stored with a broken blob reference.

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
