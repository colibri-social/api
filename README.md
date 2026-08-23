# Colibri AppView

The AT Protocol AppView behind [colibri.social](https://colibri.social).

> The spaces alpha is unstable and explicitly not for production. Also, if you're reading this, you're here early. Howdy.

The architecture, the sync algorithm, the storage model, the moderation model
and the full XRPC reference are documented at [https://colibri.social/docs](https://colibri.social/docs). This README covers
running and working on the code.

## Getting started

Requires Node 24 (`.node-version`) and pnpm.

```sh
pnpm install
cp .env.example .env   # then fill in the required values
pnpm dev
```

The AppView requires a few environment variables to boot: `APPVIEW_DID`, `PUBLIC_URL`, `SIGNING_KEY`,
`CREDENTIAL_ENCRYPTION_KEY`, `PDS_URL` and `COMMUNITY_HANDLE_DOMAIN`. `.env.example`
carries the `openssl` lines that generate the two secrets.

## Layout

| Package                  | What it does                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/lexicons`      | Every Colibri schema, the space type declarations, and the types generated from them                                         |
| `packages/space`         | Client for `com.atproto.space` and `com.atproto.simplespace`: delegation tokens, DPoP-bound credentials, verified repo reads |
| `packages/space-sync`    | Keeps a local copy of a space current: writer set, operation log, LtHash reconciliation, CAR recovery                        |
| `packages/db`            | Drizzle schema and migrations for both libSQL and Postgres                                                                   |
| `packages/projections`   | Turns synced records into the typed read models the API serves                                                               |
| `packages/identity`      | Service auth, DID documents, handle resolution                                                                               |
| `packages/community`     | Provisioning, credential custody, roles and permissions, access checks, moderation                                           |
| `packages/notifications` | Notification indexing, Web Push and FCM                                                                                      |
| `packages/blobs`         | CID-verified blob proxy for permissioned blobs, with image variants                                                          |
| `packages/embeds`        | SSRF-guarded link previews and the GIF picker                                                                                |
| `packages/voice`         | mediasoup voice SFU                                                                                                          |
| `apps/appview`           | The server                                                                                                                   |
| `apps/migrate`           | One-shot migration of repo-backed communities onto spaces                                                                    |

## Running it with Docker

```sh
cp .env.example .env    # required, see Getting started
docker compose up
```

That runs the AppView alone on libSQL against the `appview-data` volume, pointed
at whatever `PDS_URL` names. Three overlays compose on top of it:

| Overlay                          | What it adds                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `docker-compose.postgres.yml`    | Postgres, and rewrites `DATABASE_URL` to use it                                                |
| `docker-compose.pds.yml`         | a local spaces-alpha PDS and a private PLC directory, for developing without a PDS of your own |
| `docker-compose.integration.yml` | the same PDS and PLC, ephemeral, for `pnpm test:integration`                                   |

```sh
docker compose -f docker-compose.yml -f docker-compose.pds.yml up
```

## Commands

```sh
pnpm dev                # run from source, watching, no build step
pnpm build              # generate lexicon types and the pg schema, then compile
pnpm test               # unit tests
pnpm test:integration   # against a real spaces-alpha PDS, not run in normal CI
pnpm typecheck          # sources and tests
pnpm lint               # Biome
```

A change to a published package needs a changeset. See `.changeset/README.md`.
