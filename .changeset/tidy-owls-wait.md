---
"@colibri-social/bridge-core": patch
"@colibri-social/bridge": patch
"@colibri-social/space-sync": patch
"@colibri-social/appview": patch
---

Stop bridges from posting old Colibri messages again. Bridges match their stored messages and threads under both space URI formats, send nothing for an edit of a message they never sent, and skip new messages older than a day. The AppView no longer streams or notifies messages older than a day that a repo recovery picks up.
