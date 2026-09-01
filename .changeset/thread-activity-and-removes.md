---
"@colibri-social/appview": patch
---

Stamp the type on a thread's anchor message so getThread can serve it, keep a failing anchor lookup from taking the thread with it, carry the thread itself on activity frames so message counts stay current without a reload, and let a moved message be sent back to the channel it came from
