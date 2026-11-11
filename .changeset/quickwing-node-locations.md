---
"@colibri-social/appview": patch
"@colibri-social/admin": patch
"@colibri-social/appview-db": patch
---

Show where each node runs on the status page. Nodes have an optional location, set with `colibri-admin node add --location "Helsinki, Finland"` or `colibri-admin node location <id> [<text>]`, and listed by `node list`. Status page monitors use it as their name and fall back to the node ID. A changed location renames the monitor in place, so its uptime history stays. Region groups are titled by area (Europe, North America, South America, Asia, Oceania, Middle East, Africa) in that order, after the API. Adds a `location` column to `nodes` and `node_join_tokens`.
