#!/bin/sh
set -eu

interval="${UPDATE_INTERVAL_SECONDS:-21600}"
service="${UPDATE_SERVICE:-appview}"

cd /stack

while true; do
	docker compose pull --quiet "$service"
	latest=$(docker compose config --images "$service" | head -n 1)
	running=$(docker inspect --format '{{.Image}}' "$(docker compose ps -q "$service")" 2>/dev/null || true)
	wanted=$(docker image inspect --format '{{.Id}}' "$latest" 2>/dev/null || true)

	if [ -n "$wanted" ] && [ "$running" != "$wanted" ]; then
		echo "updater: $service runs ${running:-nothing}, $latest is $wanted, restarting"
		docker compose up -d "$service"
	fi

	sleep "$interval"
done
