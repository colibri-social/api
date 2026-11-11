---
"@colibri-social/appview": minor
---

Back up Postgres with pgBackRest.

- The main and failover nodes run `ghcr.io/colibri-social/postgres:18` (`POSTGRES_IMAGE`), the official Postgres 18 image with pgBackRest, published by the image workflow.
- With `BACKUP_REPO_HOST`, `BACKUP_REPO_USER` and `BACKUP_CIPHER_PASS` set, the primary archives its WAL to that SFTP repository (`BACKUP_REPO_PORT`, default 23, and `BACKUP_REPO_PATH`, default `/colibri`) at most `ARCHIVE_TIMEOUT` seconds (default 300) behind. Backups are encrypted with AES-256, compressed with zstd, and the last 4 full backups are kept.
- `deploy/postgres/backup.sh` runs only where Postgres is the primary, creates the stanza on first use, and takes a full backup on Sundays and an incremental one on other days. `node add` copies the key from `BACKUP_SSH_KEY_FILE` and the settings to the failover node and schedules its backups and the backup age check.
- `pgbackrest-age.sh` takes `PGBACKREST_CMD` to run pgBackRest inside the Postgres container.
