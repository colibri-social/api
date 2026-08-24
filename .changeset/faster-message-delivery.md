---
"@colibri-social/appview": patch
"@colibri-social/space-sync": patch
"@colibri-social/lexicons": minor
---

Deliver messages as soon as they are written instead of sometimes waiting for the next sweep, by no longer dropping a write notification that arrives while a sync is already running, renewing the notify registration on its own schedule, and publishing a message before its notifications are indexed
