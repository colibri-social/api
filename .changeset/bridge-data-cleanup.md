---
"@colibri-social/appview": patch
"@colibri-social/community": patch
"@colibri-social/lexicons": patch
"@colibri-social/bridge-core": patch
"@colibri-social/bridge-discord": patch
---

Adds `bridge.leave` and `bridge.replaceAvatar`, so a bridge revokes its registration when a Discord server removes it, purges its local data for revoked registrations, and swaps a changed avatar on the author's earlier bridged records
