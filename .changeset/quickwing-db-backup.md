---
"@colibri-social/appview": minor
"@colibri-social/admin": minor
---

Add `colibri-admin db backup [full|diff|incr]`. The main node runs a pgBackRest backup of its own Postgres through Ansible, waits for it and prints the result, or the last lines of the output when it fails. The backup is a full one unless you choose another type. It refuses when Postgres on the main node isn't the primary, appends its output to `/var/log/colibri-backup.log` and refreshes the backup age metric afterwards.
