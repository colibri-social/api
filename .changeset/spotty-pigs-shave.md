---
"@colibri-social/lexicons": minor
"@colibri-social/space": minor
"@colibri-social/appview": minor
---

`getCommunity` reports in `viewer.preferencesAccessUntil` until when this AppView can read the caller's preferences space. The field is missing when it holds no access, so a client on another AppView knows to grant access again. `SpaceCredentials` has a new `expiry(space)` method that returns the expiry of a held credential.
