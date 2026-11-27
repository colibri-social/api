---
"@colibri-social/notifications": minor
"@colibri-social/appview": minor
---

Keeps notifications on other AppViews in step with the managing AppView:

- When a message is deleted or hidden, the managing AppView sends `federation.retract` to the other AppViews of everyone it notified. The receiving AppView drops that notification, updates the user's badge on their sockets and clears the pushed banner. It only drops notifications the calling AppView delivered.
- When a user's read covers notifications the managing AppView sent elsewhere, it sends `federation.deliverRead` and marks its own copies seen, so the next read doesn't send it again. The receiving AppView clears the matching pushed banners.
- The managing AppView now keeps plain message notifications for users of other AppViews, even without a push device on it, so retractions and reads can find them. `NotificationDeps` has a new optional `usesOtherAppviews` check for this.
