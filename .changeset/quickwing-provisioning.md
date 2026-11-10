---
"@colibri-social/appview": minor
"@colibri-social/admin": minor
---

Provision cluster nodes with Ansible and publish the AppView image.

- Every push to `main` publishes `ghcr.io/colibri-social/api:edge` and `sha-<commit>`. A push that changes the `@colibri-social/appview` version also publishes the version tag and `stable`.
- The image carries `ansible-core`, `openssh-client`, the playbooks in `deploy/ansible` and `colibri-admin` on the `PATH`.
- `colibri-admin node add <id> --region --roles --public-url --ip [--workers]` has the main node bootstrap the server over SSH: Docker, Tailscale, a firewall, Caddy with Let's Encrypt, the AppView and, for sub and failover nodes, a streaming Postgres replica. The node joins with a one-time token. Without `--ip`, `node add` prints the settings for a manual setup.
- `colibri-admin node recover <id>` restarts a node's stack. `node remove <id>` runs the remove playbook over the tailnet, then forgets the node.
- The main node needs `TAILSCALE_AUTH_KEY`, `POSTGRES_REPLICATION_PASSWORD` and an SSH key at `SSH_KEY_FILE` to provision. `NODE_IMAGE`, `SSH_USER`, `ANSIBLE_DIR`, `REGISTRY_USER` and `REGISTRY_TOKEN` are optional. Ansible runs one playbook at a time and logs every line.
- `docker-compose.scaled.yml` runs a main node: the Postgres primary with replication, the AppView with the main role and Caddy. Its `local-cluster` profile adds a replica, a sub node and a voice node for testing on one machine.
- `docker-compose.yml` pulls `ghcr.io/colibri-social/api:stable` and gains an opt-in `updater` profile that keeps a single AppView on the newest stable image.
- `colibri-admin config import -` reads the env file from standard input.
