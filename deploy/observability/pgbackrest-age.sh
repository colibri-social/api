#!/bin/sh
set -eu

stanza="${PGBACKREST_STANZA:-colibri}"
directory="${METRICS_TEXTFILE_DIR:-/var/lib/colibri/metrics}"
target="$directory/pgbackrest.prom"

mkdir -p "$directory"

stop=$(pgbackrest --stanza="$stanza" --output=json info | python3 -c '
import json, sys
backups = [b for s in json.load(sys.stdin) for b in s.get("backup", []) if not b.get("error")]
print(max((b["timestamp"]["stop"] for b in backups), default=0))
')

printf '# HELP colibri_backup_last_success_timestamp_seconds When the last pgBackRest backup finished\n# TYPE colibri_backup_last_success_timestamp_seconds gauge\ncolibri_backup_last_success_timestamp_seconds{stanza="%s"} %s\n' "$stanza" "$stop" > "$target.tmp"
mv "$target.tmp" "$target"
