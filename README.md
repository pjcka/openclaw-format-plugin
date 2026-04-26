# Format channel plugin for OpenClaw

An in-process OpenClaw channel plugin that lets the gateway treat Format as a
first-class chat channel — same way it treats Slack, Discord, BlueBubbles, etc.

## What this does

- Subscribes to Supabase Realtime on `chat_messages` to pick up new user messages.
- Dispatches them into the OpenClaw agent pipeline via the public plugin SDK
  (`dispatchInboundMessage`), which waits natively through subagent delegation.
- Writes assistant replies back to Format's `chat_messages` via
  `outbound.attachedResults.sendText` and a cached Supabase service-role client.
- Writes status/stage/worker columns on `chat_threads` from the agent event
  stream (migration 039/040 surface).

## Installation

The gateway expects the plugin to live at `~/.openclaw/plugins/format/`.
Symlink it from this repo:

```sh
ln -s "$(pwd)/plugins/openclaw-format" ~/.openclaw/plugins/format
```

Then register in `~/.openclaw/openclaw.json` under `plugins.load.paths` +
`plugins.entries.format` + `channels.format.accounts.default`.

## Why this lives in Format's repo

The plugin is tightly coupled to Format's DB schema, migration numbers, and
tool contract. Co-locating means a schema change lands as a single PR, and the
plugin can ride the same CI/typecheck surfaces as Format. The plugin is
*excluded* from the Vercel deploy via `.vercelignore` — it's gateway-side only.

## Development

No build step. Edit `.ts` directly, restart gateway to pick up changes:

```sh
openclaw gateway restart
```

For safer iteration, use a dev gateway (isolated state + port):

```sh
openclaw --dev gateway
```

## Status

Shipped in PR #274 (April 2026).
