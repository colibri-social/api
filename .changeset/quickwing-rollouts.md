---
"@colibri-social/appview": minor
---

Roll out new images across the cluster and keep Cloudflare in step with the registry.

- The main node checks `NODE_IMAGE` every `UPDATE_POLL_MINUTES` (default 15, `0` turns it off) and reads the version from the image's `org.opencontainers.image.version` label. Nodes on an older version update one at a time: sub nodes, then the failover node, then the main node. Each pulls the image pinned by digest, drains while the quorum floor holds, restarts and must report the new version within 10 minutes. A failed step pauses rollouts. The main node restarts itself in place from `STACK_DIR` (default `/opt/colibri`).
- Drain orders take a new `update` mode. A node drained for an update answers 503 until it restarts, and restarts on its current image after 15 minutes without one.
- With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID`, provisioning a node creates a DNS-only A record for its public host and removing it deletes the record. Records the main node didn't create are left alone.
- With `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_LB_ID`, the main node keeps one pool per region of `api` nodes, a `/health` monitor and geo steering on that load balancer every minute. `CLOUDFLARE_GEO_REGIONS` maps regions to Cloudflare region codes.
- The `update` playbook takes `pull_only` and `stack_dir`.
