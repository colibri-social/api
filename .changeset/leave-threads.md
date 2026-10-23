---
"@colibri-social/lexicons": minor
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/notifications": patch
---

Let `social.colibri.beta.actor.putMutes` carry an optional `leftThreads` list next to `mutes`, which is now optional too. Each list a request carries replaces the stored copy, and a list it leaves out stays as it is. `getPreferences` returns the list as `leftThreads`. A user who left a thread gets no plain message notifications for it and drops out of its member list unless they follow it. A mention or a reply in the thread brings them back and removes the entry. The new `left_threads` table holds the list.
