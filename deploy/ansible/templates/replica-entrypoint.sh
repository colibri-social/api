#!/bin/sh
set -eu

conninfo() {
	hosts=$(printf '%s' "$PRIMARY_HOST" | tr -d ' ')
	ports=$(printf '%s' "$hosts" | awk -F, '{ for (i = 1; i <= NF; i++) printf "%s5432", (i > 1 ? "," : "") }')
	printf 'host=%s port=%s user=replicator target_session_attrs=read-write connect_timeout=5' "$hosts" "$ports"
}

if [ -n "${PRIMARY_HOST:-}" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
	mkdir -p "$PGDATA"
	chown postgres:postgres "$PGDATA"
	chmod 700 "$PGDATA"
	export PGPASSWORD="$REPLICATION_PASSWORD"
	source=$(conninfo)

	until psql -d "$source dbname=postgres" -Atc "select 1" >/dev/null 2>&1; do
		sleep 2
	done

	if ! gosu postgres pg_basebackup -d "$source" -D "$PGDATA" -R -X stream -C -S "$REPLICATION_SLOT"; then
		find "$PGDATA" -mindepth 1 -delete
		gosu postgres pg_basebackup -d "$source" -D "$PGDATA" -R -X stream -S "$REPLICATION_SLOT"
	fi

	unset PGPASSWORD
fi

backup_dir=/var/lib/postgresql/.pgbackrest
mkdir -p "$backup_dir" /var/lib/postgresql/.ssh
if [ -s /run/backup/key ]; then
	cp /run/backup/key "$backup_dir/key"
	chmod 600 "$backup_dir/key"
fi
if [ -s /run/backup/key.pub ]; then
	cp /run/backup/key.pub "$backup_dir/key.pub"
fi
chown -R postgres:postgres "$backup_dir" /var/lib/postgresql/.ssh
chmod 700 /var/lib/postgresql/.ssh

set --
if [ -n "${PGBACKREST_REPO1_SFTP_HOST:-}" ] && command -v pgbackrest >/dev/null 2>&1; then
	set -- -c archive_mode=on \
		-c "archive_command=pgbackrest --stanza=${PGBACKREST_STANZA:-colibri} archive-push %p" \
		-c archive_timeout="${ARCHIVE_TIMEOUT:-300}"
fi

exec docker-entrypoint.sh postgres "$@" \
	-c wal_level=replica \
	-c hot_standby=on \
	-c wal_keep_size="${WAL_KEEP_SIZE:-2GB}" \
	-c max_connections="${MAX_CONNECTIONS:-300}" \
	-c max_wal_senders=16 \
	-c max_replication_slots=16
