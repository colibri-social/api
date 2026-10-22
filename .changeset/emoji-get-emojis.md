---
"@colibri-social/lexicons": minor
"@colibri-social/appview": minor
---

Add `social.colibri.beta.emoji.getEmojis`, which returns up to 100 custom emoji by record URI across any number of repos in one request. Owners whose repo can't be read come back in `unreachable`. The method joins the `permissionCommunity` permission set next to `getCatalog`.
