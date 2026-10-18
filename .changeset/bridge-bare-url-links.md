---
"@colibri-social/bridge-core": patch
---

Bare `http` and `https` URLs in bridged messages become link facets, so they get link previews and a message that is only a GIF URL shows the GIF. URLs inside code stay plain text, and `www.` and email literals aren't linked.
