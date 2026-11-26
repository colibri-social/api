---
"@colibri-social/identity": minor
"@colibri-social/appview": minor
"@colibri-social/appview-db": patch
---

Resolve which AppView manages a community from its `community.host` record, with a 10 minute cache in `space_hosts` and a 1 minute cache for communities without one. `IdentityResolver.serviceEndpointFor` reads a service endpoint from a DID document. The federation tables are now part of the exported schema
