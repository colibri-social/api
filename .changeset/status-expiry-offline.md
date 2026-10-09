---
"@colibri-social/lexicons": minor
"@colibri-social/appview-db": minor
"@colibri-social/appview": minor
---

Raises the status text limit from 32 to 64 bytes and adds `expiresAt` and `showWhileOffline` to the status. `actor.setStatus` takes both fields and clears an expiry with `removeExpiresAt`. Presence views and events leave out a status once its expiry has passed. `showWhileOffline` defaults to false and is passed through for clients to apply.
