---
"@colibri-social/lexicons": minor
"@colibri-social/appview-db": minor
"@colibri-social/projections": minor
"@colibri-social/appview": minor
---

`actor.grantSpaceAccess` takes an optional `community`, which sends the grant to the AppView that manages that community. The new `remote_spaces` table holds the user's `actor.remoteSpace` records, and `actor.listCommunities` lists those communities next to local ones in the stored order. Communities whose AppView doesn't answer within 3 seconds come back in `unavailable`
