---
"@colibri-social/appview": patch
"@colibri-social/appview-db": patch
"@colibri-social/community": patch
"@colibri-social/lexicons": minor
"@colibri-social/notifications": patch
"@colibri-social/projections": patch
"@colibri-social/space": patch
"@colibri-social/space-sync": patch
---

Move to the `0.0.0-spaces-alpha-20261124235736` atproto packages, which address spaces as `at:space/{did}/{type}/{skey}`, drop the `legacySpaceUris` feature and `LEGACY_SPACE_URIS`, rewrite stored `at://{did}/space/...` URIs to the new form, and keep indexing records that still embed the old form
