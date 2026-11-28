---
"@colibri-social/space-sync": patch
"@colibri-social/appview": patch
---

Fixes messages that stayed missing on the sender's other devices until their next write. A client write hint that finds nothing new now pulls the repo again after 250 ms, 1 s and 3 s, unless a PDS notification already pulled the write. Chasing a notified revision waits between attempts on the same schedule.
