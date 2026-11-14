---
"@colibri-social/admin": minor
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
---

Adds `colibri-admin db status`, runs safety checks before `db switchover` and `db failback`, and waits until the old primary streams again. Commands that interrupt clients or delete data describe what they do and ask for confirmation, with `--yes` and `--confirm <node id>` for runs without a terminal. Nodes report their `DATABASE_URL` hosts in the heartbeat
