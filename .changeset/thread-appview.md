---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/community": minor
"@colibri-social/notifications": minor
"@colibri-social/projections": minor
"@colibri-social/space-sync": minor
---

Serve threads: a thread space projects to its own table, access follows the parent channel and the thread's own visibility, and the thread methods create, rename, repoint, delete and move messages between spaces. Notifications now check that the recipient may read the space, which stops a mention in a private channel or thread reaching someone outside it.
