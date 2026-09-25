# @colibri-social/bridge-discord

The Discord connector for [`@colibri-social/bridge-core`](../bridge-core). It relays messages,
replies, attachments, forwards, edits, deletions, reactions, mentions and public threads
between Discord channels and Colibri channels, and imports a channel's earlier history when an
admin asks for it. Colibri users appear in Discord through a
webhook per channel, with their own name and avatar.

```sh
npm install @colibri-social/bridge-core @colibri-social/bridge-discord
```

```ts
import { DiscordConnector } from "@colibri-social/bridge-discord";

const connector = new DiscordConnector({ token: process.env.DISCORD_TOKEN! });
```

The bot needs the Message Content privileged intent. In each relayed channel it needs View
Channel, Send Messages, Read Message History, Manage Webhooks, Add Reactions, Create Public
Threads, Send Messages in Threads and Manage Threads. Moderation mirroring also needs Manage
Messages. Server admins pair it with `/colibri connect`.

- [Pairing a Bridge](https://colibri.social/docs/bridges/pairing)
- [Building a Bridge](https://colibri.social/docs/bridges/building-a-bridge)
