---
"@colibri-social/lexicons": minor
"@colibri-social/embeds": minor
"@colibri-social/appview": minor
---

Link previews carry more of what a page declares. `linkEmbed` gains `themeColor`, `layout`, `provider`, `author`, `publishedAt`, a `media` gallery and a `post` with formatted text, a content warning, engagement counts, a quoted post and the source language of a translation. The AppView reads `theme-color`, `twitter:card`, repeated `og:image` tags, the site icon and `article:published_time`, follows oEmbed links, resolves Mastodon statuses behind ActivityPub alternate links, and resolves X and fixer-domain post links through the FxEmbed API, honoring a trailing language code as a translation request.
