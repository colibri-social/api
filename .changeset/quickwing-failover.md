---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/admin": minor
---

Fail the Postgres primary over to the failover node automatically and fence the old one.

- `DATABASE_URL` can list several hosts. `@colibri-social/appview-db` connects to the one that accepts writes and has the highest epoch in `cluster_state`, rechecks every 10 seconds, and moves on read-only and connection errors. Advisory locks and the event bus follow it. It exports `FollowingPool`, `parsePostgresUrl`, `formatPostgresUrl`, `hostUrls`, `probeHost`, `pickPrimary` and `resolvePrimaryUrl`.
- Every clustered node serves `GET /cluster/alive` on `CLUSTER_PORT` with the time it lost the primary. The failover node promotes its local Postgres (`LOCAL_POSTGRES_URL`, or `DATABASE_READ_URL`) once the primary has been unreachable for `FAILOVER_AFTER_SECONDS` (default 60) for it and for more than half of the nodes without the `main` or `failover` role. Promotion raises the epoch and creates replication slots for the other nodes. Without a witness node it doesn't promote on its own.
- A writable Postgres with a lower epoch than the primary is fenced: it turns read-only and drops its client and replication connections. Nodes with the SSH key rebuild their own fenced Postgres with `rejoin-replica`, and the main node rebuilds other main and failover nodes.
- `colibri-admin db failback [<node>]` moves the primary back to a node with the `main` role in a planned switchover. `colibri-admin db promote` promotes a failover node's Postgres by hand.
- Replicas take a list of primary hosts in `PRIMARY_HOST` and stream with `target_session_attrs=read-write`. The main node's Postgres in `docker-compose.scaled.yml` uses the same entrypoint, so it can be rebuilt as a replica. Its AppView takes `DATABASE_URL` from `.env` when set.
- Provisioning a failover node runs the new `database-hosts` playbook on every node. `rejoin-replica` takes `primary_hosts` and runs detached on the node that starts it.
