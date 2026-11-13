---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/lexicons": minor
---

Moderators with `voice.moderate` in the destination can move a member into a voice channel that member can't see. The member joins the call there, without access to its text chat. Access ends when they leave, disconnect or join another channel, so they can't rejoin on their own. `social.colibri.beta.voice.moderate` no longer returns `DestinationForbidden`.

`@colibri-social/appview-db` adds the `voice_move_grants` table.
