---
"@colibri-social/space": minor
"@colibri-social/space-sync": minor
"@colibri-social/identity": minor
"@colibri-social/lexicons": minor
"@colibri-social/appview": minor
---

Update Spaces support to the October 22 alpha (`0.0.0-spaces-alpha-20261022141228`). Space credentials are requested with a JSON body and presented with the `Atproto-Space-Credential` scheme. Space hosts resolve through `#atproto_pds`. Commits and records are verified with MACs keyed against each author's `#atproto_kem` key, and full repos arrive as STAR archives. Accounts that haven't published a KEM key can't be synced until their PDS publishes one.
