---
"@colibri-social/lexicons": minor
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/community": minor
"@colibri-social/space": minor
---

Let owners host a community on an account of their own through OAuth, and move a community account off this AppView's PDS. `social.colibri.beta.community.authorizeHost` starts a sign-in as the community account, which adopts it as a new community or reconnects an existing one, and `getHostAuthorization` reports the outcome. `getHosting` tells administrators where the account lives and whether the AppView needs a new sign-in. `handOverHost` sets the owner's email on an account this AppView hosts and returns a new password that works for 60 minutes, after which the AppView replaces it unless the account moved. A community whose account moved to another server asks for a sign-in again, and its password is no longer reset on this AppView's PDS. Host sign-in needs `HOST_OAUTH_PRIVATE_KEY`, and `HOST_OAUTH_RETURN_URL` sets where the browser lands afterwards. The permission set for managing communities includes the four new methods.
