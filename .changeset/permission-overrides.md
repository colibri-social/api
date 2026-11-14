---
"@colibri-social/appview": minor
"@colibri-social/lexicons": minor
"@colibri-social/community": minor
"@colibri-social/appview-db": minor
"@colibri-social/projections": minor
---

Adds per-category and per-channel permission overrides for roles and single members. Each override sets a channel permission to Allow or Deny, and anything it leaves out inherits.

The AppView resolves a permission in a channel in this order:

- The member's own override wins.
- Otherwise the highest role the member holds that sets the permission decides it. The default role ranks lowest.
- A channel that leaves the permission open falls back to its category, then to the member's role permissions.

Seeing and posting are now permissions: `channel.view`, `message.send` and `voice.connect`. Without `channel.view` a member has no other permission in that channel. Owners and holders of the owner role still get everything.

Permission changes reach connected clients right away. The event socket sends each affected viewer a `channelEvent` update carrying their new `channelView`, and the voice socket mutes, closes producers or disconnects members who lose `voice.speak`, a sharing permission, `voice.connect` or `channel.view`. A member moved into a hidden voice channel keeps their voice permissions there. Notifications now check `channel.view` and `voice.chat` for every recipient.

At startup the Members role gains `channel.view`, `message.send` and `voice.connect` once, and every category, channel and role record is rewritten from the old audience fields to overrides. Until a Space is rewritten, the AppView keeps honoring the old fields and grants the three new permissions to every member.

Lexicons:
- New `social.colibri.beta.defs#permissionOverride` with `role` or `member`, `allow` and `deny`.
- `permissionOverrides` on the `channel` and `category` records, the `channel.create`, `channel.update`, `category.create` and `category.update` inputs, and `channelView` and `categoryView`. Setting overrides needs `role.manage`, a permission you hold for every changed key, and a target role below your own.
- `ownerOnly`, `allowedRoles`, `allowedMembers`, `visibleToRoles` and `visibleToMembers` are gone from those inputs and views. On the records they are deprecated.
- `channelOverrides` is gone from `roleView` and `role.update`, and deprecated on the `role` record.
- New permissions `channel.view`, `message.send` and `voice.connect`, plus `CHANNEL_PERMISSIONS` and `normalizePermissionOverrides`.

`@colibri-social/community` adds `healPermissionOverrides`, `legacyToOverrides`, `isPrivateScope` and `BASELINE_PERMISSIONS`. `has` takes a `ChannelState` instead of a channel key. `@colibri-social/appview-db` adds a `permission_overrides` column to `channels` and `categories`.
