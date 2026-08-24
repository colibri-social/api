---
"@colibri-social/appview": patch
"@colibri-social/space-sync": minor
---

Move commit verification and repo recovery onto worker threads, so a large repo no longer stalls message delivery for every other channel. Set SYNC_WORKER_THREADS to turn it on
