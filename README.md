# Format channel plugin for OpenClaw

An in-process OpenClaw channel plugin that lets the gateway treat Format as a
first-class chat channel — same way it treats Slack, Discord, BlueBubbles, etc.
Replaces the out-of-tree HTTP bridge at `../../scripts/openclaw-bridge.mjs`.

## What this does

- Subscribes to Supabase Realtime on `chat_messages` to pick up new user
  messages (replacing the bridge's Realtime subscription).
- Dispatches them into the OpenClaw agent pipeline via the public plugin SDK
  (`dispatchInboundMessage`). Critically, this waits natively through subagent
  delegation — unlike the bridge's `/v1/chat/completions` call, which returned
  with empty payloads and surfaced the literal string
  `"No response from OpenClaw."` as the assistant reply.
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
`plugins.entries.format` + `channels.format.accounts.default`. See the plan
doc at `docs/reference/openclaw-channel-plugin-plan.md` for the exact snippet.

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

Shipped — phases 1–5 landed in PR #274 (April 2026). Cutover commit
`e35c2cc`; the deprecated `scripts/openclaw-bridge.mjs` is scheduled for
deletion on 2026-04-28 after the stability window closes. Implementation
notes in `docs/reference/openclaw-channel-plugin-plan.md` and
`docs/reference/openclaw-channel-plugin-migration.md`.
