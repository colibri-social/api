---
"@colibri-social/appview": minor
---

Collect logs and table stats in Grafana. `monitoring deploy` now also starts Loki (`LOKI_IMAGE`, default `grafana/loki:3.7.9`) next to Prometheus, and Alloy on every node sends the logs of each Docker container there, labeled with `node`, `service` and `project`. Loki keeps 30 days. A new "Colibri logs" dashboard shows log volume, warnings and errors per node, and the log lines, filtered by node, service and a search term. The Postgres dashboard gains the message count, messages added in the last 24 hours, a table of every table with its rows, size, index size, dead rows, inserts and sequential scans, and charts for table sizes, writes and dead rows per table. The cluster dashboard layout follows the latest export.
