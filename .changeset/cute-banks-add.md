---
"@colibri-social/lexicons": patch
"@colibri-social/appview": patch
---

`federation.deliverNotification`, `federation.deliverRead` and `federation.retract` declare an empty JSON output, like every other method, and the AppView answers them with an empty object.
