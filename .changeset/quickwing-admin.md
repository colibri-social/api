---
"@colibri-social/appview": minor
"@colibri-social/admin": minor
---

Add `colibri-admin` and share settings across AppView nodes.

- `colibri-admin` ships in the AppView image. Run it inside the main node's container: `node list`, `node add <id> --region --roles [--public-url]`, `node shutdown <id> --maintenance|--retire [--grace 15m] [--force]`, `node resume <id>`, `node remove <id> [--force]`, `rollout pause|resume`, and `config list|set|unset|import`. It exits with 1 when the main node refuses and 2 on a usage error.
- Shutdown and resume orders travel over the event bus to the main node, which answers within 30 seconds. They need the Postgres setup.
- Shared settings live in `cluster_config`, encrypted with `CREDENTIAL_ENCRYPTION_KEY`. Settings that describe a single node, such as `NODE_ID`, `ROLES`, `DATABASE_READ_URL` or `SFU_ANNOUNCED_IP`, stay local and are refused. `config import` reads an env file and stores only the shared settings.
- A node with `MAIN_NODE_URL` fetches the shared settings from the main node before it loads its configuration, along with its ID, region and roles from the registry. Its own environment wins. When `MAIN_NODE_URL` points at a node that is no longer main, it follows that node to the current one. It retries for two minutes, then exits.
- The node secret file now holds the node ID next to the secret.
- `@colibri-social/appview/cluster` exports the registry, config store, orders and event bus for the CLI.
