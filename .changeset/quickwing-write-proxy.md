---
"@colibri-social/appview": minor
---

Send writes from sub nodes to the main node.

- A node with the `api` role that doesn't hold the main role forwards every XRPC procedure to the main node over the tailnet, with the caller's headers and body and its own node ID and secret. The main node accepts forwarded writes on `CLUSTER_PORT` from known nodes only and answers them as if they came in directly. A forwarded write the main node may already have applied is never sent twice: a failure after sending answers `502 UpstreamFailure`.
- When the main node can't be reached, writes wait and go out in arrival order once it is back. After `WRITE_QUEUE_SECONDS` (default 90) a waiting write fails with `503 ReadOnly`, and the node refuses writes the same way until a ping to the main node succeeds again. A node that is no longer main sends the caller on to the current one.
- Event sockets get a `writeState` frame on connect and on every change between `normal`, `queued` and `readOnly`.
- The main node answers `GET /cluster/ping` on `CLUSTER_PORT` while it holds the main role.
