---
"@colibri-social/admin": patch
"@colibri-social/appview": patch
"@colibri-social/appview-db": patch
"@colibri-social/space-sync": patch
---

Stop the main-node jobs on a node that hands the main role back before they finish starting, and stop Space sync when a node gives up the main role. Park PDS hosts that keep rejecting Space sync or no longer resolve until they send a write notice again, and list or unpark them with `colibri-admin hosts parked` and `colibri-admin hosts unpark`.
