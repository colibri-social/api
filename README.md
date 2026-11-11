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
| `packages/space`         | Client for `com.atproto.space` and its space policies: delegation tokens, DPoP-bound credentials, verified repo reads |
| `packages/space-sync`    | Keeps a local copy of a space current: writer set, operation log, LtHash reconciliation, CAR recovery                        |
| `packages/db`            | Drizzle schema and migrations for both libSQL and Postgres                                                                   |
| `packages/projections`   | Turns synced records into the typed read models the API serves                                                               |
| `packages/identity`      | Service auth, DID documents, handle resolution                                                                               |
| `packages/community`     | Provisioning, credential custody, roles and permissions, access checks, moderation                                           |
| `packages/notifications` | Notification indexing, Web Push and FCM                                                                                      |
| `packages/blobs`         | CID-verified blob proxy for permissioned blobs, with image variants                                                          |
| `packages/embeds`        | SSRF-guarded link previews and the GIF picker                                                                                |
| `packages/emoji`         | Custom emoji providers that parse and build each supported emoji lexicon's records                                           |
| `packages/voice`         | mediasoup voice SFU                                                                                                          |
| `apps/appview`           | The server                                                                                                                   |
| `apps/migrate`           | One-shot migration of repo-backed communities onto spaces                                                                    |
| `apps/admin`             | `colibri-admin`, the command line for a cluster of AppView nodes                                                             |

```sh
cp .env.example .env    # required, see Getting started
docker compose up --build
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

### Keeping a single AppView up to date

The `updater` profile adds a container that pulls `ghcr.io/colibri-social/api:stable` every six
hours and restarts the AppView when a new image arrived. The AppView drains for 15 seconds
before it stops.

```sh
docker compose --profile updater up -d
```

`IMAGE` picks another tag, `UPDATE_INTERVAL_SECONDS` another interval.

## Telemetry

Once a day, the main node sends an anonymous heartbeat to `COLIBRI_TELEMETRY_URL`. It holds a
random instance ID, the version, flavor and roles, the database and Node major versions, the OS,
whether voice is set up, and the number of nodes, Spaces, users seen in the last 30 days and voice
minutes in the last day, each rounded to `0`, `1-10`, `11-100`, `101-1k`, `1k-10k` or `10k+`. The
first start logs a notice, and the first heartbeat goes out an hour later. Set
`COLIBRI_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` to turn it off.

## Running a cluster

A cluster has one main node holding the Postgres primary and any number of sub, failover and
voice nodes. All nodes share a Tailscale tailnet. The main node provisions the others over SSH
with the Ansible playbooks in `deploy/ansible`, which ship inside the image.

### The main node

1. Join the server to your tailnet and note its tailnet name and address.
2. Put an SSH key for the other servers at `./data/ssh/id_ed25519`, or point `SSH_KEY_PATH` at it.
   Add its public half to every server you order.
3. Fill `.env` with the usual settings plus the cluster ones:

   ```sh
   NODE_ID=hel-1
   NODE_REGION=eu
   TAILNET_HOST=hel-1
   TAILNET_IP=100.64.0.1
   PUBLIC_HOST=api.example.com
   POSTGRES_PASSWORD=...
   POSTGRES_REPLICATION_PASSWORD=...
   TAILSCALE_AUTH_KEY=tskey-auth-...
   ```

4. Start it:

   ```sh
   docker compose -f docker-compose.scaled.yml up -d
   ```

5. Store the settings every node shares:

   ```sh
   docker compose -f docker-compose.scaled.yml exec -T appview colibri-admin config import - < .env
   ```

   Settings that describe one node stay out.

### Adding a node

```sh
colibri-admin node add eu-2 --region eu --roles api,live,voice \
  --public-url https://eu-2.nodes.example.com --ip 203.0.113.7
```

The main node installs Docker, Tailscale, a firewall, Caddy and the AppView on the server. Sub
and failover nodes also get a Postgres replica. The node joins with a one-time token and takes
the shared settings from the main node. `colibri-admin node list` shows it as `active` once it
heartbeats. Without `--ip`, `node add` prints the settings for setting the node up by hand.

### Taking a node out

```sh
colibri-admin node shutdown eu-2 --maintenance --grace 15m
colibri-admin node resume eu-2
colibri-admin node shutdown eu-2 --retire
colibri-admin node remove eu-2
```

A shutdown keeps the quorum floor unless you pass `--force`. A node in maintenance answers
every request with 503 until it is resumed. `node remove` deletes the stack and its volumes from
a retired node and forgets it. `node recover eu-2` restarts a node's stack.

### Updates

The main node checks the `NODE_IMAGE` tag (`ghcr.io/colibri-social/api:stable` by default) every
`UPDATE_POLL_MINUTES` (default 15, `0` turns it off). When nodes run an older version than the
image's `org.opencontainers.image.version` label, it updates them one at a time: sub nodes first,
then the failover node, then itself. Each node pulls the image pinned by digest, drains for up to
`DRAIN_GRACE_MINUTES` while the quorum floor holds, restarts and must report the new version
within 10 minutes. A failed step pauses rollouts until `colibri-admin rollout resume`. A node
that drained for an update and isn't restarted within 15 minutes restarts on its current image.

The main node updates itself over SSH too. Keep its stack in `STACK_DIR` (default `/opt/colibri`),
set `COMPOSE_FILE=docker-compose.scaled.yml` and `TAILNET_HOST` in its `.env`, and add the SSH
key's public half to the main server's own `authorized_keys`. Writes pause while the main node
restarts. Sub nodes hold them for `WRITE_QUEUE_SECONDS`.

### Cloudflare

With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` set, `node add --ip` creates an A record for
the node's public host (DNS only, named after the node in its comment) and `node remove` deletes
it. Records the main node didn't create are left alone, and `node add` refuses to replace one.

Add `CLOUDFLARE_ACCOUNT_ID` and the ID of an existing load balancer on the API host as
`CLOUDFLARE_LB_ID`, and the main node keeps it in step with the registry every minute:

- One pool per region, named `colibri-<region>`, holds the `api` nodes of that region. Active
  nodes are enabled, the others are disabled, and retired nodes are left out. Each origin sends
  the node's own host as `Host`. A pool without nodes is deleted.
- A shared monitor checks `GET /health` for a 200.
- The load balancer uses geo steering. `CLOUDFLARE_GEO_REGIONS` maps regions to Cloudflare
  region codes, for example `eu=WEU,EEU;us=ENAM,WNAM`. Every pool is a default pool, with the
  main node's region first and as the fallback.

The token needs DNS edit on the zone, and Load Balancing edit on the zone and the account. A
node whose public host is the API host is left out of the pools, so give the main node its own
`NODE_PUBLIC_URL`.

### Status page

Uptime Kuma runs next to any node's stack and serves the public status page. Set the status page
host and the account the main node should use, then deploy it:

```sh
colibri-admin config set KUMA_PUBLIC_URL https://status.example.com
colibri-admin config set KUMA_USERNAME colibri
colibri-admin config set KUMA_PASSWORD ...
colibri-admin status deploy fsn-1
colibri-admin config set KUMA_URL http://<fsn-1 tailnet address>:3001
```

`status deploy` starts Kuma (`KUMA_IMAGE`, default `louislam/uptime-kuma:2.5.7-slim`) with its
port on the tailnet address only, and adds the status host to the node's Caddy. With Cloudflare
set up, it also points the status host at the node with a CNAME. The public host serves the status
page and answers 404 for the dashboard, settings and socket paths. Open the dashboard at
`KUMA_URL` over the tailnet.

Once `KUMA_URL` is set, the main node keeps Kuma in step with the registry every minute:

- An HTTP monitor for the API host and one for each node that isn't retired, all on `/health`.
  Nodes in maintenance or draining are paused. Monitors of retired nodes are deleted. Monitors the
  main node didn't create are left alone.
- The `KUMA_STATUS_SLUG` status page (default `colibri`) lists the API first, then one group per
  region with its nodes, styled with `deploy/uptime-kuma/status.css`.

On a fresh Kuma, the main node creates the account from `KUMA_USERNAME` and `KUMA_PASSWORD`. Keep
2FA off for that account.

### Monitoring

Prometheus and Grafana run next to any node's stack, and Grafana Alloy on every node sends them
metrics. Set a Grafana password, optionally a webhook for alerts, then deploy:

```sh
colibri-admin config set GRAFANA_ADMIN_PASSWORD ...
colibri-admin config set ALERT_WEBHOOK_URL https://ntfy.example.com/colibri
colibri-admin monitoring deploy fsn-1
```

`monitoring deploy` starts Prometheus (`PROMETHEUS_IMAGE`) and Grafana (`GRAFANA_IMAGE`) on the
node's tailnet address, stores `PROMETHEUS_REMOTE_WRITE_URL`, then starts Alloy (`ALLOY_IMAGE`) on
every node. Nodes added later get Alloy during provisioning. Grafana is at
`http://<tailnet address>:3300`, user `admin`. Prometheus keeps 90 days.

Alloy collects:

- Host CPU, memory, disk and network, including traffic totals per node on the public
  interfaces.
- The AppView's metrics from `METRICS_PORT`.
- Postgres connections, database size, transactions, query time and replication lag, on nodes
  with a Postgres replica and on the main node.
- On the main node, probes of `PDS_URL` at `/xrpc/_health` and
  `/xrpc/com.atproto.server.describeServer`.
- Any `.prom` file in `/var/lib/colibri/metrics`. `deploy/observability/pgbackrest-age.sh` writes
  the time of the last pgBackRest backup there. Run it from cron on the Postgres primary after
  each backup.

Grafana has four dashboards (cluster, hosts with daily and 30-day ingress and egress, voice and
Postgres) and sends these alerts to
`ALERT_WEBHOOK_URL`:

| Alert | Fires when |
| --- | --- |
| Node missing | A node hasn't reported for 2 minutes |
| Replication lag | A replica is over 30 seconds behind for 2 minutes |
| Backup too old | The last backup finished over 26 hours ago |
| Disk almost full | A filesystem is over 85% full for 10 minutes |
| XRPC errors | Over 2% of a node's XRPC requests fail with a 5xx for 5 minutes |
| Read-only mode | A node refuses writes because it can't reach the main node |

On the main node, add `COMPOSE_FILE=docker-compose.scaled.yml` to `.env` so Alloy starts with the
`monitoring` profile.

### A local cluster

The `local-cluster` profile runs a replica, a sub node and a voice node next to the main node
on one machine.

```sh
docker compose -f docker-compose.scaled.yml up -d
docker compose -f docker-compose.scaled.yml exec appview colibri-admin node add sub-1 --region local --roles api,live
docker compose -f docker-compose.scaled.yml exec appview colibri-admin node add voice-1 --region local --roles voice
SUB_JOIN_TOKEN=... VOICE_JOIN_TOKEN=... docker compose -f docker-compose.scaled.yml --profile local-cluster up -d
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

## Lexicons

Every Colibri schema lives under `social.colibri.beta.*` while the spaces work is
unstable, so it cannot collide with the `social.colibri.*` schemas already
published from the pre-spaces AppView. The vendored `com.atproto.space`,
`memberspace`, `managedspace` and `personalspace` documents are upstream and are never republished from
here.

```sh
pnpm lexicons:codegen      # regenerate the TypeScript types from the JSON
pnpm lexicons:check-dns    # what DNS is missing before anything can be published
pnpm lexicons:publish      # publish to com.atproto.lexicon.schema records
```

### DNS

An NSID resolves through a `_lexicon` TXT record on its domain authority, which
is every segment but the last, reversed. So `social.colibri.beta.channel.text`
resolves through `_lexicon.channel.beta.colibri.social`. One record per
authority, thirteen in total. `pnpm lexicons:check-dns` prints the exact set,
and takes an optional DID to check that each record points where you expect:

```sh
pnpm lexicons:check-dns did:plc:mprdjqjluoswa7awzggaggj3
```

### Publishing

```sh
export LEXICON_PDS=https://colibri.social
export LEXICON_IDENTIFIER=colibri.social
export LEXICON_PASSWORD=<app password>

pnpm lexicons:publish --dry-run
pnpm lexicons:publish
```

### Renaming the namespace

Promoting out of beta, or moving again:

```sh
pnpm lexicons:renamespace social.colibri.beta social.colibri --dry-run
pnpm lexicons:renamespace social.colibri.beta social.colibri
pnpm lexicons:codegen
```

## Communities on other AppViews and other PDSes

A community record names its `managingApp`. That AppView holds the community's
credentials and answers `checkUserAccess` for every one of its spaces, so it is
the only one that can serve the community. A client that finds a community whose
`managingApp` is not the AppView it is talking to must talk to that AppView
instead, for reads, writes, events and voice alike. The field lives on the record
rather than being read from the space policies because
`com.atproto.space.getSpace` only serves them to the space owner. The profile space is
publicly readable, so the record can be read before joining.

`social.colibri.beta.community.create` provisions an account on this AppView's
PDS and needs `PDS_ADMIN_PASSWORD`.
`social.colibri.beta.community.authorizeHost` hosts a community on an account
that already exists. The owner signs in as that account on its own server, and
the AppView adopts it as a new community, keeping its DID, handle and PDS. The
same sign-in reconnects a community after its access lapsed or its account moved
to another server. The PDS has to implement the `com.atproto.space` policy methods, and the
AppView needs `HOST_OAUTH_PRIVATE_KEY`, an ES256 key it signs its client
assertions with. The client metadata lives at `/oauth/host/client-metadata.json`.
OAuth sessions and passwords are stored AES-256-GCM encrypted under
`CREDENTIAL_ENCRYPTION_KEY`.

`social.colibri.beta.community.adopt` does the same with the account's password.
It has to be the full password, because `com.atproto.space.getDelegationToken`
refuses app passwords.

`social.colibri.beta.community.handOverHost` lets an administrator move an account
this AppView hosts to another server, for example with PDS MOOver. It sets their
email on the account and returns a new password, which works for 60 minutes. If
the account still lives here after that, the AppView sets a new password nobody
sees.

## Releasing

Every push to `main` publishes `ghcr.io/colibri-social/api:edge`. A push that changes the
version of `@colibri-social/appview` also publishes that version and `stable`.

Three packages are published from here: `@colibri-social/lexicons`,
`@colibri-social/space` and `@colibri-social/space-sync`.

A change to any of them needs a changeset:

```sh
pnpm changeset
```

A change to `packages/lexicons` is a protocol change. Treat it as a minor bump
at least, because the client and the AppView both validate against it.
