---
"@colibri-social/appview": patch
"@colibri-social/space-sync": patch
---

Stop retrying spaces the AppView cannot mint a credential for. A space that fails with `noDelegationToken` now goes dormant instead of retrying `registerNotify` every minute and failing every sweep, and a fresh grant from the client wakes it again. A space whose owning community is gone is dropped outright, and purging a community now tells the sync engine so its spaces leave the registration map
