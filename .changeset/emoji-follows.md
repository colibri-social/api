---
"@colibri-social/lexicons": minor
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/projections": minor
"@colibri-social/emoji": minor
---

Users can follow a custom emoji pack or a single custom emoji. A follow is a private `social.colibri.beta.emoji.follow` record in the user's preferences space that points at the owner's pack or emoji, so renames, new images and pack membership changes reach followers.

- `emoji.putFollow` pushes a follow record to the AppView, and a call without `subject` removes it.
- `emoji.getLibrary` returns the user's own emoji plus everything they follow, each with an `available`, `missing` or `unreachable` state.
- `emojiLibraryEvent` carries the whole library to a user's connections when their own emoji change, their follows change, or the owner of something they follow changes their emoji. It replaces `emojiEvent` for a user's own emoji, and `emojiEvent` now only covers community emoji.
- `emojiView` no longer has `copyOf`.
- The account permission set covers the follow record, `emoji.putFollow` and `emoji.getLibrary`, so existing sessions ask for consent again on their next sign-in.
