---
"@colibri-social/appview": patch
"@colibri-social/appview-db": patch
"@colibri-social/lexicons": patch
"@colibri-social/notifications": patch
---

Tighten federation between AppViews:

- `deliverNotification`, `deliverRead` and `retract` answer `NotJoined` when the recipient has no `remote_spaces` row for the community, and `deliverNotification` refuses a channel or thread outside the notification's community. A failed host or declaration lookup answers `UpstreamFailure` with a 502.
- A delivered notification is dropped when the recipient blocked its author or muted the author, community, channel or thread. Listing delivered notifications applies the recipient's blocks.
- A `colibri-acting-for` request is only accepted on forwarded methods and `polyfill.beginMigration`. Other methods answer `ActingForNotAllowed`.
- Forwards and deliveries refuse endpoints on private, loopback, link-local or unique-local addresses outside development and test. An oversized or interrupted answer counts as unreachable and the router answers 502.
- With `FEDERATION_ENABLED=false`, the router decides from the local `communities` table alone. Personal spaces never trigger a host lookup.
- Deliveries retry `NotDeclared` and `NotJoined`, and each queued row is claimed before it's sent, so two runners never send the same row. A failed declared AppViews lookup is cached as empty for a minute.
- Checks against this AppView's DID accept every alias in `APPVIEW_DID_ALIASES`.
- Migration 0051 removes duplicate notifications, keeping the earliest, and adds a unique index on `notifications (recipient, space, message_author, message_rkey)`. Inserts into `notifications` ignore conflicts.
