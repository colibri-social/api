---
"@colibri-social/appview": patch
"@colibri-social/appview-db": patch
"@colibri-social/identity": patch
---

Read a custom emoji the index hasn't seen yet straight from its owner's PDS and refresh an owner's emoji catalog once it's an hour old. Send the full message, attachments and reply included, with each notification. Answer `listMessages` without waiting for link previews, profiles, or handle checks, and send late link previews as message updates. Keep link previews in the new `link_previews` table so they survive restarts.
