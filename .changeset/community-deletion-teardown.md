---
"@colibri-social/appview": minor
"@colibri-social/community": minor
"@colibri-social/space-sync": patch
---

Tell every member when a community is deleted and drop its data straight away, so it stops being listed and stops being served the moment its owner deletes it instead of lingering until its PDS reports the deletion. Deleting a community now also deletes its channel spaces, and a community whose profile space disappears out of band is reconciled the same way.
