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
- ✅ **Codex-agent chips** ("a codex agent is running for this session") — SHIPPED
  via codex-job's existing status files (see "Codex-agent chips" below). The
  majority delegation path. NOT via the OpenClaw task runtime — that route turned
  out unsafe (see the rejected-approach note).

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

## Codex-agent chips (shipped)

**Finding:** Format delegates real work via the **`codex_job` tool** (a detached
`codex exec`), NOT `sessions_spawn` subagents — so `subagent_spawned` rarely
fires here. The codex_job tool hook only sees the ~5ms *dispatch*; the job then
runs detached and wakes main ~seconds–minutes later via a "System note from the
codex-job runner" turn. So a chip needs a real start+end lifecycle that OUTLIVES
the dispatch turn.

**Shipped design: reconcile codex-job's own status files (the source of truth
that already exists).** No OpenClaw task runtime, no cross-process coupling.

- **codex-job** (`~/.openclaw/plugins/codex-job`) already writes a per-job
  `status.json` (`state: starting|running|done|failed|killed`, pid, timestamps).
  One additive change: `createAndLaunch` now stamps `notifyChannel`/`notifyTarget`
  into `meta.json` so a reader can map a job back to its Format thread. BB +
  headless jobs are untouched (they carry a non-`format` channel and are ignored).
- **Format plugin** (`src/codex-chips.ts`) runs a light reconcile (4s) for the
  account's lifetime: read the `codex-jobs` dir, keep `format`-channel jobs in an
  active state whose launcher pid is alive, project each to an `active_workers`
  chip (`runtime: "codex"`), and clear it the tick after `status.json` goes
  terminal. Survives a gateway restart (status.json persists).
- **`src/active-workers.ts`** is a single composer for `chat_threads.active_workers`:
  the live subagent-chip path and the codex reconcile each own a named slice and
  the writer always persists their UNION (deduped). Without it, `endThreadStatus`'s
  `active_workers=[]` teardown would erase a codex chip while its job still ran.
- The Format UI already renders `active_workers` chips while a thread is idle
  (`pendingActive = showPending || workers.length > 0`) — no UI change needed.

**Rejected: register an OpenClaw `DetachedTaskLifecycleRuntime`.** Verified against
the installed dist: `api.registerDetachedTaskRuntime` is a SINGLE exclusive global
slot, and every core caller (subagent/acp/cron/native-harness) routes its task
lifecycle through it. Claiming the slot puts codex-job in the critical path of
BlueBubbles' own subagent/cron tasks, and there is no by-the-book way to delegate
the non-codex calls back to core (the default helpers live in per-release
hash-named internal modules with no `package.json` `exports` entry — the only
exposed factory is `createAgentHarnessTaskRuntime`). Same hallucinated-symbol
failure class as the original diagnostic-bus handoff. The file-reconcile is
simpler, BB-safe, and more robust (no "lost"-marking of stale runs). Trade-off
given up: codex jobs don't appear in `openclaw tasks` and `openclaw tasks cancel`
won't kill one (the `codex_job_stop` tool still does).

## Verification

- Unit: `npx vitest run` → 31/31.
- Load: gateway restart → format SUBSCRIBED, no `PluginLoadFailure`, hooks register once.
- Live: tool hooks fire for native-Codex parent calls with `ctx.sessionKey ===`
  the parent key (confirmed via a throwaway probe, since removed). Stage writes
  via `setStage` (the proven coarse-status writer). Fast tools (codex_job 5ms,
  image_generate 149ms) flash and revert — by design, acceptable.
