---
"@colibri-social/appview": patch
---

Default `BACKUP_REPO_PATH` to `/home/colibri`. A Hetzner Storage Box keeps your files under `/home`, and with `/colibri` pgBackRest couldn't create the repository and crashed during `stanza-create`.
