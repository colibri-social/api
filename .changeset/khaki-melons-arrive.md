---
"@colibri-social/lexicons": minor
"@colibri-social/appview": minor
---

Hosts a polyfilled user's repo for a Space on the AppView that manages that Space:

- `polyfill.uploadBlob` and `polyfill.getBlob` take an optional `space` parameter. When another AppView manages that Space, the call goes there, so a blob sits next to the repo that references it. Without the parameter, both calls stay on this AppView.
- `polyfill.beginMigration` also starts the migration on every AppView that manages one of the caller's remote Spaces and returns their spaces with its own. An AppView that refuses or doesn't answer is skipped, and calling `beginMigration` again picks it back up.
