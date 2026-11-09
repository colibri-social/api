---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
---

Register AppView nodes and link them to the main node.

- An AppView with `NODE_ID` set is a cluster node. It registers itself in `nodes` with its region, roles, `NODE_PUBLIC_URL` and `NODE_TAILNET_URL`, heartbeats every 15 seconds with its connection and call counts, and is marked `draining` and then `down` when it stops.
- Nodes with the `main` or `failover` role listen on `CLUSTER_PORT` (default 3100) for joins and control links. Only the node holding the main lock accepts them.
- A new node trades a `CLUSTER_JOIN_TOKEN` (valid for an hour, used once) for a node secret, kept in `NODE_SECRET_FILE`. Nodes without the `main` role hold a WebSocket control link to the main node with that secret and reconnect when it drops.
- The main node handles shutdown and resume orders from the event bus. A shutdown checks the quorum floor (50% of 2, 66% of 3, 75% of 4, 80% of 5 or more nodes staying up) unless forced, then tells the node to drain. A drained node parks in `maintenance` or `retired`, answers every request with 503 and stays parked across restarts until it is resumed.
- `social.colibri.beta.server.listNodes` lists active nodes that serve clients, with a `/health` probe URL. `describeServer` advertises the `nodes` feature on a clustered AppView.
- `nodes` gains `secret_hash`.
