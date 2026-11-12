---
"@colibri-social/admin": patch
---

Asks for `CREDENTIAL_ENCRYPTION_KEY` only in commands that read or write the shared settings, so node and database commands such as `db switchover` run on sub and failover nodes
