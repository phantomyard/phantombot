# Adding a channel

A channel adapter listens for incoming chat messages on some platform and sends outgoing messages back. Adding one means writing a class that implements the `ChannelAdapter` interface in `src/channels/types.ts`.

## Recipe

1. **Pick a name.** `telegram`, `signal`, `googlechat`, `discord`, `whatsapp`, etc.

2. **Decide poll vs push.**
   - **Long-poll** (Telegram default `getUpdates`): the adapter's `start()` runs a loop calling the platform API repeatedly. Simple. No webhook plumbing. Costs one open HTTP connection.
   - **Webhook**: phantombot exposes an HTTP endpoint, the platform POSTs incoming messages. Requires a public URL (reverse proxy, ngrok, or running phantombot itself behind nginx). Lower latency and cheaper at scale.

   Default: long-poll where the platform supports it. It's one less moving part.

3. **Add the adapter file** `src/channels/<name>.ts`. Shape:

   ```ts
   export class FooChannel implements ChannelAdapter {
     id = 'foo';

     async start(handler: IncomingHandler): Promise<void> {
       // open the connection / start the poll loop / register the webhook
       // call handler() for every IncomingMessage
     }

     async stop(): Promise<void> {
       // graceful shutdown
     }

     async send(msg: OutgoingMessage): Promise<void> {
       // post the reply back to the platform
     }
   }
   ```

4. **Document its env vars** in `.env.example`. Standard slots:
   - One token / API key
   - One service URL or account identifier
   - Optional `<NAME>_DISABLED=true` so users can keep credentials in `.env` without activating the channel

5. **Register the channel** in `src/index.ts`'s channel registry, gated on its config being present.

## Conversation IDs

Every `IncomingMessage` must carry a `conversationId` that's stable across turns of the same conversation:

| Channel | Suggested ID format |
|---------|--------------------|
| Telegram | `telegram:<chat_id>` (use `chat_id` not `from.id` so groups work) |
| Signal | `signal:<groupId or sourceNumber>` |
| Google Chat | `gchat:<space.name>` |

The orchestrator uses this for memory keying and (eventually) for harness session continuity. Don't include sender info — multi-user group chats share one conversation.

## Streaming replies

If the platform supports message editing (Telegram does, Signal kind of doesn't, Google Chat does for cards), the adapter *can* expose live updates so the orchestrator can edit a "🤔 …" placeholder as the harness streams. This is optional. The adapter interface will eventually grow a `sendStreaming()` method; for now, channels just `send()` once with the final reply.

## Channel-specific quirks worth documenting

- **Telegram supergroup migration.** When you enable topics on a group, Telegram renumbers it with a `-100` prefix and the original chat_id stops working. Watch for `chat_migrated_to_chat_id` updates.
- **Signal-cli daemon.** Heavy on memory. Restart it weekly via cron if it leaks (this was a problem on the OpenClaw server).
- **Google Chat scope.** Service-account auth has different scopes for DMs vs. spaces vs. cards. Read the API docs once and write down what scopes you actually need.

## What the adapter should NOT do

- Decide which agent handles the message. That's the router's job.
- Build the system prompt. That's the persona builder's job.
- Call a harness directly. That's the orchestrator's job.

The adapter's only job is the platform-specific I/O. Keep it small.
