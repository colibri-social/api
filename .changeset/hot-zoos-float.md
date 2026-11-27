---
"@colibri-social/lexicons": minor
"@colibri-social/appview-db": minor
"@colibri-social/notifications": minor
"@colibri-social/appview": minor
---

Delivers notifications to the other AppViews a user declared:

- When a message notifies someone, the managing AppView queues a `federation.deliverNotification` call for each AppView in the recipient's `actor.appview` record other than itself. The call carries the rendered notification plus the Space and channel names for the push banner. `deliverNotification` has new optional `spaceName` and `channelName` inputs.
- The main node sends queued deliveries right away and checks the queue every 15 seconds. A failed delivery is tried again after 30 seconds, 2, 10 and 30 minutes, then hourly. Deliveries still undelivered after 24 hours are dropped, as are deliveries the other AppView refuses for good. They live in the new `federation_deliveries` table, added by migration 0050.
- The receiving AppView accepts a delivery when the caller manages the notification's Space and the recipient declared the receiving AppView. Blocked peers and the per-peer rate limit apply. It stores the notification with its view, sends it to the user's sockets, counts it toward the badge and pushes it. A repeated delivery for the same message is ignored.
- `listNotifications` serves a delivered notification from its stored view.
