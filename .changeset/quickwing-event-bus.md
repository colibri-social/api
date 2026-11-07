---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/notifications": minor
---

Share live events, authorization changes and presence across AppView nodes.

- Every announcement goes through an event bus. On SQLite it stays in memory. On Postgres it uses `LISTEN/NOTIFY` on the primary, in publish order, and payloads over the notify limit travel through `event_payloads`, which the main node clears after 10 minutes.
- Per-viewer frames travel as recipes. A message carries its rendered view and each node signs it for its own viewers. A thread event names the thread, and each node renders it with the viewer's permissions after its replica has caught up to the publisher's WAL position (up to 2 seconds).
- `Announcer` drops `toCommunityViewers` and closure frames for `message`, `thread` and `toTopics`. `toBridges` takes a frame.
- Authorization changes reach every node, so a socket on any node loses a channel it may no longer read.
- Presence counts sockets on every node. A user stays online while any node holds a fresh socket for them, and the main node sets users offline once no node has one.
- Each process claims a unique notification clock ID through a Postgres advisory lock, so two writers never mint the same notification ID. `@colibri-social/notifications` exports `setClockId` and `CLOCK_IDS`.
- `Database.waitForReplay()` waits for a read replica to reach a WAL position. `TestDatabase` exposes its `url`.
