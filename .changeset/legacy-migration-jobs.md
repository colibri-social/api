---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/community": minor
---

Run legacy community migrations as resumable background jobs that copy bans, serve legacy message history read-only in the migrated channels, mark that history as read for every member and retire the legacy community record when done. A community whose account this AppView can't sign in to moves into a newly provisioned account built from its public records, and its legacy record stays as it is
