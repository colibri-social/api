# Colibri AppView

The AT Protocol AppView behind [colibri.social](https://colibri.social). It serves the XRPC API, the event socket and the voice SFU of Colibri, keeps a copy of every permissioned space it manages, and holds the credentials of the Spaces created on it. The image is published as `ghcr.io/colibri-social/api`.

## Packages

| Package                   | What it does                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/appview`            | The server                                                                                                             |
| `apps/admin`              | `colibri-admin`, the command line for the database and a cluster of AppView nodes                                      |
| `apps/bridge`             | `colibri-bridge`, the process that runs the hosted Colibri bridge                                                      |
| `apps/migrate`            | `colibri-migrate`, moves one legacy community onto spaces                                                              |
| `packages/lexicons`       | Every Colibri schema, the space type declarations, and the types generated from them                                   |
| `packages/space`          | Client for `com.atproto.space` and its space policies: delegation tokens, DPoP-bound credentials, verified repo reads |
| `packages/space-sync`     | Keeps a local copy of a space current: writer set, operation log, LtHash reconciliation, CAR recovery                  |
| `packages/db`             | Drizzle schema and migrations for both libSQL and Postgres                                                             |
| `packages/projections`    | Turns synced records into the typed read models the API serves                                                         |
| `packages/identity`       | Service auth, DID documents, handle resolution                                                                         |
| `packages/community`      | Provisioning, credential custody, roles and permissions, access checks, moderation                                     |
| `packages/notifications`  | Notification indexing, Web Push, FCM and APNs                                                                          |
| `packages/blobs`          | CID-verified blob proxy for permissioned blobs, with image variants                                                    |
| `packages/embeds`         | SSRF-guarded link previews and the GIF picker                                                                          |
| `packages/emoji`          | Custom emoji providers that parse and build each supported emoji lexicon's records                                     |
| `packages/voice`          | mediasoup voice SFU                                                                                                    |
| `packages/telemetry`      | The anonymous daily heartbeat                                                                                          |
| `packages/bridge-core`    | The Colibri half of a bridge                                                                                           |
| `packages/bridge-discord` | The connector of the hosted Colibri bridge                                                                             |

## Quick start

Requires Node.js `>=24.22.3` and pnpm `10.33.3`. Run `corepack enable` to get the pinned pnpm version.

```sh
git clone https://github.com/colibri-social/api.git
cd api
pnpm install
cp .env.example .env
pnpm dev
```

The AppView reads `.env` from the repository root and refuses to boot without `APPVIEW_DID`, `PUBLIC_URL`, `SIGNING_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `PDS_URL` and `COMMUNITY_HANDLE_DOMAIN`. `.env.example` carries the `openssl` commands that generate the two secrets.

To run the published image, fill in `.env` and run `docker compose up -d`.

## Documentation

The docs live at [colibri.social/docs](https://colibri.social/docs/developers).

- [AppView development](https://colibri.social/docs/developers/development/appview): configuration, source layout, compose files, commands, lexicons and releases.
- [Development overview](https://colibri.social/docs/developers/development/overview): run the AppView, a PDS and the client together.
- [Testing](https://colibri.social/docs/developers/development/testing): unit tests, the integration suite and continuous integration.
- [Self-hosting](https://colibri.social/docs/developers/self-hosting/getting-started): the published image, compose profiles, the move from libSQL to Postgres, telemetry and every environment variable.
- [Running a cluster](https://colibri.social/docs/developers/self-hosting/cluster): nodes, rolling updates, database failover, backups, monitoring and the status page.
- [Architecture](https://colibri.social/docs/developers/architecture/appview): the services, with pages on [sync](https://colibri.social/docs/developers/architecture/sync), [storage](https://colibri.social/docs/developers/architecture/storage), [moderation](https://colibri.social/docs/developers/architecture/moderation) and [hosting](https://colibri.social/docs/developers/architecture/hosting).
- [AppView specification](https://colibri.social/docs/developers/specification/appview): every XRPC method and event.
- [Contributing](https://colibri.social/docs/developers/contributing/overview): pull requests, checks and changesets.
