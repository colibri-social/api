---
"@colibri-social/appview": patch
---

Keep delivering a channel's events after a client releases its own hold on a channel that its community subscription still grants. Releasing a channel now drops only the explicit hold, and unsubscribing a community drops only the channels it granted.
