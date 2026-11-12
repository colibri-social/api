---
"@colibri-social/appview": patch
"@colibri-social/appview-db": patch
---

Skips schema migrations at startup while the database is read-only, so a main node whose Postgres is fenced or rebuilding as a replica starts instead of crashing. A node runs the migrations when it takes the main role. `@colibri-social/appview-db` exports `acceptsWrites`
