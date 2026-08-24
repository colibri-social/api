---
"@colibri-social/appview": patch
---

Run each actor's presence transitions in order, so a socket that opens and closes in quick succession can no longer swallow the offline broadcast and leave that member listed as online for everyone else
