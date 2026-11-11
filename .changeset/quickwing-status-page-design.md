---
"@colibri-social/appview": patch
---

Redesign the status page. `deploy/uptime-kuma/status.css` gives it Colibri's type, colors and layout in light and dark, with readable incident and maintenance cards in every style. The main node now sets the page title to "Colibri status", adds a description and footer links, uploads the Colibri logo when the page still has Kuma's, refreshes the page every 60 seconds and hides tags and certificate expiry.
