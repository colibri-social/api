---
"@colibri-social/appview": patch
---

`listCommunities` reuses the view of a Space on another AppView for 30 seconds per user, so repeated loads don't ask that AppView again each time
