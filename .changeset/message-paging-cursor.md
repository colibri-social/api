---
"@colibri-social/appview": patch
---

Fixes message paging past the second page. `channel.listMessages` and thread message lists now return a cursor on every page that has more messages after it, in both directions, so clients can load a channel's full history.
