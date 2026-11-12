---
"@colibri-social/appview": patch
---

Show pgBackRest errors from `stanza-create` in `backup.sh`. The output went to `/dev/null`, so a failing backup stopped without a message and left `/var/log/colibri-backup.log` empty.
