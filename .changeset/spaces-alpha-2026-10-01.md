---
"@colibri-social/lexicons": minor
"@colibri-social/space": minor
"@colibri-social/space-sync": patch
"@colibri-social/appview-db": patch
"@colibri-social/community": patch
"@colibri-social/appview": patch
---

Targets the 2026-10-01 atproto Spaces alpha. Space credentials are bound with HTTP Message Signatures and carry the audience of each request, a revoked or rejected credential is replaced once through a fresh delegation, sync follows `spaceRev` and catches up from `listRepos` after a gap, and `createSpace` sends `spaceType`. The vendored space lexicons move to atproto `679724ad`.
