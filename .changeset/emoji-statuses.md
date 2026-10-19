---
"@colibri-social/lexicons": minor
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
---

A status can be emoji-only or use a custom emoji. `actor.defs#status` makes `text` optional and gains an optional `customEmoji` ref to a custom emoji record. `actor.setStatus` accepts `customEmoji` and `removeCustomEmoji`. The AppView keeps a status that has only an emoji, stores the custom emoji ref in the new `user_presence.status_custom_emoji` column, and rejects a uri that doesn't name an emoji record.
