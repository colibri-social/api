---
"@colibri-social/admin": minor
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/blobs": minor
---

Add `colibri-admin network down` and `network up` to park and restart every node at once, and `colibri-admin db wipe` to empty the AppView data and the polyfill bucket while the network is down. The main node keeps the main role while parked and stops Jetstream and its background jobs.
