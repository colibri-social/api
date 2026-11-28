---
"@colibri-social/appview": patch
---

Fixes the Jetstream consumer stalling on a connection that stays open but stops delivering events. It now pings the server every 15 seconds and reconnects from the last cursor after 60 seconds without a message or pong.
