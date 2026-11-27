---
"@colibri-social/appview": patch
---

Send the telemetry heartbeat only when `NODE_ENV` is `production`, so development AppViews stay out of the statistics
