# @colibri-social/space-sync

Keeps a local, up-to-date copy of an atproto permissioned space.

## Push and sweep

`SpaceSyncEngine` runs both:

- **Push.** `registerNotify` subscribes this service on the space host. When a
  member writes, their host tells the authority, which forwards to registered
  syncers. `notifyWrite(space, repo)` enqueues that repo
- **Sweep.** Every `sweepIntervalMs`, `listRepos` gives the authority's view of
  the writer set with each repo's revision. Anything ahead of our cursor is
  enqueued, and anything that has disappeared is dropped

## Fail handling

A repo that fails records `consecutiveFailures` and a `retryAfter`, backing off
exponentially to an hour. The sweep skips a repo that is still backing off.

|                                                           |                                          |
| --------------------------------------------------------- | ---------------------------------------- |
| the host no longer retains our `since` revision           | full recovery from the CAR               |
| the account is gone, taken down, suspended or deactivated | drop the repo                            |
| the set hash disagrees with a verified commit             | full recovery                            |
| the authority says the space is deleted                   | drop the space and forget the credential |
| anything else                                             | back off and retry, keeping the copy     |

Treating an outage as a deletion would throw away a correct copy, so an
unrecognised error is never allowed to mean "gone".

## Seeing it in context

Colibri's own write-up of this algorithm is in
[the docs](https://colibri.social/docs/architecture/sync).
