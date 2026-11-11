# @colibri-social/admin

## 0.1.0

### Minor Changes

- 0a73387: Add `colibri-admin` and share settings across AppView nodes.
  
  - `colibri-admin` ships in the AppView image. Run it inside the main node's container: `node list`, `node add <id> --region --roles [--public-url]`, `node shutdown <id> --maintenance|--retire [--grace 15m] [--force]`, `node resume <id>`, `node remove <id> [--force]`, `rollout pause|resume`, and `config list|set|unset|import`. It exits with 1 when the main node refuses and 2 on a usage error.
  - Shutdown and resume orders travel over the event bus to the main node, which answers within 30 seconds. They need the Postgres setup.
  - Shared settings live in `cluster_config`, encrypted with `CREDENTIAL_ENCRYPTION_KEY`. Settings that describe a single node, such as `NODE_ID`, `ROLES`, `DATABASE_READ_URL` or `SFU_ANNOUNCED_IP`, stay local and are refused. `config import` reads an env file and stores only the shared settings.
  - A node with `MAIN_NODE_URL` fetches the shared settings from the main node before it loads its configuration, along with its ID, region and roles from the registry. Its own environment wins. When `MAIN_NODE_URL` points at a node that is no longer main, it follows that node to the current one. It retries for two minutes, then exits.
  - The node secret file now holds the node ID next to the secret.
  - `@colibri-social/appview/cluster` exports the registry, config store, orders and event bus for the CLI.
- aadf535: Copy a libSQL database into Postgres.
  
  - `colibri-admin db copy --from <libSQL url> --to <Postgres url> [--truncate]` applies the Postgres migrations, then copies every table in batches. JSON columns become `jsonb` and flags become booleans through the shared schema. It checks the row count of every table, and exits with 1 when the counts differ or it refuses to run.
  - It refuses a libSQL database that isn't on the current migrations, and a Postgres database that already has rows unless `--truncate` is passed.
  - `@colibri-social/appview-db` exports `appliedMigrations` and `knownMigrations`.
- 1205701: Fail the Postgres primary over to the failover node automatically and fence the old one.
  
  - `DATABASE_URL` can list several hosts. `@colibri-social/appview-db` connects to the one that accepts writes and has the highest epoch in `cluster_state`, rechecks every 10 seconds, and moves on read-only and connection errors. Advisory locks and the event bus follow it. It exports `FollowingPool`, `parsePostgresUrl`, `formatPostgresUrl`, `hostUrls`, `probeHost`, `pickPrimary` and `resolvePrimaryUrl`.
  - Every clustered node serves `GET /cluster/alive` on `CLUSTER_PORT` with the time it lost the primary. The failover node promotes its local Postgres (`LOCAL_POSTGRES_URL`, or `DATABASE_READ_URL`) once the primary has been unreachable for `FAILOVER_AFTER_SECONDS` (default 60) for it and for more than half of the nodes without the `main` or `failover` role. Promotion raises the epoch and creates replication slots for the other nodes. Without a witness node it doesn't promote on its own.
  - A writable Postgres with a lower epoch than the primary is fenced: it turns read-only and drops its client and replication connections. Nodes with the SSH key rebuild their own fenced Postgres with `rejoin-replica`, and the main node rebuilds other main and failover nodes.
  - `colibri-admin db failback [<node>]` moves the primary back to a node with the `main` role in a planned switchover. `colibri-admin db promote` promotes a failover node's Postgres by hand.
  - Replicas take a list of primary hosts in `PRIMARY_HOST` and stream with `target_session_attrs=read-write`. The main node's Postgres in `docker-compose.scaled.yml` uses the same entrypoint, so it can be rebuilt as a replica. Its AppView takes `DATABASE_URL` from `.env` when set.
  - Provisioning a failover node runs the new `database-hosts` playbook on every node. `rejoin-replica` takes `primary_hosts` and runs detached on the node that starts it.
- e917950: Deploy Prometheus, Grafana and Grafana Alloy across the cluster.
  
  - `colibri-admin monitoring deploy <node>` runs the new `monitoring` playbook. It starts Prometheus (`PROMETHEUS_IMAGE`, default `prom/prometheus:v3.15.1`, 90 days of data, remote write enabled) and Grafana (`GRAFANA_IMAGE`, default `grafana/grafana:13.2.5`, password from `GRAFANA_ADMIN_PASSWORD`) on the node's tailnet address. It then stores `PROMETHEUS_REMOTE_WRITE_URL` and runs the new `alloy` playbook on every node. Provisioning a node runs `alloy` too once monitoring exists.
  - Alloy (`ALLOY_IMAGE`, default `grafana/alloy:v1.21.2`) runs in the `monitoring` compose profile. It sends host metrics, the AppView's metrics, Postgres metrics where a database runs, and on the main node probes of the PDS, labeled with the node and region. It also reads `.prom` files from `/var/lib/colibri/metrics`, where `deploy/observability/pgbackrest-age.sh` writes the last backup time.
  - Grafana gets four dashboards (cluster, hosts, voice, Postgres). The hosts dashboard shows ingress and egress on public interfaces per node: totals for the selected range and the last 30 days, and daily bars. The cluster dashboard shows total ingress and egress. Alerts fire for a missing node, replication lag over 30 seconds, a backup older than 26 hours, a disk over 85% full, XRPC 5xx over 2% and read-only mode. With `ALERT_WEBHOOK_URL`, alerts go to that webhook.
  - The AppView listens for metrics on `0.0.0.0` inside the node and main compose stacks. Node `.env` files carry `NODE_REGION`, and the database URLs in them escape the user and password.
- 2d63cc4: Provision cluster nodes with Ansible and publish the AppView image.
  
  - Every push to `main` publishes `ghcr.io/colibri-social/api:edge` and `sha-<commit>`. A push that changes the `@colibri-social/appview` version also publishes the version tag and `stable`.
  - The image carries `ansible-core`, `openssh-client`, the playbooks in `deploy/ansible` and `colibri-admin` on the `PATH`.
  - `colibri-admin node add <id> --region --roles --public-url --ip [--workers]` has the main node bootstrap the server over SSH: Docker, Tailscale, a firewall, Caddy with Let's Encrypt, the AppView and, for sub and failover nodes, a streaming Postgres replica. The node joins with a one-time token. Without `--ip`, `node add` prints the settings for a manual setup.
  - `colibri-admin node recover <id>` restarts a node's stack. `node remove <id>` runs the remove playbook over the tailnet, then forgets the node.
  - The main node needs `TAILSCALE_AUTH_KEY`, `POSTGRES_REPLICATION_PASSWORD` and an SSH key at `SSH_KEY_FILE` to provision. `NODE_IMAGE`, `SSH_USER`, `ANSIBLE_DIR`, `REGISTRY_USER` and `REGISTRY_TOKEN` are optional. Ansible runs one playbook at a time and logs every line.
  - `docker-compose.scaled.yml` runs a main node: the Postgres primary with replication, the AppView with the main role and Caddy. Its `local-cluster` profile adds a replica, a sub node and a voice node for testing on one machine.
  - `docker-compose.yml` pulls `ghcr.io/colibri-social/api:stable` and gains an opt-in `updater` profile that keeps a single AppView on the newest stable image.
  - `colibri-admin config import -` reads the env file from standard input.
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

### Patch Changes

- Updated dependencies [0a73387]
- Updated dependencies [19f118e]
- Updated dependencies [aadf535]
- Updated dependencies [75c544f]
- Updated dependencies [1205701]
- Updated dependencies [149e2ca]
- Updated dependencies [6605f3d]
- Updated dependencies [cd8f0e9]
- Updated dependencies [da22296]
- Updated dependencies [e917950]
- Updated dependencies [ac153a2]
- Updated dependencies [2d63cc4]
- Updated dependencies [573ec8e]
- Updated dependencies [070ae7a]
- Updated dependencies [35b87d0]
- Updated dependencies [6246850]
- Updated dependencies [418b56f]
- Updated dependencies [19f118e]
- Updated dependencies [19f118e]
- Updated dependencies [43899d5]
- Updated dependencies [885c51d]
  - @colibri-social/appview@2.37.0
  - @colibri-social/appview-db@0.23.0
  - @colibri-social/community@2.15.2
