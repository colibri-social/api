#!/bin/sh
set -eu

cd "${STACK_DIR:-/opt/colibri}"

service="${POSTGRES_SERVICE:-postgres}"
user="${DB_USER:-colibri}"

run() {
	docker compose exec -T -u postgres "$service" "$@"
}

if [ "$(run psql -U "$user" -d postgres -Atc 'select pg_is_in_recovery()')" != "f" ]; then
	exit 0
fi

run pgbackrest stanza-create >/dev/null

type="${1:-}"

if [ -z "$type" ]; then
	type=incr
	[ "$(date -u +%u)" = "7" ] && type=full
fi

run pgbackrest backup --type="$type"
