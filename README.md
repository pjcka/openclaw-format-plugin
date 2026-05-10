# Format channel plugin for OpenClaw

An in-process [OpenClaw](https://github.com/anthropics/openclaw) channel plugin that lets the gateway treat [Format](https://github.com/pjcka/format) (a SvelteKit document editor) as a first-class chat channel — same way it treats Slack, Discord, BlueBubbles, etc.

## What it does

- Subscribes to Supabase Realtime on `chat_messages` to pick up new user messages from a Format instance.
- Dispatches them into the OpenClaw agent pipeline via the public plugin SDK (`dispatchInboundMessage`).
- Writes assistant replies back to Format's `chat_messages` table.
- Tracks status / stage / active workers / heartbeat on `chat_threads` from the agent event stream.

## Schema contract

This plugin reads and writes specific columns on Format's Supabase tables. Format owns the schema; this plugin assumes the following migrations have been applied:

| Migration | Provides |
|---|---|
| 030 | `resolve_user_id_by_inbound_secret` RPC (auth primitive) |
| 039 | `chat_threads.status`, `.active_run_started_at`, `.active_run_stage`, `.active_doc_id` |
| 040 | `chat_threads.active_workers` JSONB column |
| 041 | `chat_threads.last_heartbeat_at` |

Tables it touches:

- `chat_messages` — Realtime subscribe (role=user filter), insert assistant replies, atomic claim via `status='pending'` → `'delivered'` predicate
- `chat_threads` — status / stage / active_workers / heartbeat writes; service-role queries always filtered by user_id

If Format changes any of these column shapes or the RPC signature, this plugin will break. Open an issue here and pin a compatible plugin commit.

## Installation

The OpenClaw gateway expects a symlink at `~/.openclaw/plugins/format/`:

```sh
git clone https://github.com/pjcka/openclaw-format-plugin.git ~/dev/openclaw-format-plugin
cd ~/dev/openclaw-format-plugin && npm install
ln -s ~/dev/openclaw-format-plugin ~/.openclaw/plugins/format
```

Then register in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": { "paths": ["/Users/you/.openclaw/plugins/format"] },
    "entries": { "format": { "enabled": true, "config": {} } }
  },
  "channels": {
    "format": {
      "enabled": true,
      "defaultAccount": "default",
      "accounts": {
        "default": {
          "supabaseUrl": "https://<project>.supabase.co",
          "supabaseServiceRole": "<service-role-key>",
          "formatUrl": "https://<your-format-deploy>",
          "inboundWebhookSecret": "<secret-stored-in-format-user_llm_config>"
        }
      }
    }
  }
}
```

Restart the gateway: `openclaw gateway restart`. The log line `[format:default] starting Realtime + safety-poll dispatcher` confirms the plugin loaded.

## Development

No build step. Edit `.ts` directly, restart gateway to pick up changes:

```sh
openclaw gateway restart
```

For safer iteration, use a dev gateway (isolated state + port):

```sh
openclaw --dev gateway
```

## Tests

```sh
npm run test
```

Covers the path-traversal containment guard and base64 inlining behavior in `src/outbound.ts`. Tests don't exercise the OpenClaw SDK paths (`inbound.ts`, `plugin.ts`) — those are runtime-loaded by the gateway and only typecheck within the gateway environment.

## History

Shipped in [pjcka/format#274](https://github.com/pjcka/format/pull/274) (April 2026). Extracted to its own repo on 2026-05-09 to decouple the plugin's release cadence from Format's PR cycle.
