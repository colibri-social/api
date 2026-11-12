---
"@colibri-social/appview": patch
---

Redeploy monitoring when it changes. Each time the main node takes the main role, it compares a hash of `deploy/observability`, the monitoring templates and playbooks, the Grafana password, `ALERT_WEBHOOK_URL` and the monitoring images with the last deploy, and runs `monitoring deploy` again for the Prometheus node when they differ. New dashboards, alert rules and webhook URLs reach Grafana after a release without running the command by hand.
