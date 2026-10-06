---
"@colibri-social/appview": patch
"@colibri-social/identity": patch
"@colibri-social/space-sync": patch
---

Stops retrying sync for authors whose DID document has no `#atproto_pds` service, and logs the message and cause of every `error` field.
