# @colibri-social/space

A client for atproto permissioned spaces: `com.atproto.space` and
`com.atproto.simplespace`, plus the classic PDS calls an application needs
alongside them.

`@atproto/space` covers verification, commits and the token formats. This covers
the layer above: obtaining credentials and talking to hosts.

> Tracks the spaces alpha, pinned to a `0.0.0-spaces-alpha-*` build

## Getting a credential

Reading a space needs a space credential issued by the space authority, which is
retrieved as follows:

1. A **delegation token** is minted by a _user's_ PDS. It is single-use, lives 60
   seconds, and is addressed to the space authority
2. That token is presented to the **authority** in exchange for a credential,
   with a DPoP proof that binds the credential to a key this process holds
3. The credential is presented to **each repo host** in the space, with a fresh
   DPoP proof naming that host

`SpaceCredentials` runs steps 2 and 3 and caches the result. Step 1 is not handled
because you need a session to create a delegation token.

```ts
const credentials = new SpaceCredentials({
  hosts: new DidDocumentSpaceHostResolver(),
  delegation: async (space) => mintDelegationTokenSomehow(space),
  storage: myStorage,
})

const client = new SpaceClient({ hosts, credentials })
for await (const repo of client.allRepos(space)) { ... }
```

- A **delegation token** is presented as `Authorization: Bearer <token>` with a
  `DPoP` proof that carries **no** `ath` claim, because it is an authorization
  grant
- A **space credential** is presented as `Authorization: DPoP <credential>` with
  a proof that **does** carry `ath`

## Addressing

A space is `(authority, type, skey)`:

```
at://{authority}/space/{spaceType}/{skey}
```

A record inside one is addressed by the author as well, because record keys are
unique per repo and a space aggregates many repos:

```
at://{authority}/space/{spaceType}/{skey}/{author}/{collection}/{rkey}
```

`spaceRef`, `parseSpaceRef`, `spaceRecordUri` and `parseSpaceRecordUri` build and
read both forms and validate their parts.

## What is in here

| Module         |                                                                           |
| -------------- | ------------------------------------------------------------------------- |
| `space-ref`    | building and parsing space and record references                          |
| `dpop`         | DPoP keys and proofs, exportable so a credential survives a restart       |
| `credentials`  | the delegation-to-credential exchange, cached and deduplicated            |
| `host`         | resolving `#atproto_space_host`, falling back to `#atproto_pds`           |
| `space-client` | the `com.atproto.space.*` read and sync surface                           |
| `pds`          | sessions, space writes, `simplespace` management, and the admin calls     |
| `repo`         | commit verification, CAR reading and LtHash helpers over `@atproto/space` |
| `http`         | a small XRPC client with the four authentication schemes these need       |

## Seeing it in context

Colibri's own write-up of the credential flow is in
[the docs](https://colibri.social/docs/architecture/spaces#getting-a-credential).
