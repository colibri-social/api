# @colibri-social/appview

## 2.37.2

### Patch Changes

- db4be72: Rearrange the Grafana cluster dashboard: the six overview tiles take two rows of wider panels, and the charts below move down to match.
- bbe2d7b: Fix `colibri_jetstream_lag_seconds`, which read Jetstream v2's sequence cursor as a timestamp and reported about 57 years. It now measures the time since the last event by the event's own `time`, or by when it arrived. Each node also reports `colibri_build_info` labelled with its AppView version, and the cluster dashboard shows a Versions table per node.
- f827675: Redeploy monitoring when it changes. Each time the main node takes the main role, it compares a hash of `deploy/observability`, the monitoring templates and playbooks, the Grafana password, `ALERT_WEBHOOK_URL` and the monitoring images with the last deploy, and runs `monitoring deploy` again for the Prometheus node when they differ. New dashboards, alert rules and webhook URLs reach Grafana after a release without running the command by hand.

## 2.37.1

### Patch Changes

- bd5b9ff: Use mediasoup's kernel6 prebuilt worker in the image. On build hosts with a 7.x kernel, mediasoup picked the kernel7 worker, which needs a newer glibc than the image has, and compiled the worker from source on every uncached build. The Dockerfile now downloads the worker for `MEDIASOUP_VERSION` and points `MEDIASOUP_WORKER_BIN` at it, and fails the build when the installed mediasoup version differs.
- 7447c85: Show where each node runs on the status page. Nodes have an optional location, set with `colibri-admin node add --location "Helsinki, Finland"` or `colibri-admin node location <id> [<text>]`, and listed by `node list`. Status page monitors use it as their name and fall back to the node ID. A changed location renames the monitor in place, so its uptime history stays. Region groups are titled by area (Europe, North America, South America, Asia, Oceania, Middle East, Africa) in that order, after the API. Adds a `location` column to `nodes` and `node_join_tokens`.
- f1f8ff4: `node add --ip` now says that the node shows up in `node list` only after bootstrap finishes, and points at the AppView logs to follow it.
- 7447c85: Add `colibri-admin rollout now [--grace 2m]`. It resumes paused rollouts and updates every node to the `stable` image at once, one at a time under the quorum rule. Each node drains for the given grace in place of `DRAIN_GRACE_MINUTES`, so clients and calls move to other nodes before it restarts, and the main node stops itself after the same grace. A node that quorum holds back is retried every 10 seconds for up to 10 minutes.
- 7447c85: Redesign the status page. `deploy/uptime-kuma/status.css` gives it Colibri's type, colors and layout in light and dark, with readable incident and maintenance cards in every style. The main node now sets the page title to "Colibri status", adds a description and footer links, uploads the Colibri logo when the page still has Kuma's, refreshes the page every 60 seconds and hides tags and certificate expiry.
- 206525d: Give `PUBLIC_HOST` and `API_HOST` their own Traefik routers, so each name gets its own certificate. With one router, a failed challenge for the API host behind the Cloudflare load balancer also left the node's own name without a certificate.
- Updated dependencies [7447c85]
  - @colibri-social/appview-db@0.23.1
  - @colibri-social/community@2.15.3
  - @colibri-social/notifications@1.10.1
  - @colibri-social/projections@1.15.3

## 2.37.0

### Minor Changes

- 0a73387: Add `colibri-admin` and share settings across AppView nodes.
  
  - `colibri-admin` ships in the AppView image. Run it inside the main node's container: `node list`, `node add <id> --region --roles [--public-url]`, `node shutdown <id> --maintenance|--retire [--grace 15m] [--force]`, `node resume <id>`, `node remove <id> [--force]`, `rollout pause|resume`, and `config list|set|unset|import`. It exits with 1 when the main node refuses and 2 on a usage error.
  - Shutdown and resume orders travel over the event bus to the main node, which answers within 30 seconds. They need the Postgres setup.
  - Shared settings live in `cluster_config`, encrypted with `CREDENTIAL_ENCRYPTION_KEY`. Settings that describe a single node, such as `NODE_ID`, `ROLES`, `DATABASE_READ_URL` or `SFU_ANNOUNCED_IP`, stay local and are refused. `config import` reads an env file and stores only the shared settings.
  - A node with `MAIN_NODE_URL` fetches the shared settings from the main node before it loads its configuration, along with its ID, region and roles from the registry. Its own environment wins. When `MAIN_NODE_URL` points at a node that is no longer main, it follows that node to the current one. It retries for two minutes, then exits.
  - The node secret file now holds the node ID next to the secret.
  - `@colibri-social/appview/cluster` exports the registry, config store, orders and event bus for the CLI.
- 19f118e: Back up Postgres with pgBackRest.
  
  - The main and failover nodes run `ghcr.io/colibri-social/postgres:18` (`POSTGRES_IMAGE`), the official Postgres 18 image with pgBackRest, published by the image workflow.
  - With `BACKUP_REPO_HOST`, `BACKUP_REPO_USER` and `BACKUP_CIPHER_PASS` set, the primary archives its WAL to that SFTP repository (`BACKUP_REPO_PORT`, default 23, and `BACKUP_REPO_PATH`, default `/colibri`) at most `ARCHIVE_TIMEOUT` seconds (default 300) behind. Backups are encrypted with AES-256, compressed with zstd, and the last 4 full backups are kept.
  - `deploy/postgres/backup.sh` runs only where Postgres is the primary, creates the stanza on first use, and takes a full backup on Sundays and an incremental one on other days. `node add` copies the key from `BACKUP_SSH_KEY_FILE` and the settings to the failover node and schedules its backups and the backup age check.
  - `pgbackrest-age.sh` takes `PGBACKREST_CMD` to run pgBackRest inside the Postgres container.
- 75c544f: Share live events, authorization changes and presence across AppView nodes.
  
  - Every announcement goes through an event bus. On SQLite it stays in memory. On Postgres it uses `LISTEN/NOTIFY` on the primary, in publish order, and payloads over the notify limit travel through `event_payloads`, which the main node clears after 10 minutes.
  - Per-viewer frames travel as recipes. A message carries its rendered view and each node signs it for its own viewers. A thread event names the thread, and each node renders it with the viewer's permissions after its replica has caught up to the publisher's WAL position (up to 2 seconds).
  - `Announcer` drops `toCommunityViewers` and closure frames for `message`, `thread` and `toTopics`. `toBridges` takes a frame.
  - Authorization changes reach every node, so a socket on any node loses a channel it may no longer read.
  - Presence counts sockets on every node. A user stays online while any node holds a fresh socket for them, and the main node sets users offline once no node has one.
  - Each process claims a unique notification clock ID through a Postgres advisory lock, so two writers never mint the same notification ID. `@colibri-social/notifications` exports `setClockId` and `CLOCK_IDS`.
  - `Database.waitForReplay()` waits for a read replica to reach a WAL position. `TestDatabase` exposes its `url`.
- 1205701: Fail the Postgres primary over to the failover node automatically and fence the old one.
  
  - `DATABASE_URL` can list several hosts. `@colibri-social/appview-db` connects to the one that accepts writes and has the highest epoch in `cluster_state`, rechecks every 10 seconds, and moves on read-only and connection errors. Advisory locks and the event bus follow it. It exports `FollowingPool`, `parsePostgresUrl`, `formatPostgresUrl`, `hostUrls`, `probeHost`, `pickPrimary` and `resolvePrimaryUrl`.
  - Every clustered node serves `GET /cluster/alive` on `CLUSTER_PORT` with the time it lost the primary. The failover node promotes its local Postgres (`LOCAL_POSTGRES_URL`, or `DATABASE_READ_URL`) once the primary has been unreachable for `FAILOVER_AFTER_SECONDS` (default 60) for it and for more than half of the nodes without the `main` or `failover` role. Promotion raises the epoch and creates replication slots for the other nodes. Without a witness node it doesn't promote on its own.
  - A writable Postgres with a lower epoch than the primary is fenced: it turns read-only and drops its client and replication connections. Nodes with the SSH key rebuild their own fenced Postgres with `rejoin-replica`, and the main node rebuilds other main and failover nodes.
  - `colibri-admin db failback [<node>]` moves the primary back to a node with the `main` role in a planned switchover. `colibri-admin db promote` promotes a failover node's Postgres by hand.
  - Replicas take a list of primary hosts in `PRIMARY_HOST` and stream with `target_session_attrs=read-write`. The main node's Postgres in `docker-compose.scaled.yml` uses the same entrypoint, so it can be rebuilt as a replica. Its AppView takes `DATABASE_URL` from `.env` when set.
  - Provisioning a failover node runs the new `database-hosts` playbook on every node. `rejoin-replica` takes `primary_hosts` and runs detached on the node that starts it.
- 6605f3d: Serve image attachments as smaller previews and keep rendered previews on disk.
  
  - Image attachments get a `previewUrl` with the new `timeline` variant: at most 1280 px on the long edge, WebP for still images, and animated WebP or GIF for animated ones. It's signed for the viewer like `url` and served after the same authorization check. Other files get no preview.
  - Rendered variants are kept on disk in `BLOB_DISK_CACHE_DIR` (default `./data/blob-cache`, `/data/blob-cache` in the compose stacks) up to `BLOB_DISK_CACHE_MAX_BYTES` (default 10 GB, `0` turns it off), with the least recently used ones removed first. They survive restarts. The in-memory cache stays in front, and originals still stream from the PDS.
  - Concurrent requests for the same variant share one render, and at most `BLOB_RENDER_CONCURRENCY` renders run at once (default half the CPU cores).
  - `@colibri-social/blobs` adds `DiskVariantCache`, the `timeline` variant, and the `disk` and `renderConcurrency` options on `BlobService`.
  - The main node in `docker-compose.scaled.yml` keeps its node secret in the data volume.
- cd8f0e9: Hand the main role to the failover node during updates and outages.
  
  - Nodes with the `main` role always try for the main lock on the Postgres primary. Nodes with the `failover` role stay back while a `main` node answers the new `GET /cluster/alive` on `CLUSTER_PORT` and isn't draining. They take the lock when no `main` node answers or all of them drain, when the main node hands the role over with the new `takeMain` control frame, or when a live `main` node hasn't claimed the role for 30 seconds.
  - A failover node holding the main role hands it back once a node with the `main` role has been active on the same version for 2 minutes.
  - The rollout no longer restarts the main node in place when a failover node already runs the new version. The main node pulls the image, hands the main role to that node, waits up to 60 seconds for it to take over, then restarts. Sub nodes hold writes for the seconds of the handover. If nobody takes over, the main node keeps the role and the rollout pauses.
  - A node with the `main` role issues its own node secret on its first start, so it forwards writes and keeps a control link like any other node while another node is main. A node only forwards writes while it isn't main.
  - Main and failover nodes run Ansible, Cloudflare and Uptime Kuma syncs only while they hold the main role, and only when `SSH_KEY_FILE` exists for Ansible.
  - A draining node stops trying for the main lock.
- da22296: The main node reads the shared settings too. A clustered node without `MAIN_NODE_URL` reads `cluster_config` from its own database at boot with `CREDENTIAL_ENCRYPTION_KEY`, so settings stored with `colibri-admin config set` reach it without being copied into its `.env`. Its own environment still wins, and it starts with only its own settings when the store can't be read.
- e917950: Deploy Prometheus, Grafana and Grafana Alloy across the cluster.
  
  - `colibri-admin monitoring deploy <node>` runs the new `monitoring` playbook. It starts Prometheus (`PROMETHEUS_IMAGE`, default `prom/prometheus:v3.15.1`, 90 days of data, remote write enabled) and Grafana (`GRAFANA_IMAGE`, default `grafana/grafana:13.2.5`, password from `GRAFANA_ADMIN_PASSWORD`) on the node's tailnet address. It then stores `PROMETHEUS_REMOTE_WRITE_URL` and runs the new `alloy` playbook on every node. Provisioning a node runs `alloy` too once monitoring exists.
  - Alloy (`ALLOY_IMAGE`, default `grafana/alloy:v1.21.2`) runs in the `monitoring` compose profile. It sends host metrics, the AppView's metrics, Postgres metrics where a database runs, and on the main node probes of the PDS, labeled with the node and region. It also reads `.prom` files from `/var/lib/colibri/metrics`, where `deploy/observability/pgbackrest-age.sh` writes the last backup time.
  - Grafana gets four dashboards (cluster, hosts, voice, Postgres). The hosts dashboard shows ingress and egress on public interfaces per node: totals for the selected range and the last 30 days, and daily bars. The cluster dashboard shows total ingress and egress. Alerts fire for a missing node, replication lag over 30 seconds, a backup older than 26 hours, a disk over 85% full, XRPC 5xx over 2% and read-only mode. With `ALERT_WEBHOOK_URL`, alerts go to that webhook.
  - The AppView listens for metrics on `0.0.0.0` inside the node and main compose stacks. Node `.env` files carry `NODE_REGION`, and the database URLs in them escape the user and password.
- ac153a2: Report metrics, traces and logs, and send an anonymous daily heartbeat.
  
  - The AppView serves Prometheus metrics on `METRICS_HOST:METRICS_PORT` (default `127.0.0.1:9464`, `0` turns them off), labeled with the node and region: XRPC duration by method and status, client sockets, Jetstream lag and events, the space sync queue, lag and failures, push deliveries by provider and outcome, drain state, write mode and queued writes, calls and participants, SFU worker CPU, bitrate, packet loss and transports by ICE state, and TURN credential requests.
  - Sentry traces every request except `/health` and keeps those over 1 second, those that failed, and `SENTRY_TRACES_SAMPLE_RATE` (default 0.1) of the rest. Voice joins, transport setup, space repo syncs and push sends get their own spans. Logs at info and above go to Sentry Logs. Clustered nodes tag events with their ID, region and roles.
  - The main node sends an anonymous heartbeat once a day to `COLIBRI_TELEMETRY_URL` (default `https://telemetry.colibri.social/v1/heartbeat`), an hour after the first start logs a notice. Counts are rounded into ranges. `COLIBRI_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` turns it off.
  - `@colibri-social/telemetry` builds, buckets and sends the heartbeat.
  - `VoiceSfu.stats()` reports calls, participants, transport stats and worker CPU. `WorkerPool.usage()` reads worker CPU time.
  - `SpaceSyncEngine.queueStats` reports pending and running repo syncs.
- 2d63cc4: Provision cluster nodes with Ansible and publish the AppView image.
  
  - Every push to `main` publishes `ghcr.io/colibri-social/api:edge` and `sha-<commit>`. A push that changes the `@colibri-social/appview` version also publishes the version tag and `stable`.
  - The image carries `ansible-core`, `openssh-client`, the playbooks in `deploy/ansible` and `colibri-admin` on the `PATH`.
  - `colibri-admin node add <id> --region --roles --public-url --ip [--workers]` has the main node bootstrap the server over SSH: Docker, Tailscale, a firewall, Caddy with Let's Encrypt, the AppView and, for sub and failover nodes, a streaming Postgres replica. The node joins with a one-time token. Without `--ip`, `node add` prints the settings for a manual setup.
  - `colibri-admin node recover <id>` restarts a node's stack. `node remove <id>` runs the remove playbook over the tailnet, then forgets the node.
  - The main node needs `TAILSCALE_AUTH_KEY`, `POSTGRES_REPLICATION_PASSWORD` and an SSH key at `SSH_KEY_FILE` to provision. `NODE_IMAGE`, `SSH_USER`, `ANSIBLE_DIR`, `REGISTRY_USER` and `REGISTRY_TOKEN` are optional. Ansible runs one playbook at a time and logs every line.
  - `docker-compose.scaled.yml` runs a main node: the Postgres primary with replication, the AppView with the main role and Caddy. Its `local-cluster` profile adds a replica, a sub node and a voice node for testing on one machine.
  - `docker-compose.yml` pulls `ghcr.io/colibri-social/api:stable` and gains an opt-in `updater` profile that keeps a single AppView on the newest stable image.
  - `colibri-admin config import -` reads the env file from standard input.
- 573ec8e: Register AppView nodes and link them to the main node.
  
  - An AppView with `NODE_ID` set is a cluster node. It registers itself in `nodes` with its region, roles, `NODE_PUBLIC_URL` and `NODE_TAILNET_URL`, heartbeats every 15 seconds with its connection and call counts, and is marked `draining` and then `down` when it stops.
  - Nodes with the `main` or `failover` role listen on `CLUSTER_PORT` (default 3100) for joins and control links. Only the node holding the main lock accepts them.
  - A new node trades a `CLUSTER_JOIN_TOKEN` (valid for an hour, used once) for a node secret, kept in `NODE_SECRET_FILE`. Nodes without the `main` role hold a WebSocket control link to the main node with that secret and reconnect when it drops.
  - The main node handles shutdown and resume orders from the event bus. A shutdown checks the quorum floor (50% of 2, 66% of 3, 75% of 4, 80% of 5 or more nodes staying up) unless forced, then tells the node to drain. A drained node parks in `maintenance` or `retired`, answers every request with 503 and stays parked across restarts until it is resumed.
  - `social.colibri.beta.server.listNodes` lists active nodes that serve clients, with a `/health` probe URL. `describeServer` advertises the `nodes` feature on a clustered AppView.
  - `nodes` gains `secret_hash`.
- 070ae7a: Run AppView nodes by role and shut them down gracefully.
  
  - `ROLES` decides what a node runs. `api` serves XRPC, blobs and embeds. `live` accepts event sockets. `voice` starts the SFU and voice signaling. `main` runs ingest, sweeps, heals and migration jobs, but only on the one node holding the main Postgres advisory lock. Another `main` node waits and takes over when the holder goes away.
  - Migrations run only on `main` nodes, one at a time behind their own advisory lock.
  - `DATABASE_READ_URL` sends reads to a Postgres replica. Writes and transactions stay on `DATABASE_URL`.
  - On SIGTERM or SIGINT a node drains: `/health` answers 503 with the deadline, every event socket gets a `drainNotice`, and the node waits until its connections are gone or the deadline passes. The deadline is `DRAIN_GRACE_MINUTES` (default 120) when other active nodes can take the clients, and 15 seconds when the node is alone. A second signal skips the wait.
  - A node that loses the main lock shuts down with exit code 1, so its supervisor restarts it.
  - `@colibri-social/appview-db` exports `holdLock`, `postgresAdvisoryLock` and `grantedLock`, and `Database.advisoryLock()`.
  - The single-node `docker-compose.yml` gives the container 45 seconds to stop.
- 35b87d0: Roll out new images across the cluster and keep Cloudflare in step with the registry.
  
  - The main node checks `NODE_IMAGE` every `UPDATE_POLL_MINUTES` (default 15, `0` turns it off) and reads the version from the image's `org.opencontainers.image.version` label. Nodes on an older version update one at a time: sub nodes, then the failover node, then the main node. Each pulls the image pinned by digest, drains while the quorum floor holds, restarts and must report the new version within 10 minutes. A failed step pauses rollouts. The main node restarts itself in place from `STACK_DIR` (default `/opt/colibri`).
  - Drain orders take a new `update` mode. A node drained for an update answers 503 until it restarts, and restarts on its current image after 15 minutes without one.
  - With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID`, provisioning a node creates a DNS-only A record for its public host and removing it deletes the record. Records the main node didn't create are left alone.
  - With `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_LB_ID`, the main node keeps one pool per region of `api` nodes, a `/health` monitor and geo steering on that load balancer every minute. `CLOUDFLARE_GEO_REGIONS` maps regions to Cloudflare region codes.
  - The `update` playbook takes `pull_only` and `stack_dir`.
- 6246850: Post incidents and schedule maintenance on the status page from `colibri-admin`.
  
  - `colibri-admin status` opens a menu built on `@clack/prompts` to browse nodes, open incidents, post updates, resolve them, and schedule or end maintenance.
  - `status incident list [--all]`, `create <title> [--message] [--style]`, `update <id> <message> [--title] [--style]` and `resolve <id> [<message>]` work on the `KUMA_STATUS_SLUG` page. Each update goes on top of the incident's text with its UTC time.
  - `status maintenance list`, `schedule <title> --start --end [--nodes] [--message]` and `end <id>` manage one-off maintenance windows. They show on the status page and mark the named nodes' monitors. Times take `now`, `+30m`, `+2h`, `+1d` or an ISO date.
  - The Uptime Kuma client in `@colibri-social/appview/cluster` reads, posts, edits and resolves incidents and adds, lists and ends maintenance.
- 418b56f: Run the status page on Uptime Kuma and keep its monitors in step with the cluster.
  
  - `colibri-admin status deploy <node>` runs the new `uptime-kuma` playbook on a node. It starts Uptime Kuma (`KUMA_IMAGE`, default `louislam/uptime-kuma:2.5.7-slim`) on the node's tailnet address and serves `KUMA_PUBLIC_URL` through the node's Caddy, with the dashboard, settings and socket paths answering 404. With Cloudflare set up, the status host gets a CNAME to the node.
  - With `KUMA_URL`, `KUMA_USERNAME` and `KUMA_PASSWORD`, the main node keeps an HTTP monitor on `/health` for the API host and every node that isn't retired. Nodes in maintenance or draining are paused, monitors of retired nodes are deleted, and other monitors are left alone. On a fresh Kuma it creates the account first.
  - The `KUMA_STATUS_SLUG` status page (default `colibri`) lists the API, then one group per region, styled with `deploy/uptime-kuma/status.css`.
  - Caddy on every node, and on the main node in `docker-compose.scaled.yml`, imports extra sites from `caddy-sites/`. The scaled stack's Caddy reads `deploy/caddy/Caddyfile`.
- 19f118e: Move the primary on purpose with `colibri-admin db switchover <node>`.
  
  - `db switchover <node>` moves the Postgres primary and the main role to a node with the `main` or `failover` role, for example before maintenance on the main node's host. It uses the same steps as `db failback`, which now refuses a target without either role.
  - A failover node keeps the main role while its own Postgres is the primary, so it no longer hands the role back to a `main` node that would write across the tailnet.
- 43899d5: Run voice calls across AppView nodes.
  
  - Each SFU worker listens on one UDP and TCP port through a mediasoup `WebRtcServer`, starting at `SFU_RTC_PORT` (default 40000). `SFU_RTC_MIN_PORT` and `SFU_RTC_MAX_PORT` are removed. The compose file publishes 40000-40031.
  - The SFU reads its settings from the AppView config. `SFU_INITIAL_OUTGOING_BITRATE` is part of it now, and `voiceSfuConfigFromEnv` is removed from `@colibri-social/voice`.
  - A call runs on one node. `voice_calls` pins it there, and a join on another node answers with `callElsewhere`. A call on a node that stopped reporting moves to the next node someone joins on.
  - Who is in a call lives in the new `voice_participants` table, so presence shows voice state from every node and `voice.moderate` reaches a call on any node over the event bus. The main node clears participants of nodes that stopped reporting and announces that they left.
  - Server mutes and deafens are stored per Space member in the new `voice_moderation` table. They apply in every voice channel of the Space and last across calls, restarts and nodes until a moderator lifts them.
  - A call that grows past `SFU_PARTICIPANTS_PER_WORKER` (default 20) participants per worker takes another worker, up to `SFU_WORKER_COUNT`. Its routers pipe every producer to each other, so everyone still hears everyone. New calls start on the worker with the fewest routers.
  - With `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` set, every transport gets Cloudflare TURN credentials valid for 24 hours, next to `SFU_ICE_SERVERS`.
  - When a voice node drains, every call gets a `migrationProposal` with the other voice nodes. Participants answer with `rttReport`, and after `VOICE_MIGRATION_NOTICE_SECONDS` (default 60) or a `moveNow` the call moves with `migrateTo` to the node with the lowest worst-case round trip. A node that shuts down tells remaining callers `nodeClosed`. `joined` carries the node ID and region.
  - `Database` exposes `primary` for reads that can't wait for a replica.
- 885c51d: Send writes from sub nodes to the main node.
  
  - A node with the `api` role that doesn't hold the main role forwards every XRPC procedure to the main node over the tailnet, with the caller's headers and body and its own node ID and secret. The main node accepts forwarded writes on `CLUSTER_PORT` from known nodes only and answers them as if they came in directly. A forwarded write the main node may already have applied is never sent twice: a failure after sending answers `502 UpstreamFailure`.
  - When the main node can't be reached, writes wait and go out in arrival order once it is back. After `WRITE_QUEUE_SECONDS` (default 90) a waiting write fails with `503 ReadOnly`, and the node refuses writes the same way until a ping to the main node succeeds again. A node that is no longer main sends the caller on to the current one.
  - Event sockets get a `writeState` frame on connect and on every change between `normal`, `queued` and `readOnly`.
  - The main node answers `GET /cluster/ping` on `CLUSTER_PORT` while it holds the main role.

### Patch Changes

- 149e2ca: Steer callers to new regions without `CLOUDFLARE_GEO_REGIONS`. Common region IDs such as `eu`, `us-east`, `us-central`, `us-west`, `asia` and `au` map to Cloudflare regions on their own, and each Cloudflare region gets its pools closest first. `CLOUDFLARE_GEO_REGIONS` now overrides single regions, and a region without a mapping logs `cloudflare.regionUnmapped`.
- 19f118e: Run the main node behind an existing Traefik. Caddy in `docker-compose.scaled.yml` now starts only with the `caddy` profile. `deploy/traefik/compose.traefik.yml` joins the AppView to Traefik's network (`TRAEFIK_NETWORK`, default `dokploy-network`) and routes `PUBLIC_HOST` and `API_HOST` to it with `TRAEFIK_CERT_RESOLVER` (default `letsencrypt`) on `TRAEFIK_ENTRYPOINT` (default `websecure`). The `uptime-kuma` playbook only reloads Caddy where it runs.
- Updated dependencies [aadf535]
- Updated dependencies [75c544f]
- Updated dependencies [1205701]
- Updated dependencies [6605f3d]
- Updated dependencies [ac153a2]
- Updated dependencies [573ec8e]
- Updated dependencies [070ae7a]
- Updated dependencies [43899d5]
  - @colibri-social/appview-db@0.23.0
  - @colibri-social/notifications@1.10.0
  - @colibri-social/blobs@0.3.0
  - @colibri-social/voice@0.5.0
  - @colibri-social/space-sync@0.8.0
  - @colibri-social/telemetry@0.2.0
  - @colibri-social/community@2.15.2
  - @colibri-social/projections@1.15.2

## 2.36.0

### Minor Changes

- aea9292: Add the foundation for running the AppView as a network of nodes.
  
  Lexicons:
  - `social.colibri.beta.server.listNodes` lists the nodes that accept clients, each with a region, roles, an endpoint and a probe URL.
  - `describeServer` can report the `nodes` feature.
  - The sync socket gains a `drainNotice` frame, a `writeState` frame and a `ReadOnly` error.
  - Voice signaling gains `migrationProposal`, `rttReport`, `migrateTo`, `moveNow` and `callElsewhere`. `joined` carries the node ID and region, and `disconnected` adds the `nodeClosed` and `migrated` reasons.
  - `attachmentView` has an optional `previewUrl` for a smaller inline image.
  - `listMessages` can name `unavailableAuthors` when a page is missing messages from an unreachable PDS.
  
  Database:
  - New tables for the node registry, join tokens, cluster config and state, voice call placement, oversized event payloads and telemetry state.
  - New columns: `presence_connections.node_id`, `space_repos.host` and `messages.rehydrated_at`.
  - `Database.ping()` checks the connection on SQLite and Postgres.
  - `openTestDatabase` creates a throwaway Postgres database when `TEST_DATABASE_URL` is set.
  
  AppView:
  - `/health` works on Postgres.
  - New settings: `ROLES`, `NODE_ID`, `NODE_REGION`, `MAIN_NODE_URL`, `DATABASE_READ_URL`, `DRAIN_GRACE_MINUTES`, `WRITE_QUEUE_SECONDS`, `MESSAGE_RETENTION_DAYS`, `SFU_RTC_PORT`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`, `BLOB_DISK_CACHE_DIR`, `BLOB_DISK_CACHE_MAX_BYTES`, `COLIBRI_TELEMETRY_DISABLED` and `DO_NOT_TRACK`. Nothing reads them yet.

### Patch Changes

- 19be678: Update Spaces support to the November 5 alpha (`0.0.0-spaces-alpha-20261105160032`). STAR archives from `getRepo` use the new control-byte framing through the `@atproto/space` helpers, so the AppView needs a PDS on the same alpha. `@atproto/star` is pinned to the alpha build, because its caret range otherwise resolves to a broken `0.0.0-stage` release. The vendored atproto space lexicons move to `704b9e2a`, which adds `RepoTakendown` and `RepoDeactivated` to `getSpaceCredential` and `listRepos`. A suspended space keeps its synced data and retries, as before.
- Updated dependencies [aea9292]
- Updated dependencies [19be678]
  - @colibri-social/lexicons@2.37.0
  - @colibri-social/appview-db@0.22.0
  - @colibri-social/space@0.11.1
  - @colibri-social/space-sync@0.7.1
  - @colibri-social/community@2.15.1
  - @colibri-social/identity@0.3.2
  - @colibri-social/blobs@0.2.5
  - @colibri-social/notifications@1.9.1
  - @colibri-social/projections@1.15.1

## 2.35.0

### Minor Changes

- d52006b: Add private user blocks. The `social.colibri.beta.actor.block` record lives in the personal preferences space, one record per blocked DID, and `social.colibri.beta.actor.putBlocks` pushes the whole list to the AppView. `defs#preferences` gains `blocks`, so `getPreferences` and the live preferences event carry it. A blocked author's messages produce no notification or push for the blocker, a ping from them no longer brings the blocker back into a thread they left, and their existing notifications leave the blocker's inbox, unread count and badge. The new `blocks` table is added by migration 0033 and is purged on account deletion.
- 9d42e5c: Add the `setConsumerPreference` voice frame. A viewer sets the highest simulcast or SVC layer it wants for one of its consumers and can pause it while its tile is off screen. A viewer pause survives `resumeConsumer` and undeafen, and deafen still keeps audio paused. Screen share video gets twice the priority of cameras when bandwidth is short, and send transports cap incoming media at 20 Mbps.
- e3aa164: Hold back push notifications while the recipient is active on another device. Clients send the new `activity` sync frame while they are visible and focused, and each one keeps the account active for 5 minutes. Notification rows still land, so unread and mention badges keep counting. A message in a channel that any of the account's devices has open skips both the row and the push.
  
  Track the channel in view and the activity per connection in the new `presence_connections` table, so one device no longer overwrites another's view. Connections refresh their row every 30 seconds, and rows older than 2 minutes are ignored and swept at startup, which clears views left behind by a restart. The `viewing_channel` column on `user_presence` is dropped.
  
  Voice channel messages and edits no longer push to anyone, since the only people they reached were the call's participants. The notification rows stay.
- e3aa164: Address reactions and replies by full record URI. `social.colibri.beta.reaction` gains an optional `uri` and `social.colibri.beta.message` an optional `parentUri`, next to the existing `target` and `parent` references. The projections read the URI first and fall back to the reference when the URI is missing, unparseable, in another space, or in another collection. `bridge.addReaction` takes an optional `uri`, and `bridge.postMessage` and `bridge.importMessages` take an optional `parentUri`. Records the community writes for a bridge carry both forms.
  
  `reactionEvent` gains `uri` for the target message and `reaction` for the reaction record itself, and its `target` now follows the URI when the record has one. Deleting a reaction record now publishes a `reactionEvent` with `event: "delete"`. A `messageEvent` delete carries `subjectUri`. `RecordDelete` in `@colibri-social/space-sync` carries the removed record's `previous` value when the store held it. `@colibri-social/space` adds `sameSpaceRecordPointer`, `tryParseSpaceRecordUri` and `trySpaceRecordUri`.

### Patch Changes

- 9d42e5c: Keep screen share sound playing when the person sharing mutes their own microphone. A self-mute now pauses only the microphone producer. A server mute still pauses every audio producer, whatever source it claims.
- Updated dependencies [d52006b]
- Updated dependencies [9d42e5c]
- Updated dependencies [e3aa164]
- Updated dependencies [e3aa164]
- Updated dependencies [9d42e5c]
  - @colibri-social/lexicons@2.36.0
  - @colibri-social/appview-db@0.21.0
  - @colibri-social/projections@1.15.0
  - @colibri-social/notifications@1.9.0
  - @colibri-social/voice@0.4.0
  - @colibri-social/space@0.11.0
  - @colibri-social/space-sync@0.7.0
  - @colibri-social/community@2.15.0
  - @colibri-social/blobs@0.2.4

## 2.34.0

### Minor Changes

- 7480051: Add the `setSpeaking` voice frame. A client that sends it decides its own speaking state, and the server stops using the audio level for that member. Clients that never send it keep the level-based state. Muting, by the member or a moderator, always clears the speaking state. Every speaking change now also goes out as a `voiceEvent` with `event: "speaking"` on the community's live feed.
- a6eb9be: Add the `codecUnsupported` voice frame. When a viewer can't decode the video codec of a screen share, the SFU answers the viewer's `consume` with a `NotFound` error and sends `codecUnsupported` with the `producerId` to the sharer's session, at most once per producer. The sharer can then produce the screen share again with a more widely supported codec. Microphone and camera consumption are unchanged.
- b3f77f4: Update Spaces support to the October 29 alpha (`0.0.0-spaces-alpha-20261029171913`). The vendored atproto lexicons move to `5d88b414` and replace `com.atproto.simplespace` with the `com.atproto.space` lifecycle methods and the `memberspace`, `managedspace` and `personalspace` policies. `PdsClient.createSpace` and `updateSpace` take a single `policy`, built with `memberspacePolicy` or `managedspacePolicy`. Community profile spaces are created as a member space with `publicRead`, and every other community space as a managed space. The AppView serves `com.atproto.managedspace.checkUserAccess`, treats `SpaceNotFound` from `getSpaceCredential` as a refusal, and on startup moves existing profile spaces to the public member space policy.

### Patch Changes

- Updated dependencies [7480051]
- Updated dependencies [a6eb9be]
- Updated dependencies [e2936c1]
- Updated dependencies [b3f77f4]
  - @colibri-social/lexicons@2.35.0
  - @colibri-social/voice@0.3.0
  - @colibri-social/space@0.10.0
  - @colibri-social/community@2.14.0
  - @colibri-social/notifications@1.8.13
  - @colibri-social/projections@1.14.2
  - @colibri-social/blobs@0.2.3
  - @colibri-social/space-sync@0.6.3

## 2.33.0

### Minor Changes

- f583cda: Store a volume for in-app sound effects with the other client preferences, so the setting follows you across devices

### Patch Changes

- 4ab879d: Fix channel reordering after a channel was deleted, and repair every category's channel order on startup and on each reorder. A new channel now takes its category's visibility rules as soon as it syncs. Messages edited outside Colibri now show as edited, a second reaction record with the same emoji no longer leaves a stale reaction behind, and links that point straight at an image, SVG included, now preview as that image.
- 1d1e179: Keep delivering a channel's events after a client releases its own hold on a channel that its community subscription still grants. Releasing a channel now drops only the explicit hold, and unsubscribing a community drops only the channels it granted.
- 9ab78a0: Stop a full repo resync from notifying, pushing or streaming messages that were already indexed unchanged. Only new or changed records go through the notification pipeline.
- 28372a2: Fix attachments, avatars and role images that failed to load after a repo was synced for the first time, such as messages in a new channel or thread. On startup, the AppView resyncs every repo stored with a broken blob reference.
- Updated dependencies [4ab879d]
- Updated dependencies [9ab78a0]
- Updated dependencies [f583cda]
- Updated dependencies [28372a2]
- Updated dependencies [4ab879d]
  - @colibri-social/projections@1.14.1
  - @colibri-social/embeds@0.2.1
  - @colibri-social/space-sync@0.6.2
  - @colibri-social/lexicons@2.34.0
  - @colibri-social/appview-db@0.20.1
  - @colibri-social/voice@0.2.1
  - @colibri-social/community@2.13.2
  - @colibri-social/notifications@1.8.12

## 2.32.0

### Minor Changes

- ea8de44: Accept emoji role badges on `role.create` and `role.update`, and return them in role views. A custom emoji badge carries its name and image URL when the emoji index knows it.

### Patch Changes

- ea8de44: Send the first image of a message with its push, skip notifications, thread reopening and live updates for messages the time guard refuses, and store and return the `hideOwnerBadge` Space setting.
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
- Updated dependencies [ea8de44]
  - @colibri-social/projections@1.14.0
  - @colibri-social/appview-db@0.20.0
  - @colibri-social/lexicons@2.33.0
  - @colibri-social/community@2.13.1
  - @colibri-social/notifications@1.8.11

## 2.31.0

### Minor Changes

- 7097dbf: Let `social.colibri.beta.actor.putMutes` carry an optional `leftThreads` list next to `mutes`, which is now optional too. Each list a request carries replaces the stored copy, and a list it leaves out stays as it is. `getPreferences` returns the list as `leftThreads`. A user who left a thread gets no plain message notifications for it and drops out of its member list unless they follow it. A mention or a reply in the thread brings them back and removes the entry. The new `left_threads` table holds the list.
- 73d1143: Let owners host a community on an account of their own through OAuth, and move a community account off this AppView's PDS. `social.colibri.beta.community.authorizeHost` starts a sign-in as the community account, which adopts it as a new community or reconnects an existing one, and `getHostAuthorization` reports the outcome. `getHosting` tells administrators where the account lives and whether the AppView needs a new sign-in. `handOverHost` sets the owner's email on an account this AppView hosts and returns a new password that works for 60 minutes, after which the AppView replaces it unless the account moved. A community whose account moved to another server asks for a sign-in again, and its password is no longer reset on this AppView's PDS. Host sign-in needs `HOST_OAUTH_PRIVATE_KEY`, and `HOST_OAUTH_RETURN_URL` sets where the browser lands afterwards. The permission set for managing communities includes the four new methods.

### Patch Changes

- 3116a04: Read a custom emoji the index hasn't seen yet straight from its owner's PDS and refresh an owner's emoji catalog once it's an hour old. Send the full message, attachments and reply included, with each notification. Answer `listMessages` without waiting for link previews, profiles, or handle checks, and send late link previews as message updates. Keep link previews in the new `link_previews` table so they survive restarts.
- a3a2f09: Load only the reactions and labels a message page shows, and look up the community and the reader's permissions once per page.
- 7097dbf: Refuse a message whose record key isn't a TID, or whose record key or `createdAt` is more than 15 minutes ahead of the server clock. Refuse a newly created message whose record key is more than 24 hours older than the commit that created it, except for history a bridge imported. A thread's last activity never moves past the server clock. Add `pnpm --filter @colibri-social/appview purge-future-messages`, which lists projected messages dated more than 15 minutes ahead and the thread activity it would rewind, and deletes them with `--apply`.
- Updated dependencies [3116a04]
- Updated dependencies [a3a2f09]
- Updated dependencies [7097dbf]
- Updated dependencies [7097dbf]
- Updated dependencies [73d1143]
  - @colibri-social/appview-db@0.19.0
  - @colibri-social/identity@0.3.1
  - @colibri-social/projections@1.13.6
  - @colibri-social/lexicons@2.32.0
  - @colibri-social/notifications@1.8.10
  - @colibri-social/space-sync@0.6.1
  - @colibri-social/space@0.9.0
  - @colibri-social/community@2.13.0
  - @colibri-social/blobs@0.2.2

## 2.30.0

### Minor Changes

- dd7a07e: Add `social.colibri.beta.emoji.getEmojis`, which returns up to 100 custom emoji by record URI across any number of repos in one request. Owners whose repo can't be read come back in `unreachable`. The method joins the `permissionCommunity` permission set next to `getCatalog`.

### Patch Changes

- Updated dependencies [dd7a07e]
  - @colibri-social/lexicons@2.31.0
  - @colibri-social/community@2.12.2
  - @colibri-social/notifications@1.8.9
  - @colibri-social/projections@1.13.5

## 2.29.0

### Minor Changes

- 0b325da: Update Spaces support to the October 22 alpha (`0.0.0-spaces-alpha-20261022141228`). Space credentials are requested with a JSON body and presented with the `Atproto-Space-Credential` scheme. Space hosts resolve through `#atproto_pds`. Commits and records are verified with MACs keyed against each author's `#atproto_kem` key, and full repos arrive as STAR archives. Accounts that haven't published a KEM key can't be synced until their PDS publishes one.

### Patch Changes

- aea592c: Keep the list of legacy communities a user removed from their sidebar when storing and serving client preferences
- Updated dependencies [aea592c]
- Updated dependencies [0b325da]
  - @colibri-social/lexicons@2.30.0
  - @colibri-social/projections@1.13.4
  - @colibri-social/appview-db@0.18.1
  - @colibri-social/space@0.8.0
  - @colibri-social/space-sync@0.6.0
  - @colibri-social/identity@0.3.0
  - @colibri-social/community@2.12.1
  - @colibri-social/notifications@1.8.8
  - @colibri-social/blobs@0.2.1

## 2.28.0

### Minor Changes

- 817469f: Run legacy community migrations as resumable background jobs that copy bans, serve legacy message history read-only in the migrated channels, mark that history as read for every member and retire the legacy community record when done. A community whose account this AppView can't sign in to moves into a newly provisioned account built from its public records, and its legacy record stays as it is
- dc2a71b: Add `lastMessage` to `social.colibri.beta.thread.defs#threadView`, the latest message in the thread the requesting user may see, in the `channelSummary` shape channel previews use

### Patch Changes

- 38045e1: Serve images inside a forwarded message after it moves to another channel or thread
- dc2a71b: Serve attachment images whose stored blob reference is nested, and store blob references in one plain form
- 4753bda: Mark every channel a new member can read as read when they join a community or their application is approved
- 817469f: Serve Space banners as a 2:1 `spaceBanner` image variant so they fill the Space header without being cropped twice
- Updated dependencies [817469f]
- Updated dependencies [817469f]
- Updated dependencies [dc2a71b]
- Updated dependencies [817469f]
- Updated dependencies [dc2a71b]
  - @colibri-social/appview-db@0.18.0
  - @colibri-social/community@2.12.0
  - @colibri-social/lexicons@2.29.0
  - @colibri-social/projections@1.13.3
  - @colibri-social/blobs@0.2.0
  - @colibri-social/notifications@1.8.7

## 2.27.0

### Minor Changes

- 5fd5282: Add `gifLoopLimit` to `social.colibri.beta.actor.defs#clientPreferences`, the number of times a GIF in chat plays before it pauses

### Patch Changes

- Updated dependencies [5fd5282]
  - @colibri-social/lexicons@2.28.0
  - @colibri-social/community@2.11.5
  - @colibri-social/notifications@1.8.6
  - @colibri-social/projections@1.13.2

## 2.26.0

### Minor Changes

- 572ef3b: Add `moveTo` to `social.colibri.beta.voice.moderate` and the `moved` voice signal frame, so moderators can move members between voice channels

### Patch Changes

- bfc8ebe: Track presence in channel per-device
- 42b0ba6: Retries failed handle verifications after 5 minutes, so new accounts no longer show `handle.invalid` for a day
- Updated dependencies [42b0ba6]
- Updated dependencies [572ef3b]
  - @colibri-social/identity@0.2.2
  - @colibri-social/lexicons@2.27.0
  - @colibri-social/community@2.11.4
  - @colibri-social/notifications@1.8.5
  - @colibri-social/projections@1.13.1

## 2.25.0

### Minor Changes

- cb51fa0: Moderators and owners can keep messages a moderator hid out of view, everywhere or in single Spaces. `actor.clientPreferences` and `actor.defs#clientPreferences` gain an optional `hideModeratedMessages` flag. The new `actor.spaceModeration` record, keyed by the community DID, overrides it for one community, and `actor.putSpaceModeration` pushes it with `hideModeratedMessages` or `remove`. `actor.defs#preferences` lists the overrides in `spaceModerations`, and the account permission set covers the new record and procedure. The AppView stores the overrides in the new `space_moderations` table.

### Patch Changes

- Updated dependencies [cb51fa0]
  - @colibri-social/lexicons@2.26.0
  - @colibri-social/appview-db@0.17.0
  - @colibri-social/projections@1.13.0
  - @colibri-social/community@2.11.3
  - @colibri-social/notifications@1.8.4

## 2.24.0

### Minor Changes

- daa5699: A status can be emoji-only or use a custom emoji. `actor.defs#status` makes `text` optional and gains an optional `customEmoji` ref to a custom emoji record. `actor.setStatus` accepts `customEmoji` and `removeCustomEmoji`. The AppView keeps a status that has only an emoji, stores the custom emoji ref in the new `user_presence.status_custom_emoji` column, and rejects a uri that doesn't name an emoji record.

### Patch Changes

- Updated dependencies [daa5699]
  - @colibri-social/lexicons@2.25.0
  - @colibri-social/appview-db@0.16.0
  - @colibri-social/community@2.11.2
  - @colibri-social/notifications@1.8.3
  - @colibri-social/projections@1.12.2

## 2.23.0

### Minor Changes

- 8eba18b: Link previews carry more of what a page declares. `linkEmbed` gains `themeColor`, `layout`, `provider`, `author`, `publishedAt`, a `media` gallery and a `post` with formatted text, a content warning, engagement counts, a quoted post and the source language of a translation. The AppView reads `theme-color`, `twitter:card`, repeated `og:image` tags, the site icon and `article:published_time`, follows oEmbed links, resolves Mastodon statuses behind ActivityPub alternate links, and resolves X and fixer-domain post links through the FxEmbed API, honoring a trailing language code as a translation request.

### Patch Changes

- 8eba18b: Store messages and reactions sent in voice channel chats, only push voice chat notifications and edits to people in the call, and add the `inboxPresentation` client preference
- Updated dependencies [8eba18b]
- Updated dependencies [8eba18b]
  - @colibri-social/lexicons@2.24.0
  - @colibri-social/embeds@0.2.0
  - @colibri-social/projections@1.12.1
  - @colibri-social/appview-db@0.15.1
  - @colibri-social/notifications@1.8.2
  - @colibri-social/community@2.11.1

## 2.22.0

### Minor Changes

- 54abd78: Reactions can name the emoji record behind a custom shortcode. `social.colibri.beta.reaction` accepts an optional `customEmoji` reference, and `reactionView` and the live `reactionEvent` carry it. A reaction view reports the reference from the earliest reaction that named one.
- 54abd78: Threads can be closed and locked. `social.colibri.beta.thread.update` accepts `closed` and `locked`, and thread views carry `closedAt`, `locked` and the new `canEdit`, `canClose`, `canDelete` and `canLock` viewer flags. The member who opened a thread can rename, close, reopen and delete it while they can still read it. Members with `thread.manage` can do all of that on any thread and can lock it, which leaves writing to them alone. A new message in a closed thread reopens it.

### Patch Changes

- 54abd78: Channel and thread `unreadMentions` count replies to the viewer as well as mentions.
- Updated dependencies [54abd78]
- Updated dependencies [54abd78]
- Updated dependencies [2cb2fa1]
  - @colibri-social/lexicons@2.23.0
  - @colibri-social/appview-db@0.15.0
  - @colibri-social/projections@1.12.0
  - @colibri-social/community@2.11.0
  - @colibri-social/notifications@1.8.1

## 2.21.0

### Minor Changes

- 384edf8: Every community has a Members role that everyone holds from the moment they join, so members can start threads. It can be edited but not deleted or taken away from anyone, it can't be mentioned, and communities and members missing it get it back automatically

### Patch Changes

- 384edf8: Notifications, push banners and edit pushes for bridged messages show the remote author's name and avatar instead of the community. `hydrateNotifications` takes a `NotificationAuthors` object with an optional `resolveMessageAuthor`, and `deliverMessageEdited` accepts a sender per recipient
- 384edf8: `blob.get` streams large blobs while it checks their CID, so the AppView no longer holds whole videos in memory. A CID mismatch found at the end aborts the connection. The blob cache only keeps blobs up to 16 MB, keys entries by DID, space and CID, and shares one upstream fetch between concurrent requests for the same blob. Blobs outside the media types are served as sandboxed `application/octet-stream` downloads, and missing and rejected blobs are logged with a code. `XrpcClient.stream` applies its timeout to the response headers only and aborts a body that sends nothing for `idleTimeoutMs`, 30 seconds by default
- 384edf8: Link previews for YouTube come from YouTube's oEmbed endpoint. Watch, `youtu.be`, Shorts, live, embed, mobile and YouTube Music links resolve to one canonical watch URL that keeps a `t` timestamp. The preview shows the video title, the channel name as its description, "YouTube" as the site name, and the largest available thumbnail with its real dimensions, vertical for Shorts where YouTube has one. When oEmbed refuses a video, the preview falls back to the watch page with a consent cookie and `hl=en`, and a consent page fails the preview. Every outbound embed fetch sends `accept-language: en-US,en;q=0.9`, and page fetches send an HTML `accept` header. Failed unfurls are logged with a code.
- Updated dependencies [384edf8]
- Updated dependencies [384edf8]
- Updated dependencies [384edf8]
- Updated dependencies [384edf8]
  - @colibri-social/notifications@1.8.0
  - @colibri-social/lexicons@2.22.0
  - @colibri-social/appview-db@0.14.0
  - @colibri-social/projections@1.11.0
  - @colibri-social/community@2.10.0
  - @colibri-social/blobs@0.1.0
  - @colibri-social/space@0.7.0
  - @colibri-social/embeds@0.1.0
  - @colibri-social/space-sync@0.5.4

## 2.20.0

### Minor Changes

- 3e21750: `thread.listMembers` lists who belongs to a thread: the author of the anchor message, everyone who posted in it or had messages moved into it, everyone mentioned in it directly or through a role they hold, and everyone who follows it

### Patch Changes

- Updated dependencies [3e21750]
  - @colibri-social/lexicons@2.21.0
  - @colibri-social/notifications@1.7.0
  - @colibri-social/community@2.9.2
  - @colibri-social/projections@1.10.1

## 2.19.0

### Minor Changes

- d2236e7: `social.colibri.beta.channel.defs#channelSummary` has an optional `facets` array with the latest message's annotations, so channel list previews can render custom emoji. Custom emoji the community's policy disallows are left out.
- d2236e7: Users can follow a custom emoji pack or a single custom emoji. A follow is a private `social.colibri.beta.emoji.follow` record in the user's preferences space that points at the owner's pack or emoji, so renames, new images and pack membership changes reach followers.
  
  - `emoji.putFollow` pushes a follow record to the AppView, and a call without `subject` removes it.
  - `emoji.getLibrary` returns the user's own emoji plus everything they follow, each with an `available`, `missing` or `unreachable` state.
  - `emojiLibraryEvent` carries the whole library to a user's connections when their own emoji change, their follows change, or the owner of something they follow changes their emoji. It replaces `emojiEvent` for a user's own emoji, and `emojiEvent` now only covers community emoji.
  - `emojiView` no longer has `copyOf`.
  - The account permission set covers the follow record, `emoji.putFollow` and `emoji.getLibrary`, so existing sessions ask for consent again on their next sign-in.

### Patch Changes

- 2881825: `social.colibri.beta.blob.get` responses allow any web origin to read them, so clients can fetch signed media links from script and read range headers
- Updated dependencies [d2236e7]
- Updated dependencies [d2236e7]
  - @colibri-social/lexicons@2.20.0
  - @colibri-social/appview-db@0.13.0
  - @colibri-social/projections@1.10.0
  - @colibri-social/emoji@0.2.0
  - @colibri-social/community@2.9.1
  - @colibri-social/notifications@1.6.2

## 2.18.0

### Minor Changes

- 56da297: Communities can have custom emoji and emoji packs. They're stored as Bluemoji records in the community's own repo, any repo's emoji can be listed with `emoji.getCatalog`, and changes reach clients live through `emojiEvent`.

### Patch Changes

- Updated dependencies [56da297]
  - @colibri-social/lexicons@2.19.0
  - @colibri-social/appview-db@0.12.0
  - @colibri-social/community@2.9.0
  - @colibri-social/space@0.6.0
  - @colibri-social/emoji@0.1.0
  - @colibri-social/notifications@1.6.1
  - @colibri-social/projections@1.9.4
  - @colibri-social/blobs@0.0.8
  - @colibri-social/space-sync@0.5.3

## 2.17.0

### Minor Changes

- bf32399: Adds optional `width` and `height` to message attachments. The AppView passes them through to `width` and `height` on attachment views when both are positive integers.
- 25670ca: Clearing the inbox now clears it on every device, the channel list shows each channel's latest message in one request, jumping to an older message opens right at it, notifications name their thread, and the invites list updates live.
- 7d1d763: Fills `embeds` on message views with link previews for up to five links per message, skipping links the author suppressed. Reads wait up to 2 seconds for previews that aren't cached yet. Live message events go out right away and are followed by an `update` event once a pending preview resolves. Direct image and video links become image or video embeds without fetching a page. Previews stay cached for 6 hours, and failed links are retried after 5 minutes.
- 8e4e6c1: Adds `social.colibri.beta.notification.markReadFromNotification`, an unauthenticated procedure that marks a channel or thread read from a signed push token, and grants it in `social.colibri.beta.permissionPush`. Push payloads carry `type`, `kind`, `spaceName`, `placeName`, `subtitle`, `body`, `badge`, `readUrl` and `readToken`. APNs alerts use the author as title, the in-app subtitle, the unread badge, `ping.caf` and the `message` category. Reading a channel, deleting a message and editing a message send `read`, `delete` and `edit` background pushes to APNs and FCM devices. Set `PUSH_ACTION_SECRET` to sign the read tokens.
- bf32399: Adds optional `camera` and `screen` flags to `social.colibri.beta.actor.defs#voiceState`. The AppView sets them from each participant's video producers and sends a voice `update` event to the community when a camera or screen share starts or stops, so clients can show who is sharing in channels they haven't joined.

### Patch Changes

- Updated dependencies [bf32399]
- Updated dependencies [25670ca]
- Updated dependencies [8e4e6c1]
- Updated dependencies [bf32399]
  - @colibri-social/lexicons@2.18.0
  - @colibri-social/notifications@1.6.0
  - @colibri-social/appview-db@0.11.0
  - @colibri-social/voice@0.2.0
  - @colibri-social/community@2.8.4
  - @colibri-social/projections@1.9.3

## 2.16.0

### Minor Changes

- 9034d25: `social.colibri.beta.message#attachment` takes an optional `alt` string of up to 2000 graphemes. `social.colibri.beta.channel.defs#attachmentView` serves it when the author set one.
- 9034d25: `social.colibri.beta.actor.profile` takes an optional `pronouns` string of up to 64 graphemes. The profile view in `social.colibri.beta.actor.defs` serves the resolved `pronouns`, which fall back to the Bluesky profile's pronouns when `syncBluesky` is on and the Colibri record sets none.

### Patch Changes

- Updated dependencies [9034d25]
- Updated dependencies [9034d25]
- Updated dependencies [58b7b76]
  - @colibri-social/lexicons@2.17.0
  - @colibri-social/community@2.8.3
  - @colibri-social/notifications@1.5.2
  - @colibri-social/projections@1.9.2

## 2.15.0

### Minor Changes

- 3f9768e: `social.colibri.beta.channel.update` takes `removeLinkEmbeds`, which clears a channel's link preview setting so the community default applies again. A `linkEmbeds` value in the same call takes precedence.

### Patch Changes

- Updated dependencies [3f9768e]
  - @colibri-social/lexicons@2.16.0
  - @colibri-social/community@2.8.2
  - @colibri-social/notifications@1.5.1
  - @colibri-social/projections@1.9.1

## 2.14.0

### Minor Changes

- ac08881: Adds an optional `spoiler` flag to `social.colibri.beta.message#attachment` and `social.colibri.beta.channel.defs#attachmentView`. The AppView copies the flag from each stored attachment into the message and forward views it serves.
- ac08881: Adds per-user state that follows a user across devices:
  
  - `social.colibri.beta.actor.clientPreferences` holds client settings such as gesture controls, theme, link options, the Bluesky client, developer mode, voice view options and experiments.
  - `social.colibri.beta.actor.composerState` holds emoji usage, skin tone and recent GIFs.
  - `social.colibri.beta.actor.spaceNotification` sets a notification level for one community, keyed by its DID. `social.colibri.beta.actor.putSpaceNotification` pushes it to the AppView.
  - `notificationLevel` accepts `nothing`, which drops every notification, mentions included.
  - `social.colibri.beta.actor.mute` accepts `#mutedThread` subjects.
  
  `putSettings` takes `clientPreferences` and `composerState`, and `getPreferences`, `putSettings` and `preferencesEvent` return them together with `spaceNotifications`. Notification fan-out uses a community's level over the global one. The account permission set covers the new collections and procedure.

### Patch Changes

- 4eac24a: Fixes message paging past the second page. `channel.listMessages` and thread message lists now return a cursor on every page that has more messages after it, in both directions, so clients can load a channel's full history.
- Updated dependencies [ac08881]
- Updated dependencies [ac08881]
- Updated dependencies [ac08881]
  - @colibri-social/lexicons@2.15.0
  - @colibri-social/space-sync@0.5.2
  - @colibri-social/appview-db@0.10.0
  - @colibri-social/projections@1.9.0
  - @colibri-social/notifications@1.5.0
  - @colibri-social/community@2.8.1

## 2.13.0

### Minor Changes

- d698add: Adds ownership transfer, category permissions and a custom emoji facet. The new `community.transferOwnership` procedure gives a member every protected owner role the caller holds and then removes those roles from the caller, who keeps their other roles. The category record, `category.create`, `category.update` and the category view gain `ownerOnly`, `allowedRoles`, `allowedMembers`, `visibleToRoles` and `visibleToMembers`, and the view adds `private`. A channel in a category inherits the category's read audience unless it sets its own `visibleToRoles` or `visibleToMembers`, and inherits its posting rules unless it sets its own `ownerOnly`, `allowedRoles` or `allowedMembers`. Space credentials, channel lists and live events all follow the inherited rules. The rich text facet gains `#customEmoji`, which points at an emoji record by `uri` and `cid` over the emoji's fallback text, and bridged messages keep that fallback text. The community settings record, `community.update` and the community view gain `customEmoji`, which is `all`, `local` or `none`. Message views drop custom emoji facets the community's policy disallows and keep the fallback text under them.
- d698add: Keeps read state in step across a user's sessions. The new `sync.defs#readCursorEvent` carries a community and the read cursors that moved, and `channel.putReadCursors` sends it to every session of the caller. A read record that arrives through sync sends it too. `putReadCursors` and the read record projection keep the newer cursor per channel or thread, and leave channels the write omits untouched, so a cursor from a stale device never moves read state backwards. The `@colibri-social/projections` package exports the merge as `mergeReadCursors`. Following or unfollowing a thread sends the follower's sessions a `threadEvent` update with their new viewer state. A `seenEvent` sent for `notification.updateSeenForMessage` names the message in a new optional `message` field, so other sessions can clear that notification.
- d698add: Lets the other side of a bridge disconnect it. `/colibri disconnect` disconnects a Discord server from Colibri, with an optional `community` option that autocompletes the communities the server is paired with. `BridgeContext` gains `connections()`, which lists a remote space's registrations, and `disconnect()`, which leaves all of them or the one community given and counts a registration already revoked in Colibri as disconnected. Bridge registration views carry an optional `communityName`.

### Patch Changes

- 94d8628: Keeps the last cached profile when refreshing it from the PDS fails, so a rate limit or timeout no longer returns a blank profile or overwrites the cache
- Updated dependencies [d698add]
- Updated dependencies [d698add]
- Updated dependencies [d698add]
  - @colibri-social/lexicons@2.14.0
  - @colibri-social/appview-db@0.9.0
  - @colibri-social/projections@1.8.0
  - @colibri-social/community@2.8.0
  - @colibri-social/notifications@1.4.1

## 2.12.0

### Minor Changes

- 8e3c854: Adds direct APNs push for iOS and macOS, configured with `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID`, and includes the sender's name and avatar in every push.
- 6b3d5ef: Adds role badges and a Space-wide name colour override. A role carries an optional `badge`, either an icon from the client's curated set with an optional colour or an uploaded image of up to 256 KB. `role.create` and `role.update` take an icon badge, `role.update` clears one with `removeBadge`, and the new `role.putBadgeImage` uploads an image badge as the community. Role views return the badge with image badges served through a signed members-space link. The community settings record, `community.create`, `community.update` and the community view gain `overrideUserNameColors`, which hides members' own name colours in chat so only role colours show, and a member without a coloured role gets the default name colour.
- 6b3d5ef: Raises the status text limit from 32 to 64 bytes and adds `expiresAt` and `showWhileOffline` to the status. `actor.setStatus` takes both fields and clears an expiry with `removeExpiresAt`. Presence views and events leave out a status once its expiry has passed. `showWhileOffline` defaults to false and is passed through for clients to apply.

### Patch Changes

- bb5a859: Serves community pictures and banners from the profile space through per-viewer signed links, and answers a missing public blob with 404.
- f7b360b: Allows the `sentry-trace` and `baggage` request headers in CORS preflights, so browsers can call `com.atproto.identity.resolveHandle` directly and users with DNS-only handles can sign in
- 5640cde: Stops retrying sync for authors whose DID document has no `#atproto_pds` service, and logs the message and cause of every `error` field.
- 08eebc0: Routes pushes for thread messages to the parent channel and thread, and sends Android pushes as data-only messages so tapping one opens the right message.
- ef70f83: Targets the 2026-10-01 atproto Spaces alpha. Space credentials are bound with HTTP Message Signatures and carry the audience of each request, a revoked or rejected credential is replaced once through a fresh delegation, sync follows `spaceRev` and catches up from `listRepos` after a gap, and `createSpace` sends `spaceType`. The vendored space lexicons move to atproto `679724ad`.
- Updated dependencies [8e3c854]
- Updated dependencies [bb5a859]
- Updated dependencies [5640cde]
- Updated dependencies [08eebc0]
- Updated dependencies [6b3d5ef]
- Updated dependencies [ef70f83]
- Updated dependencies [6b3d5ef]
  - @colibri-social/appview-db@0.8.0
  - @colibri-social/lexicons@2.13.0
  - @colibri-social/notifications@1.4.0
  - @colibri-social/blobs@0.0.7
  - @colibri-social/identity@0.2.1
  - @colibri-social/space-sync@0.5.1
  - @colibri-social/projections@1.7.0
  - @colibri-social/community@2.7.0
  - @colibri-social/space@0.5.0

## 2.11.1

### Patch Changes

- 326c689: Adds `bridge.leave` and `bridge.replaceAvatar`, so a bridge revokes its registration when a Discord server removes it, purges its local data for revoked registrations, and swaps a changed avatar on the author's earlier bridged records
- Updated dependencies [326c689]
  - @colibri-social/community@2.6.1
  - @colibri-social/lexicons@2.12.1
  - @colibri-social/notifications@1.3.3
  - @colibri-social/projections@1.6.1

## 2.11.0

### Minor Changes

- 6e75d20: Adds bridges that relay channels, their threads, mentions, forwards and optionally moderation between a community and another chat service, starting with Discord, and can import a channel's earlier history, and indexes a message or reaction only when its author may post in that channel
- c80c110: Adds the optional `DEFAULT_COMMUNITY_DID` setting, which `describeServer` reports as `defaultCommunity` so clients can join new users to it

### Patch Changes

- 88fba3e: Jetstream now drops a cursor the server rejects as too old and keeps a single reconnect in flight
- 68649af: The appview answers XRPC errors itself, so client errors no longer print a stack trace to the console
- c13dd17: The sync engine can now ask the appview whether a space is renewable at all, and parks the ones that are not without warning on every startup
- a949e8a: The notification routes now accept a thread space, so unseen counts and seen markers work inside threads
- Updated dependencies [6e75d20]
- Updated dependencies [c80c110]
- Updated dependencies [c13dd17]
- Updated dependencies [d8e32d1]
  - @colibri-social/appview-db@0.7.0
  - @colibri-social/community@2.6.0
  - @colibri-social/identity@0.2.0
  - @colibri-social/lexicons@2.12.0
  - @colibri-social/projections@1.6.0
  - @colibri-social/space@0.4.0
  - @colibri-social/space-sync@0.5.0
  - @colibri-social/notifications@1.3.2
  - @colibri-social/blobs@0.0.6

## 2.10.0

### Minor Changes

- 1ed3c64: Presence now carries one activity per service an actor shares from, including what they are playing on atmosphere.games

### Patch Changes

- Updated dependencies [1ed3c64]
  - @colibri-social/lexicons@2.11.0
  - @colibri-social/appview-db@0.6.0
  - @colibri-social/space@0.3.0
  - @colibri-social/community@2.5.2
  - @colibri-social/notifications@1.3.1
  - @colibri-social/projections@1.5.1
  - @colibri-social/blobs@0.0.5
  - @colibri-social/space-sync@0.4.1

## 2.9.0

### Minor Changes

- 4a7247d: A message can now carry a forwarded copy of another message, and the AppView serves it with its source channel or thread resolved

### Patch Changes

- b6f4239: Moved messages are now served at the correct point in time, not appended
- Updated dependencies [4a7247d]
- Updated dependencies [b6f4239]
  - @colibri-social/lexicons@2.10.0
  - @colibri-social/appview-db@0.5.0
  - @colibri-social/projections@1.5.0
  - @colibri-social/notifications@1.3.0
  - @colibri-social/community@2.5.1

## 2.8.0

### Minor Changes

- 58aea35: Give the owner role every permission, including ones added after the community was made: permission checks now treat the protected role the way they already treated the community itself, and a sweep at startup writes any missing permissions back onto the record
- 58aea35: Serve threads: a thread space projects to its own table, access follows the parent channel and the thread's own visibility, and the thread methods create, rename, repoint, delete and move messages between spaces. Notifications now check that the recipient may read the space, which stops a mention in a private channel or thread reaching someone outside it.

### Patch Changes

- 58aea35: Stamp the type on a thread's anchor message so getThread can serve it, keep a failing anchor lookup from taking the thread with it, carry the thread itself on activity frames so message counts stay current without a reload, and let a moved message be sent back to the channel it came from
- 58aea35: Let a thread follow the message it was opened from: thread.repoint takes an optional anchor so a rewritten message can be pointed at, and thread.moveMessages carries a thread whose anchor was moved into the destination channel
- 58aea35: Honour a write hint for any space the writer can read rather than only one it is subscribed to, so a message written into a thread nobody is watching is picked up at once, and announce a retracted move to both spaces so the message returns to its channel and leaves the thread without a reload
- Updated dependencies [58aea35]
- Updated dependencies [58aea35]
- Updated dependencies [58aea35]
  - @colibri-social/community@2.5.0
  - @colibri-social/lexicons@2.9.1
  - @colibri-social/appview-db@0.4.0
  - @colibri-social/notifications@1.2.0
  - @colibri-social/projections@1.4.0
  - @colibri-social/space-sync@0.4.0

## 2.7.2

### Patch Changes

- Updated dependencies [305fd99]
  - @colibri-social/lexicons@2.9.0
  - @colibri-social/community@2.4.1
  - @colibri-social/notifications@1.1.6
  - @colibri-social/projections@1.3.5

## 2.7.1

### Patch Changes

- 145f753: Show the wide link card for sites that ship an OpenGraph image without `og:image:width` and `og:image:height`
- b03c206: Exit on a fatal error so the container restarts clean, guard the async paths that could reach one, and cap the repo CAR buffer
- 4fe3ad3: Fixes a crash within the fetch handler
- Updated dependencies [145f753]
- Updated dependencies [b03c206]
- Updated dependencies [4fe3ad3]
  - @colibri-social/embeds@0.0.1
  - @colibri-social/space-sync@0.3.2
  - @colibri-social/voice@0.1.3

## 2.7.0

### Minor Changes

- 636530e: Find cover art for more tracks. Artwork resolution now tries MusicBrainz and Deezer alongside Cover Art Archive and iTunes, and `VIDEO_ARTWORK_ENABLED` adds a YouTube search for uploads no music database carries
- 64d9500: Improve actor hydration, cache handle/identity resolution, fix listMembers `cursor` and `role` parameters usage, `getUnseen` index building improvements, add `space` to `notifications_unseen_idx`
- d7c4b6f: Stop invitations from bypassing join approval
- 2b382d8: Read listening activity from rocksky.app and atradio.fm alongside teal.fm, and pick up the `fm.teal.alpha.actor.status` records a lot of accounts write instead of the current collection

### Patch Changes

- 1d48890: Stop retrying spaces the AppView cannot mint a credential for. A space that fails with `noDelegationToken` now goes dormant instead of retrying `registerNotify` every minute and failing every sweep, and a fresh grant from the client wakes it again. A space whose owning community is gone is dropped outright, and purging a community now tells the sync engine so its spaces leave the registration map
- 5c3cf2b: Only use a YouTube still when the video is the scrobbled track. Title and channel must both match, and anything short of that falls back to the activity icon
- Updated dependencies [1d48890]
- Updated dependencies [64d9500]
- Updated dependencies [d7c4b6f]
- Updated dependencies [f0d57a4]
  - @colibri-social/space-sync@0.3.1
  - @colibri-social/appview-db@0.3.0
  - @colibri-social/identity@0.1.0
  - @colibri-social/notifications@1.1.5
  - @colibri-social/community@2.4.0
  - @colibri-social/lexicons@2.8.0
  - @colibri-social/projections@1.3.4

## 2.6.0

### Minor Changes

- eebf5ef: Show what someone is listening to when they turn on shareActivity, read from the teal.fm records on their own account

### Patch Changes

- Updated dependencies [eebf5ef]
  - @colibri-social/lexicons@2.7.0
  - @colibri-social/appview-db@0.2.1
  - @colibri-social/projections@1.3.3
  - @colibri-social/community@2.3.2
  - @colibri-social/notifications@1.1.4

## 2.5.1

### Patch Changes

- f67763b: Tell an invited user they are banned, and keep moderation log entries to the moderators
- 45707d5: Leave a channel read when the newest message in it is your own
- 1669210: Wait for every mediasoup worker subprocess to exit before the appview process does, so a restart no longer fails on ports the old workers still hold
- 16a342d: Announce a voice join as soon as the peer joins, not when it creates its first transport
- f67763b: Ask Opus for DTX alongside inband FEC, and cap the initial outgoing bitrate estimate
- Updated dependencies [bad9064]
- Updated dependencies [1669210]
- Updated dependencies [16a342d]
- Updated dependencies [f67763b]
  - @colibri-social/lexicons@2.6.0
  - @colibri-social/voice@0.1.2
  - @colibri-social/community@2.3.1
  - @colibri-social/notifications@1.1.3
  - @colibri-social/projections@1.3.2

## 2.5.0

### Minor Changes

- b1bbb1a: Scope channel events and live delivery to the people who may read the channel
- 321e7dc: Tell every member when a community is deleted and drop its data straight away, so it stops being listed and stops being served the moment its owner deletes it instead of lingering until its PDS reports the deletion. Deleting a community now also deletes its channel spaces, and a community whose profile space disappears out of band is reconciled the same way.

### Patch Changes

- 38dc331: Sign an attachment's media link for each recipient of a live message event, so a blob in a permissioned space loads without waiting for a reload. Declare the viewer, exp and sig params on social.colibri.beta.blob.get
- dc9ea5c: Reconcile a mute by its subject rather than its record key, so the immediate `actor.putMutes` push and the later repo sync of the same mute no longer collide on the one-mute-per-subject index and strand the user's preferences space with an unapplied cursor
- b1e2b73: Run each actor's presence transitions in order, so a socket that opens and closes in quick succession can no longer swallow the offline broadcast and leave that member listed as online for everyone else
- dc9ea5c: Default the SFU's RTC port range to 40000-40100, the range the compose file publishes. With neither `SFU_RTC_MIN_PORT` nor `SFU_RTC_MAX_PORT` set, transports took a port from mediasoup's own 10000-59999 default, so almost every candidate pointed at a port nothing forwarded and calls failed to connect.
- f29b7d4: Publish the SFU's media port range for TCP as well as UDP, so the ICE over TCP fallback the SFU advertises can be reached. A port Docker does not forward drops the connection attempt without a reply, which fails ICE and leaves callers in silence.
- 324a3e6: Move commit verification and repo recovery onto worker threads, so a large repo no longer stalls message delivery for every other channel. Set SYNC_WORKER_THREADS to turn it on
- 07d1508: Give each account a single voice session. Joining a voice channel now retires that account's other voice sockets with a `superseded` reason, so a second device takes the call over instead of running alongside it, and nobody can sit in two channels at once. A handover within the same channel keeps the participant record, so the rest of the room sees the media move rather than a leave followed by a rejoin.
  
  Along with it, a set of voice fixes:
  
  - A frame the SFU cannot serve is answered with an error instead of rejecting unhandled, which could take the process down when Sentry was not configured.
  - A server mute now pauses every audio producer rather than only the one declaring `mic`, survives the muted account reconnecting, and can be applied before that account carries any media.
  - Voice connections release their topic subscriptions when they close, and frames from one socket are handled in order, so a socket can no longer leave a channel claiming it forever.
  - A transport mediasoup reports as closed or failed is closed rather than only forgotten, releasing its ports and its producers instead of replaying dead producers to everyone who joins.
  - The speaking indicator settles after the debounce window even when no further audio arrives, and clears when a speaker leaves mid-word.
  - A room whose worker died is torn down, so presence stops reporting its participants as being in a call.
  - `produce`, `consume` and `setSelfState` no longer conjure a participant from a frame naming an unknown transport, which used to announce a phantom join to the whole community.
  - Joining replays who is already in the room and what moderation applies to them, and producer frames carry `paused`.
  - Presence is claimed before the room is created, so two devices racing to create transports cannot leave one of them live in an untracked room.
  - `SFU_ICE_SERVERS` reaches clients through `transportOptions`, so configured STUN and TURN servers are used instead of silently dropped.
- Updated dependencies [321e7dc]
- Updated dependencies [38dc331]
- Updated dependencies [dc9ea5c]
- Updated dependencies [dc9ea5c]
- Updated dependencies [324a3e6]
- Updated dependencies [07d1508]
  - @colibri-social/community@2.3.0
  - @colibri-social/space-sync@0.3.0
  - @colibri-social/lexicons@2.5.0
  - @colibri-social/projections@1.3.1
  - @colibri-social/voice@0.1.1
  - @colibri-social/notifications@1.1.2

## 2.4.0

### Minor Changes

- d2c8938: Gate voice joins on the same permission as posting, and disconnect a participant whose access changes mid-call

### Patch Changes

- a9cea8f: Give a new community a random handle, so provisioning no longer fails on the PDS handle length limit
- 1c863c7: Keep a community picture, banner and message attachment after it is saved, by converting blob references between their json and lexicon forms at every boundary
- d175422: Deliver messages as soon as they are written instead of sometimes waiting for the next sweep, by no longer dropping a write notification that arrives while a sync is already running, renewing the notify registration on its own schedule, and publishing a message before its notifications are indexed
- 88810f6: Serve your own profile straight from your PDS, so a change you just saved comes back instead of the cached one
- Updated dependencies [a9cea8f]
- Updated dependencies [1c863c7]
- Updated dependencies [d175422]
- Updated dependencies [a35adfc]
- Updated dependencies [132dd5a]
- Updated dependencies [d2c8938]
  - @colibri-social/community@2.2.1
  - @colibri-social/lexicons@2.4.0
  - @colibri-social/projections@1.3.0
  - @colibri-social/space-sync@0.2.1
  - @colibri-social/space@0.2.1
  - @colibri-social/notifications@1.1.1
  - @colibri-social/blobs@0.0.4

## 2.3.1

### Patch Changes

- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
  - @colibri-social/community@2.2.0
  - @colibri-social/space@0.2.0
  - @colibri-social/identity@0.0.1
  - @colibri-social/projections@1.2.1
  - @colibri-social/lexicons@2.3.0
  - @colibri-social/notifications@1.1.0
  - @colibri-social/space-sync@0.2.0
  - @colibri-social/blobs@0.0.3

## 2.3.0

### Minor Changes

- 22ad3fb: Announce channel, category, role, community, membership, profile and status changes to the community over the socket, and answer every voice frame a client waits on
- 22ad3fb: Keep a channel's visibility lists when projecting its record, and tell the community over the socket when a channel or category changes
- 22ad3fb: Resolve a community's handle from its DID document, and log every 5xx an XRPC route produces
- b5c5283: Answer CORS on `/xrpc`, including on error responses, and stop the catchall from shadowing the blob route
- 9c7e4d2: Serve embed images and video through the AppView again, answer handle and DID resolution for clients, deliver push notifications, honor muted channels, tell a peer when it is disconnected from a call, report errors to Sentry, and report progress while migrating
- 22ad3fb: Keep using a space credential that is still valid when nothing can mint a delegation token for it
- 912b790: Handle the typing and viewChannel frames, keep notifications quiet for the channel someone is reading, and send the notification, seen, application, moderation and community-progress events that were declared but never published
- 912b790: Report progress while migrating a legacy community, and announce a label the moment it is applied so a hidden message disappears live
- 22ad3fb: Add a `preferencesEvent` sync frame and send it to an actor's own devices when their preferences change
- 22ad3fb: Derive an actor's online state from their open event sockets, and broadcast it to the communities they belong to
- 22ad3fb: Sweep a channel space against its member list, so a member's repo is found and kept even when the authority's writer set leaves it out

### Patch Changes

- 9c7e4d2: Honor a role's per-channel overrides when checking `label.apply`, and keep every env file out of the Docker build context

## 2.2.0

### Minor Changes

- efcadc8: Make community migration work against a real legacy repo, and give it a picker
- efcadc8: Let a mute name a channel
- efcadc8: Follow profile records on Jetstream
- 0e3df75: Record every space in the `spaces` table at the moment it is created, so the sync
  engine can find it
- efcadc8: Refuse to boot on a bare-IP `did:web`
- efcadc8: Separate a peer's own mute from a moderator's

### Patch Changes

- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [0e3df75]
- Updated dependencies [efcadc8]
  - @colibri-social/lexicons@2.2.0
  - @colibri-social/community@2.1.0
  - @colibri-social/projections@1.2.0
  - @colibri-social/voice@0.1.0
  - @colibri-social/notifications@1.0.3

## 2.1.0

### Minor Changes

- 396e6ef: Report `software` and `flavor` from `server.describeServer` again, so a client can tell a Colibri AppView from any other host
- 396e6ef: Store a favourited GIF as the whole `embed.defs#gifView`, because an identifier cannot be turned back into one

### Patch Changes

- Updated dependencies [396e6ef]
- Updated dependencies [396e6ef]
  - @colibri-social/lexicons@2.1.0
  - @colibri-social/projections@1.1.0
  - @colibri-social/appview-db@0.2.0
  - @colibri-social/community@2.0.1
  - @colibri-social/notifications@1.0.2

## 2.0.0

### Major Changes

- 229dde3: Close the `blob.get` authorization hole without breaking browser media, also fixes the cache headers
- 229dde3: Make cross-AppView communities discoverable, and let a community bring its own DID

### Minor Changes

- a39c928: Give communities a working picture and banner write path

### Patch Changes

- Updated dependencies [a39c928]
- Updated dependencies [229dde3]
  - @colibri-social/lexicons@2.0.0
  - @colibri-social/community@2.0.0
  - @colibri-social/appview-db@0.1.0
  - @colibri-social/notifications@1.0.1
  - @colibri-social/projections@1.0.1

## 1.0.0

### Major Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

### Patch Changes

- bd2a38c: Enforce `hidden` labels server-side instead of forwarding them as advice
- Updated dependencies [49310eb]
- Updated dependencies [bd2a38c]
  - @colibri-social/lexicons@1.0.0
  - @colibri-social/space@0.1.1
  - @colibri-social/space-sync@0.1.1
  - @colibri-social/projections@1.0.0
  - @colibri-social/community@1.0.0
  - @colibri-social/notifications@1.0.0
  - @colibri-social/blobs@0.0.2

## 0.1.0

### Minor Changes

- 42ec07e: Initial release

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/lexicons@0.1.0
  - @colibri-social/space@0.1.0
  - @colibri-social/space-sync@0.1.0
  - @colibri-social/community@0.0.1
  - @colibri-social/notifications@0.0.1
  - @colibri-social/projections@0.0.1
  - @colibri-social/blobs@0.0.1
