---
"@colibri-social/notifications": minor
"@colibri-social/appview": patch
---

Notifications, push banners and edit pushes for bridged messages show the remote author's name and avatar instead of the community. `hydrateNotifications` takes a `NotificationAuthors` object with an optional `resolveMessageAuthor`, and `deliverMessageEdited` accepts a sender per recipient
