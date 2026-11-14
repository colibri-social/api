---
"@colibri-social/admin": patch
"@colibri-social/appview": patch
---

`colibri-admin node shutdown` on the main node moves the Postgres primary and the main role to the failover node first, then drains the old main. The switchover picks a node with the failover role when no other main node is free.
