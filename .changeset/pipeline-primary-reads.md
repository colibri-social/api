---
"@colibri-social/appview": patch
---

Read synced records back from the Postgres primary when publishing live events. A new message now reaches other clients, and its notification keeps the attachments, while the main node runs on a host with a lagging read replica
