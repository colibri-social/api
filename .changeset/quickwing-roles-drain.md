---
"@colibri-social/appview-db": minor
"@colibri-social/appview": minor
---

Run AppView nodes by role and shut them down gracefully.

- `ROLES` decides what a node runs. `api` serves XRPC, blobs and embeds. `live` accepts event sockets. `voice` starts the SFU and voice signaling. `main` runs ingest, sweeps, heals and migration jobs, but only on the one node holding the main Postgres advisory lock. Another `main` node waits and takes over when the holder goes away.
- Migrations run only on `main` nodes, one at a time behind their own advisory lock.
- `DATABASE_READ_URL` sends reads to a Postgres replica. Writes and transactions stay on `DATABASE_URL`.
- On SIGTERM or SIGINT a node drains: `/health` answers 503 with the deadline, every event socket gets a `drainNotice`, and the node waits until its connections are gone or the deadline passes. The deadline is `DRAIN_GRACE_MINUTES` (default 120) when other active nodes can take the clients, and 15 seconds when the node is alone. A second signal skips the wait.
- A node that loses the main lock shuts down with exit code 1, so its supervisor restarts it.
- `@colibri-social/appview-db` exports `holdLock`, `postgresAdvisoryLock` and `grantedLock`, and `Database.advisoryLock()`.
- The single-node `docker-compose.yml` gives the container 45 seconds to stop.
