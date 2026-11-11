---
"@colibri-social/appview": minor
"@colibri-social/admin": minor
---

Run the status page on Uptime Kuma and keep its monitors in step with the cluster.

- `colibri-admin status deploy <node>` runs the new `uptime-kuma` playbook on a node. It starts Uptime Kuma (`KUMA_IMAGE`, default `louislam/uptime-kuma:2.5.7-slim`) on the node's tailnet address and serves `KUMA_PUBLIC_URL` through the node's Caddy, with the dashboard, settings and socket paths answering 404. With Cloudflare set up, the status host gets a CNAME to the node.
- With `KUMA_URL`, `KUMA_USERNAME` and `KUMA_PASSWORD`, the main node keeps an HTTP monitor on `/health` for the API host and every node that isn't retired. Nodes in maintenance or draining are paused, monitors of retired nodes are deleted, and other monitors are left alone. On a fresh Kuma it creates the account first.
- The `KUMA_STATUS_SLUG` status page (default `colibri`) lists the API, then one group per region, styled with `deploy/uptime-kuma/status.css`.
- Caddy on every node, and on the main node in `docker-compose.scaled.yml`, imports extra sites from `caddy-sites/`. The scaled stack's Caddy reads `deploy/caddy/Caddyfile`.
