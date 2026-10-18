---
"@colibri-social/lexicons": minor
"@colibri-social/community": minor
"@colibri-social/appview-db": minor
"@colibri-social/projections": minor
"@colibri-social/appview": minor
---

Threads can be closed and locked. `social.colibri.beta.thread.update` accepts `closed` and `locked`, and thread views carry `closedAt`, `locked` and the new `canEdit`, `canClose`, `canDelete` and `canLock` viewer flags. The member who opened a thread can rename, close, reopen and delete it while they can still read it. Members with `thread.manage` can do all of that on any thread and can lock it, which leaves writing to them alone. A new message in a closed thread reopens it.
