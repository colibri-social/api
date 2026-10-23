---
"@colibri-social/appview": patch
"@colibri-social/projections": patch
"@colibri-social/space-sync": patch
"@colibri-social/space": patch
"@colibri-social/community": patch
---

Refuse a message whose record key isn't a TID, or whose record key or `createdAt` is more than 15 minutes ahead of the server clock. Refuse a newly created message whose record key is more than 24 hours older than the commit that created it, except for history a bridge imported. A thread's last activity never moves past the server clock. Add `pnpm --filter @colibri-social/appview purge-future-messages`, which lists projected messages dated more than 15 minutes ahead and the thread activity it would rewind, and deletes them with `--apply`.
