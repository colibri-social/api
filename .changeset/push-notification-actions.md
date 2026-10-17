---
"@colibri-social/lexicons": minor
"@colibri-social/notifications": minor
"@colibri-social/appview": minor
---

Adds `social.colibri.beta.notification.markReadFromNotification`, an unauthenticated procedure that marks a channel or thread read from a signed push token, and grants it in `social.colibri.beta.permissionPush`. Push payloads carry `type`, `kind`, `spaceName`, `placeName`, `subtitle`, `body`, `badge`, `readUrl` and `readToken`. APNs alerts use the author as title, the in-app subtitle, the unread badge, `ping.caf` and the `message` category. Reading a channel, deleting a message and editing a message send `read`, `delete` and `edit` background pushes to APNs and FCM devices. Set `PUSH_ACTION_SECRET` to sign the read tokens.
