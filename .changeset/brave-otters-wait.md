---
"@colibri-social/appview": patch
"@colibri-social/appview-db": patch
---

Fixes a main node hanging when Jetstream writes outpace its database. Jetstream now processes at most 8 events at a time and stops reading from the socket until one finishes. A paused socket no longer counts as idle.

Postgres pools give up on a query after waiting 10 seconds for a connection. A query that waits longer fails with an error.

While the main node's database watch reports the primary as down, `/cluster/ping` and writes forwarded from sub nodes answer 503 `DatabaseUnavailable`. Sub nodes queue those writes for up to `WRITE_QUEUE_SECONDS`.

A rollout hands the main role to the failover node only when the failover node holds the Postgres primary. Otherwise it restarts the main node in place, and sub nodes queue writes during the restart.
