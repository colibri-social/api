---
"@colibri-social/appview": patch
"@colibri-social/projections": patch
"@colibri-social/embeds": patch
---

Fix channel reordering after a channel was deleted, and repair every category's channel order on startup and on each reorder. A new channel now takes its category's visibility rules as soon as it syncs. Messages edited outside Colibri now show as edited, a second reaction record with the same emoji no longer leaves a stale reaction behind, and links that point straight at an image, SVG included, now preview as that image.
