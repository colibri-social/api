---
"@colibri-social/appview": minor
"@colibri-social/admin": minor
---

Deploy Prometheus, Grafana and Grafana Alloy across the cluster.

- `colibri-admin monitoring deploy <node>` runs the new `monitoring` playbook. It starts Prometheus (`PROMETHEUS_IMAGE`, default `prom/prometheus:v3.15.1`, 90 days of data, remote write enabled) and Grafana (`GRAFANA_IMAGE`, default `grafana/grafana:13.2.5`, password from `GRAFANA_ADMIN_PASSWORD`) on the node's tailnet address. It then stores `PROMETHEUS_REMOTE_WRITE_URL` and runs the new `alloy` playbook on every node. Provisioning a node runs `alloy` too once monitoring exists.
- Alloy (`ALLOY_IMAGE`, default `grafana/alloy:v1.21.2`) runs in the `monitoring` compose profile. It sends host metrics, the AppView's metrics, Postgres metrics where a database runs, and on the main node probes of the PDS, labeled with the node and region. It also reads `.prom` files from `/var/lib/colibri/metrics`, where `deploy/observability/pgbackrest-age.sh` writes the last backup time.
- Grafana gets four dashboards (cluster, hosts, voice, Postgres). The hosts dashboard shows ingress and egress on public interfaces per node: totals for the selected range and the last 30 days, and daily bars. The cluster dashboard shows total ingress and egress. Alerts fire for a missing node, replication lag over 30 seconds, a backup older than 26 hours, a disk over 85% full, XRPC 5xx over 2% and read-only mode. With `ALERT_WEBHOOK_URL`, alerts go to that webhook.
- The AppView listens for metrics on `0.0.0.0` inside the node and main compose stacks. Node `.env` files carry `NODE_REGION`, and the database URLs in them escape the user and password.
