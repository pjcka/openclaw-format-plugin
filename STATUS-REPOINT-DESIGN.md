# Format plugin — live-status repoint (built + next steps)

> Revised 2026-06-13 after building + de-risking against the **live** OpenClaw
> 2026.6.6 install. The original handoff's core mechanism (a "trusted
> diagnostic bus" via `onTrustedInternalDiagnosticEvent`) was **wrong** — that
> symbol is exported from no public `plugin-sdk` subpath, so importing it would
> have thrown `PluginLoadFailureError` and taken the channel down on restart.
> The real blessed path is first-class **plugin hooks**. This doc records what
> shipped and the remaining Option B work.

## Status

- ✅ **Stage** ("Using <tool>") — SHIPPED. Tool hooks → `chat_threads.active_run_stage`.
- ✅ **Session chips** (real `sessions_spawn` subagents) — SHIPPED. Cheap; rarely
  fires in Format (delegation goes through `codex_job`, not subagents — see below).
- ⏳ **Codex-agent chips** ("a codex agent is running for this session") — Option B
  below. The majority delegation path; not yet built.

## What shipped

Driven by OpenClaw's first-class plugin hooks (NOT the diagnostic bus, NOT the
removed `:8766` ACP worker board, NOT the native-Codex-suppressed
`onToolStart`/`onItemEvent` reply hooks):

| Signal | Hook | Write |
|---|---|---|
| Stage | `before_tool_call` / `after_tool_call` | `setStage(active_run_stage)` |
| Session chips | `subagent_spawned` / `subagent_ended` | `setActiveWorkers(active_workers)` |

- **`src/agent-events.ts`** (new, replaces `workers-poller.ts`): pure derivation
  (`parseFormatParentThreadId`, `normalizeToolName`, `subagentThreadId`,
  `ThreadStage`, `ThreadChips`) — unit-tested in `tests/unit/agent-events.test.ts`
  (20 tests) — plus thin live glue: `registerStatusEventHooks(api)` (one-time,
  guarded), `beginThreadStatus`/`endThreadStatus` (per-turn registry).
- **`index.ts`**: hooks attach via `defineChannelPluginEntry({ …, registerFull })`
  → inside, `api.on('<hook>', (event, ctx) => …)`. `registerFull` runs AFTER
  `api.registerChannel`, so it can't disturb the coarse status surface.
- **`src/inbound.ts`**: deleted the dead poller + suppressed reply hooks;
  `beginThreadStatus` at turn start, `endThreadStatus` in `finally`.
  `setRunning`/heartbeat/cancel-watcher/`setIdle`/`setFailed` untouched.
- **`src/status.ts`**: UNCHANGED. **Deleted** `src/workers-poller.ts`.

### Mechanism facts (verified against installed 2026.6.6)

- **`api.on(hookName, (event, ctx) => …)`** is the typed-hook registrar
  (`registry.ts#registerTypedHook`). `api.registerHook` is a different
  (internal/legacy) bus — don't use it for these.
- **The parent thread key is on `ctx`, not the event.** Tool hooks:
  `ctx.sessionKey === "agent:main:format:direct:<threadId>"` (exact-match scopes
  to the parent; a subagent's own tool calls carry the subagent key and are
  excluded). `ctx.channelId` also carries the bare threadId. Events carry
  `toolName`, `toolCallId`, `durationMs`.
- **Plugin tools fire the hook twice under two names** (`openclaw<x>` + `<x>`,
  same `toolCallId`) → dedupe/count by `toolCallId`, strip the `openclaw` prefix
  for display. Core tools (`exec`, `message`) fire once.
- `before_tool_call`/`after_tool_call`/`subagent_spawned`/`subagent_ended` are
  **unrestricted** observation hooks (not conversation/prompt-injection) → no
  `plugins.entries.format.hooks` policy opt-in needed.
- **Plugin `console.warn`/`console.error` vanish** (launchd routes the gateway's
  stderr to `/dev/null`; only `console.log` → `gateway.log`). status.ts's own
  `console.warn` error paths are effectively silent — a latent observability bug.

## Option B — codex-agent chips (next, by-the-book)

**Finding:** Format delegates real work via the **`codex_job` tool** (a detached
`codex exec`), NOT `sessions_spawn` subagents — so `subagent_spawned` rarely
fires here. The codex_job tool hook only sees the ~5ms *dispatch*; the job then
runs detached and wakes main ~seconds–minutes later via a "System note from the
codex-job runner" turn. So a chip needs a real start+end lifecycle.

**Chosen design (most by-the-book): route codex_job through OpenClaw's own
detached-task runtime.**

- **codex-job plugin** (`~/.openclaw/plugins/codex-job`, openclaw-ops scope)
  registers via `api.registerDetachedTaskRuntime(runtime: DetachedTaskLifecycleRuntime)`:
  - `createRunningTaskRun({ requesterSessionKey: <originating>, label, runId, runtime })` at launch.
  - `completeTaskRunByRunId` / `failTaskRunByRunId` at the completion wake.
  - `cancelDetachedTaskRunById` ← wire `codex_job_stop`.
  - `tryRecoverTaskBeforeMarkLost` ← answer liveness from the existing `status.json`/pid.
    This is the platform's own solution to the out-of-process completion boundary —
    no custom Format poll of private files.
- **Format (and BB)** read chips via `api.runtime.tasks.runs.bindSession({sessionKey: parentKey}).list()`
  filtered to `status: "running"` → channel-agnostic, BB gets it for free.
  (Start can flip instantly off the `before_tool_call(codex_job)` hook; the
  `.list()` reconcile handles end.)
- Bonus: codex_job jobs become visible in `openclaw tasks` + gain platform cancel.

**Cost / risk:** a codex-job refactor (it serves the live BB surface → needs its
own BB-safe verification). codex-job already holds all required state
(`status.json`, pid) to implement the contract.

## Verification

- Unit: `npx vitest run` → 31/31.
- Load: gateway restart → format SUBSCRIBED, no `PluginLoadFailure`, hooks register once.
- Live: tool hooks fire for native-Codex parent calls with `ctx.sessionKey ===`
  the parent key (confirmed via a throwaway probe, since removed). Stage writes
  via `setStage` (the proven coarse-status writer). Fast tools (codex_job 5ms,
  image_generate 149ms) flash and revert — by design, acceptable.
