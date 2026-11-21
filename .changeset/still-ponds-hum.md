---
"@colibri-social/community": minor
"@colibri-social/appview": minor
---

Posting in a voice channel's chat needs `message.send` and `voice.chat`, so a channel override that denies `message.send` makes the chat read-only while members keep reacting. `voice.chat` controls reading the chat, and joining the call still needs `voice.connect`. A voice channel's legacy posting allow list restricts joining, chat posting and reactions. The new `canConnect` check replaces `canPost` for joining a call.
