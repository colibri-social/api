---
"@colibri-social/lexicons": minor
"@colibri-social/appview-db": minor
"@colibri-social/appview": minor
---

Add the foundation for running the AppView as a network of nodes.

Lexicons:
- `social.colibri.beta.server.listNodes` lists the nodes that accept clients, each with a region, roles, an endpoint and a probe URL.
- `describeServer` can report the `nodes` feature.
- The sync socket gains a `drainNotice` frame, a `writeState` frame and a `ReadOnly` error.
- Voice signaling gains `migrationProposal`, `rttReport`, `migrateTo`, `moveNow` and `callElsewhere`. `joined` carries the node ID and region, and `disconnected` adds the `nodeClosed` and `migrated` reasons.
- `attachmentView` has an optional `previewUrl` for a smaller inline image.
- `listMessages` can name `unavailableAuthors` when a page is missing messages from an unreachable PDS.

Database:
- New tables for the node registry, join tokens, cluster config and state, voice call placement, oversized event payloads and telemetry state.
- New columns: `presence_connections.node_id`, `space_repos.host` and `messages.rehydrated_at`.
- `Database.ping()` checks the connection on SQLite and Postgres.
- `openTestDatabase` creates a throwaway Postgres database when `TEST_DATABASE_URL` is set.

AppView:
- `/health` works on Postgres.
- New settings: `ROLES`, `NODE_ID`, `NODE_REGION`, `MAIN_NODE_URL`, `DATABASE_READ_URL`, `DRAIN_GRACE_MINUTES`, `WRITE_QUEUE_SECONDS`, `MESSAGE_RETENTION_DAYS`, `SFU_RTC_PORT`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`, `BLOB_DISK_CACHE_DIR`, `BLOB_DISK_CACHE_MAX_BYTES`, `COLIBRI_TELEMETRY_DISABLED` and `DO_NOT_TRACK`. Nothing reads them yet.
