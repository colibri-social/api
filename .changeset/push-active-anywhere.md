---
"@colibri-social/lexicons": minor
"@colibri-social/appview-db": minor
"@colibri-social/notifications": minor
"@colibri-social/appview": minor
---

Hold back push notifications while the recipient is active on another device. Clients send the new `activity` sync frame while they are visible and focused, and each one keeps the account active for 5 minutes. Notification rows still land, so unread and mention badges keep counting. A message in a channel that any of the account's devices has open skips both the row and the push.

Track the channel in view and the activity per connection in the new `presence_connections` table, so one device no longer overwrites another's view. Connections refresh their row every 30 seconds, and rows older than 2 minutes are ignored and swept at startup, which clears views left behind by a restart. The `viewing_channel` column on `user_presence` is dropped.

Voice channel messages and edits no longer push to anyone, since the only people they reached were the call's participants. The notification rows stay.
