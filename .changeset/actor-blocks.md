---
"@colibri-social/lexicons": minor
"@colibri-social/appview-db": minor
"@colibri-social/projections": minor
"@colibri-social/notifications": minor
"@colibri-social/appview": minor
---

Add private user blocks. The `social.colibri.beta.actor.block` record lives in the personal preferences space, one record per blocked DID, and `social.colibri.beta.actor.putBlocks` pushes the whole list to the AppView. `defs#preferences` gains `blocks`, so `getPreferences` and the live preferences event carry it. A blocked author's messages produce no notification or push for the blocker, a ping from them no longer brings the blocker back into a thread they left, and their existing notifications leave the blocker's inbox, unread count and badge. The new `blocks` table is added by migration 0033 and is purged on account deletion.
