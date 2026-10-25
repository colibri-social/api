---
"@colibri-social/space-sync": patch
"@colibri-social/appview": patch
---

Stop a full repo resync from notifying, pushing or streaming messages that were already indexed unchanged. Only new or changed records go through the notification pipeline.
