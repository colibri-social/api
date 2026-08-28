---
"@colibri-social/appview": patch
"@colibri-social/embeds": patch
"@colibri-social/space-sync": patch
"@colibri-social/voice": patch
---

Exit on a fatal error so the container restarts clean, guard the async paths that could reach one, and cap the repo CAR buffer
