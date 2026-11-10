#!/bin/sh
set -eu

if [ ! -s "$PGDATA/PG_VERSION" ]; then
	mkdir -p "$PGDATA"
	chown postgres:postgres "$PGDATA"
	chmod 700 "$PGDATA"
	until PGPASSWORD="$REPLICATION_PASSWORD" pg_isready -h "$PRIMARY_HOST" -p 5432 -U replicator; do
		sleep 2
	done
	export PGPASSWORD="$REPLICATION_PASSWORD"

	if ! gosu postgres pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U replicator \
		-D "$PGDATA" -R -X stream -C -S "$REPLICATION_SLOT"; then
		find "$PGDATA" -mindepth 1 -delete
		gosu postgres pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U replicator \
			-D "$PGDATA" -R -X stream -S "$REPLICATION_SLOT"
	fi

	unset PGPASSWORD
fi

exec docker-entrypoint.sh postgres \
	-c hot_standby=on \
	-c max_connections="${MAX_CONNECTIONS:-300}" \
	-c max_wal_senders=16 \
	-c max_replication_slots=16
