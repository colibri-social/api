---
"@colibri-social/appview": patch
---

Forward polyfill blob uploads of up to 75 MB from replica nodes to the main node. Other forwarded writes keep the 21 MB limit and are turned away before their body is read. Forwarded requests get one extra second per MiB of body before they time out, and a replica holds at most 128 MiB of writes while the main node is away.
