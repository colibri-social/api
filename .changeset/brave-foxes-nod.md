---
"@colibri-social/lexicons": minor
"@colibri-social/community": minor
"@colibri-social/embeds": minor
"@colibri-social/appview-db": patch
"@colibri-social/projections": patch
"@colibri-social/appview": minor
---

Add the `message.react` channel permission. It controls adding and removing reactions apart from `message.send`, so members can react in channels where they can't post. Every member holds it by default, existing Spaces get it on their default role, and channel and category overrides can allow or deny it. Reacting in a voice channel's chat also needs `voice.chat`. A channel's legacy posting allow list applies to reactions too. Projection admission checks each collection in a change on its own.

Unfurl Klipy GIF page links through the Klipy items API. `embed.defs#gifView` gains optional `videoUrl` and `mimeType` fields for GIFs served as video, and saved GIF favorites keep both fields.
