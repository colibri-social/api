---
"@colibri-social/notifications": patch
---

Send the routing hints the clients read on a push notification tap. The payload now carries `channelUri`, `messageUri` and, for FCM, a `social.colibri:/channel/...` deep link plus the message body, so a tap can open the right channel and focus the message instead of falling back to the app root
