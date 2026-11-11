---
"@colibri-social/appview": minor
---

Hand the main role to the failover node during updates and outages.

- Nodes with the `main` role always try for the main lock on the Postgres primary. Nodes with the `failover` role stay back while a `main` node answers the new `GET /cluster/alive` on `CLUSTER_PORT` and isn't draining. They take the lock when no `main` node answers or all of them drain, when the main node hands the role over with the new `takeMain` control frame, or when a live `main` node hasn't claimed the role for 30 seconds.
- A failover node holding the main role hands it back once a node with the `main` role has been active on the same version for 2 minutes.
- The rollout no longer restarts the main node in place when a failover node already runs the new version. The main node pulls the image, hands the main role to that node, waits up to 60 seconds for it to take over, then restarts. Sub nodes hold writes for the seconds of the handover. If nobody takes over, the main node keeps the role and the rollout pauses.
- A node with the `main` role issues its own node secret on its first start, so it forwards writes and keeps a control link like any other node while another node is main. A node only forwards writes while it isn't main.
- Main and failover nodes run Ansible, Cloudflare and Uptime Kuma syncs only while they hold the main role, and only when `SSH_KEY_FILE` exists for Ansible.
- A draining node stops trying for the main lock.
