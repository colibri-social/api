---
"@colibri-social/appview": minor
"@colibri-social/admin": minor
---

Move the primary on purpose with `colibri-admin db switchover <node>`.

- `db switchover <node>` moves the Postgres primary and the main role to a node with the `main` or `failover` role, for example before maintenance on the main node's host. It uses the same steps as `db failback`, which now refuses a target without either role.
- A failover node keeps the main role while its own Postgres is the primary, so it no longer hands the role back to a `main` node that would write across the tailnet.
