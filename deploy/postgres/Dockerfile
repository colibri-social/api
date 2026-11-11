FROM postgres:18-alpine

RUN apk add --no-cache pgbackrest

ENV PGBACKREST_LOG_LEVEL_FILE=off \
    PGBACKREST_LOCK_PATH=/tmp/pgbackrest
