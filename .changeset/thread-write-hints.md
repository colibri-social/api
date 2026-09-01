---
"@colibri-social/appview": patch
---

Honour a write hint for any space the writer can read rather than only one it is subscribed to, so a message written into a thread nobody is watching is picked up at once, and announce a retracted move to both spaces so the message returns to its channel and leaves the thread without a reload
