---
"@colibri-social/admin": minor
"@colibri-social/appview": minor
---

Post incidents and schedule maintenance on the status page from `colibri-admin`.

- `colibri-admin status` opens a menu built on `@clack/prompts` to browse nodes, open incidents, post updates, resolve them, and schedule or end maintenance.
- `status incident list [--all]`, `create <title> [--message] [--style]`, `update <id> <message> [--title] [--style]` and `resolve <id> [<message>]` work on the `KUMA_STATUS_SLUG` page. Each update goes on top of the incident's text with its UTC time.
- `status maintenance list`, `schedule <title> --start --end [--nodes] [--message]` and `end <id>` manage one-off maintenance windows. They show on the status page and mark the named nodes' monitors. Times take `now`, `+30m`, `+2h`, `+1d` or an ISO date.
- The Uptime Kuma client in `@colibri-social/appview/cluster` reads, posts, edits and resolves incidents and adds, lists and ends maintenance.
