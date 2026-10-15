---
"@colibri-social/lexicons": minor
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/projections": minor
"@colibri-social/notifications": minor
---

Adds per-user state that follows a user across devices:

- `social.colibri.beta.actor.clientPreferences` holds client settings such as gesture controls, theme, link options, the Bluesky client, developer mode, voice view options and experiments.
- `social.colibri.beta.actor.composerState` holds emoji usage, skin tone and recent GIFs.
- `social.colibri.beta.actor.spaceNotification` sets a notification level for one community, keyed by its DID. `social.colibri.beta.actor.putSpaceNotification` pushes it to the AppView.
- `notificationLevel` accepts `nothing`, which drops every notification, mentions included.
- `social.colibri.beta.actor.mute` accepts `#mutedThread` subjects.

`putSettings` takes `clientPreferences` and `composerState`, and `getPreferences`, `putSettings` and `preferencesEvent` return them together with `spaceNotifications`. Notification fan-out uses a community's level over the global one. The account permission set covers the new collections and procedure.
