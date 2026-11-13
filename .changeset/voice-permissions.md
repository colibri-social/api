---
"@colibri-social/appview": minor
"@colibri-social/lexicons": minor
"@colibri-social/community": minor
"@colibri-social/voice": minor
---

Adds voice permissions that admins can set per role and per channel. Every member keeps them by default.

- `voice.speak`: members without it stay muted. Their screen share sound still plays.
- `voice.listen`: members without it can't hear the call. Cameras and screen shares still show.
- `voice.camera` and `voice.screenshare`: members without them can't turn on their camera or share their screen.
- `voice.chat`: members without it can't read or post in the voice channel's text chat.

When an admin changes these mid-call, the AppView applies them right away, stops any camera or screen share the member lost, and tells their client. A moderator unmute never lifts a mute that comes from a missing permission.

The Members role of every Space gains the five permissions once at startup. Removing them later sticks. Spaces whose credentials are missing keep their current Members role until the owner signs in again.

Lexicons:
- `social.colibri.beta.voice.defs#joined` lists the member's voice permissions in `permissions`.
- New `social.colibri.beta.voice.defs#permissionsChanged` frame with the updated list.
- `social.colibri.beta.voice.defs#moved` carries the destination's `channelView` in `view`, and in `after` the nearest channel before it in its category that the member can read.
- `serverMuted` and `serverDeafened` also cover a missing `voice.speak` or `voice.listen`.

`@colibri-social/community` adds `voiceCapabilities` and `voicePermissionKeys`. `@colibri-social/voice` adds `VoiceSfu.setRestriction`, `restrictionOf` and `moderationOf`.
