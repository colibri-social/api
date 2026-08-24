---
"@colibri-social/appview": patch
"@colibri-social/voice": patch
---

Wait for every mediasoup worker subprocess to exit before the appview process does, so a restart no longer fails on ports the old workers still hold
