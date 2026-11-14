---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/space-sync": minor
"@colibri-social/projections": patch
---

Hosts the space repos of accounts whose PDS can't serve spaces, and hands them back once it can.

- `social.colibri.beta.polyfill.getStatus` reports where an account's repos live and whether its PDS serves spaces. It checks the PDS through the service descriptor first and a probe second, caching a yes for 24 hours and a no for an hour. An account whose PDS lacks spaces is hosted from its first status check or write.
- `social.colibri.beta.polyfill.applyWrites` authorizes a write the way the space authority would, stores it, projects it, and emits the same live events as a synced write. A repo on the account's PDS gets `RepoNotHosted`.
- `social.colibri.beta.polyfill.getRecord` and `listRecords` read the account's hosted records.
- `social.colibri.beta.polyfill.beginMigration`, `listForMigration` and `completeMigration` move each repo to the PDS. Completion reads the PDS copy with MAC verification and compares its set hash with the hosted copy. A match hands the repo to the sync engine with its cursor in place. A mismatch keeps the repo hosted and lists the records that differ.
- An account whose sync fails because its PDS dropped spaces is hosted again once a fresh check confirms it.
- The uploadBlob and getBlob routes are registered, writes mark the blobs they reference, and the blob sweeper runs on main nodes.

`@colibri-social/appview-db` adds the `polyfill_actors`, `polyfill_repos`, `polyfill_pds_support` and `polyfill_blobs` tables.

`@colibri-social/space-sync` skips repos the AppView hosts in sweeps and write hints, reports members whose PDS lacks spaces through `SyncStore.spacesUnsupported`, and adds `SpaceSyncEngine.publish`, `fetchVerifiedRepo` and `recordCid`.

`@colibri-social/projections` accepts a message whose record key is more than a day older than its commit when the AppView already holds it.
