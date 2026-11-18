# @colibri-social/bridge-core

Connects a Colibri Space to another chat service. It handles the Colibri side of a
bridge: service auth, the AppView event stream, message mapping, echo suppression, and
conversion between Markdown and Colibri facets. You write a connector for the other service.

```sh
npm install @colibri-social/bridge-core
```

## Documentation

- [Bridges](https://colibri.social/docs/users/bridges): what a bridge does and how bridged messages appear
- [Pairing a Bridge](https://colibri.social/docs/users/bridges/pairing): connect a bridge to a Space and link channels
- [Building a Bridge](https://colibri.social/docs/developers/bridges/building-a-bridge): write and run a connector
- [Bridge Reference](https://colibri.social/docs/developers/bridges/reference): every method, field, limit and error

`packages/bridge-discord` and `apps/bridge` in this repository hold the hosted Colibri
bridge, built on this package.
