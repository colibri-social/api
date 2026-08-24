---
"@colibri-social/projections": patch
"@colibri-social/appview": patch
---

Reconcile a mute by its subject rather than its record key, so the immediate `actor.putMutes` push and the later repo sync of the same mute no longer collide on the one-mute-per-subject index and strand the user's preferences space with an unapplied cursor
