---
"@colibri-social/appview": patch
"@colibri-social/community": patch
---

`social.colibri.beta.community.listMigratable` leaves out legacy communities stored in their owner's repo. `legacyCandidates` no longer lists the actor's own repo for them.
