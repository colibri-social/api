---
"@colibri-social/appview": patch
---

Publish the SFU's media port range for TCP as well as UDP, so the ICE over TCP fallback the SFU advertises can be reached. A port Docker does not forward drops the connection attempt without a reply, which fails ICE and leaves callers in silence.
