---
"@colibri-social/admin": minor
"@colibri-social/appview-db": minor
---

Copy a libSQL database into Postgres.

- `colibri-admin db copy --from <libSQL url> --to <Postgres url> [--truncate]` applies the Postgres migrations, then copies every table in batches. JSON columns become `jsonb` and flags become booleans through the shared schema. It checks the row count of every table, and exits with 1 when the counts differ or it refuses to run.
- It refuses a libSQL database that isn't on the current migrations, and a Postgres database that already has rows unless `--truncate` is passed.
- `@colibri-social/appview-db` exports `appliedMigrations` and `knownMigrations`.
