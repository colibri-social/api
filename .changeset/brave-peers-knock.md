---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/admin": minor
---

Accept requests another AppView forwards on a user's behalf. The forwarding AppView signs a service JWT as itself and names the user in the `colibri-acting-for` header. The request goes through only when the user's `social.colibri.beta.actor.appview` record lists that AppView, the AppView isn't blocked, and it stays under `FEDERATION_PEER_RATE` and `FEDERATION_PEER_BURST`. `FEDERATION_ENABLED=false` refuses all of them with `FederationDisabled` and drops `federation` from `describeServer`. `colibri-admin federation block|unblock|list` manages the blocklist
