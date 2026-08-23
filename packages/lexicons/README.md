# @colibri-social/lexicons

Every Colibri Social schema, the space type declarations, and the TypeScript generated
from them.

## Layout

- `lexicons/social/colibri/**`: Colibri's own schemas
- `lexicons/com/atproto/{space,simplespace}/**`: vendored from `bluesky-social/atproto`,
  pinned to one commit. See the README in that directory. Do not edit them!
- `src/generated/**`: produced by `pnpm codegen`, verified by CI

## Space types

Seven, each a lexicon whose `main` is `"type": "space"`. The `name` field is
what an OAuth consent screen shows a user, so it is written for people, not
developers. Which space holds what is at
[the docs](https://colibri.social/docs/architecture/communities#six-spaces).

A channel is a space. The space key is the channel's identity and its
configuration is the record at key `self` inside it, which is why the channel
record carries no community or category field.

## Conventions the test enforces

`src/conformance.test.ts` fails the build on any of these:

- a document whose `id` does not match its path
- a reference that does not resolve, uses the legacy `lex:` prefix, or spells out
  its own document instead of using `#name`
- a method with no declared errors, an error that is not PascalCase, or an error
  with no description
- a `limit` parameter that is not an integer with a minimum and a default, or an
  output that marks `cursor` required
- a definition or property with no description
- an em dash or a semicolon in any description
- a space type listing a collection that is not a defined record, or with no
  consent-screen name
- a permission set naming a method or space type that does not exist
- a method not covered by any permission set, which is what stops a new
  endpoint shipping that no client can be granted

## Commands

```sh
pnpm --filter @colibri-social/lexicons codegen
```
