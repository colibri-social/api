---
"@colibri-social/space-sync": patch
"@colibri-social/appview": patch
---

Fix attachments, avatars and role images that failed to load after a repo was synced for the first time, such as messages in a new channel or thread. On startup, the AppView resyncs every repo stored with a broken blob reference.
