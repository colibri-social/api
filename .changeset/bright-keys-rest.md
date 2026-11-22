---
"@colibri-social/identity": patch
"@colibri-social/appview": patch
---

`IdentityResolver.resolveDid` and `resolveAtIdentifier` resolve a DID whose document publishes no handle, such as one with `alsoKnownAs: ["at://"]`, and return `handle: null`. The document still needs a signing key and an `#atproto_pds` service. `social.colibri.beta.bridge.install` accepts such a bridge DID and names the registration after the DID.
