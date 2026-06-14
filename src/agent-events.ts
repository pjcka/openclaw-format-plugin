// Live-status derivation for the Format chat surface, driven by OpenClaw's
// first-class plugin hooks (before_tool_call / after_tool_call → the "Using
// <tool>" stage; subagent_spawned / subagent_ended → worker chips). Replaces
// the dead workers-poller.ts (the :8766 ACP worker board was removed in
// 2026.6.6) and the suppressed onToolStart/onItemEvent reply hooks (native
// Codex routes tool progress through hooks, not the channel progress path).
//
// This file is split into PURE derivation logic (unit-tested in
// tests/unit/agent-events.test.ts) and thin hook/Supabase glue (verified live
// in the gateway — mocking the whole plugin api + Supabase would test the mock,
// not the behavior).

import type { SupabaseClient } from '@supabase/supabase-js';
import { setStage, type ActiveWorker } from './status.ts';
import { writeSubagentChips } from './active-workers.ts';

// ── Pure derivation ──────────────────────────────────────────────────────────

// A Format parent session key is exactly `agent:<agent>:format:direct:<threadId>`
// (5 colon-parts; threadId is a UUID with no colon). Subagent keys carry extra
// `:subagent:…` segments and so fail the exact-length check — that's how a
// subagent's own tool calls are kept from moving the PARENT thread's stage.
export function parseFormatParentThreadId(sessionKey: string | undefined): string | null {
	if (!sessionKey) return null;
	const parts = sessionKey.split(':');
	if (parts.length !== 5) return null;
	if (parts[0] !== 'agent' || parts[2] !== 'format' || parts[3] !== 'direct') return null;
	return parts[4] || null;
}

// Plugin-namespaced tools fire the hook twice for one call — under both
// `openclaw<name>` and `<name>` (same toolCallId). Strip the prefix so both
// collapse to one display label. Core tools (exec, message) are unaffected.
export function normalizeToolName(raw: string | undefined): string | null {
	if (!raw) return null;
	const stripped = raw.startsWith('openclaw') ? raw.slice('openclaw'.length) : raw;
	return stripped || null;
}

// Route a subagent event back to the Format thread that requested it. Prefer
// the explicit requester.{channel,threadId} (only when channel is "format", so
// a BlueBubbles subagent never lands on a Format thread); fall back to the
// parent key on ctx.requesterSessionKey. subagent_ended carries no requester,
// so callers usually resolve it via the childSessionKey→thread map instead.
export function subagentThreadId(
	event: { requester?: { channel?: string; threadId?: string | number } } | undefined,
	ctx: { requesterSessionKey?: string } | undefined
): string | null {
	const r = event?.requester;
	if (r?.channel === 'format' && r.threadId != null) return String(r.threadId);
	return parseFormatParentThreadId(ctx?.requesterSessionKey);
}

// Per-thread in-flight tools keyed by toolCallId (so the dual-name fire counts
// once). The displayed stage is the most-recently-started in-flight tool, or
// "Thinking" when none is running.
export class ThreadStage {
	private inFlight = new Map<string, string>(); // toolCallId -> display name

	toolStart(toolCallId: string, displayName: string): void {
		this.inFlight.set(toolCallId, displayName);
	}

	toolEnd(toolCallId: string): void {
		this.inFlight.delete(toolCallId);
	}

	stageLabel(): string {
		let last: string | undefined;
		// Map preserves insertion order; the last surviving entry is the
		// most-recently-started tool still running.
		for (const name of this.inFlight.values()) last = name;
		return last ? `Using ${last}` : 'Thinking';
	}
}

// Per-thread worker chips with a post-completion linger so short subagents stay
// visible long enough for Realtime + client render to catch them.
type ChipEntry = { worker: ActiveWorker; endedAtMs: number | null };

export class ThreadChips {
	private chips = new Map<string, ChipEntry>();
	constructor(private readonly lingerMs: number) {}

	spawn(childSessionKey: string, worker: ActiveWorker): void {
		this.chips.set(childSessionKey, { worker, endedAtMs: null });
	}

	end(childSessionKey: string, nowMs: number): void {
		const entry = this.chips.get(childSessionKey);
		if (entry) entry.endedAtMs = nowMs;
	}

	// Returns currently-visible workers, pruning any past their linger window.
	list(nowMs: number): ActiveWorker[] {
		const out: ActiveWorker[] = [];
		for (const [key, entry] of this.chips) {
			if (entry.endedAtMs !== null && nowMs - entry.endedAtMs >= this.lingerMs) {
				this.chips.delete(key);
				continue;
			}
			out.push(entry.worker);
		}
		return out;
	}
}

// ── Live glue: hook registration + per-thread Supabase writes ─────────────────

// Chip survives this long after a subagent ends — long enough for Realtime +
// client render to catch short-lived workers (matches the old poller window).
const WORKER_LINGER_MS = 10_000;

type ThreadState = {
	supabase: SupabaseClient;
	stage: ThreadStage;
	chips: ThreadChips;
	lastStage: string; // dedupe — one DB write per stage change
	chipTimer?: ReturnType<typeof setTimeout>; // scheduleFlush: chip re-flush after a subagent's linger
	teardownTimer?: ReturnType<typeof setTimeout>; // endThreadStatus: post-turn teardown
};

// The four hooks fire GLOBALLY (every agent/session in the gateway). We only act
// on threads currently mid-turn — registered here by handleInbound.
const activeThreads = new Map<string, ThreadState>();
// childSessionKey -> threadId, so subagent_ended (which carries only the child
// key) routes back to the right thread.
const childThread = new Map<string, string>();

// Wired from index.ts's defineChannelPluginEntry({ registerFull }). registerFull
// runs once per "full" runtime registration pass; we (re)register on each.
export function registerStatusEventHooks(api: any): void {
	// registerFull runs more than once per boot; only a LIVE "full" runtime pass
	// fires hooks at turn time, and there can be multiple "full" passes where
	// only a later one is live. Register on EVERY full pass — the shared
	// module-level state + flushStage's lastStage dedupe + idempotent Map ops
	// make duplicate handlers harmless. (A "register once" guard here latched
	// onto an inert earlier pass and silently dropped every tool/subagent event.)
	if (api?.registrationMode !== 'full') return;
	console.log('[format-plugin] live-status event hooks wired');

	api.on('before_tool_call', (event: any, ctx: any) => {
		const st = liveThread(ctx?.sessionKey);
		if (!st) return;
		const name = normalizeToolName(event?.toolName);
		const id = event?.toolCallId ?? ctx?.toolCallId;
		if (!name || !id) return;
		st.state.stage.toolStart(id, name);
		flushStage(st.threadId, st.state);
	});

	api.on('after_tool_call', (event: any, ctx: any) => {
		const st = liveThread(ctx?.sessionKey);
		if (!st) return;
		const id = event?.toolCallId ?? ctx?.toolCallId;
		if (!id) return;
		st.state.stage.toolEnd(id);
		flushStage(st.threadId, st.state);
	});

	api.on('subagent_spawned', (event: any, ctx: any) => {
		const threadId = subagentThreadId(event, ctx);
		const childKey = event?.childSessionKey;
		if (!threadId || !childKey) return;
		const state = activeThreads.get(threadId);
		if (!state) return;
		childThread.set(childKey, threadId);
		state.chips.spawn(childKey, {
			session_key: childKey,
			runtime: event?.agentId ?? 'unknown',
			agent: event?.label ?? null,
			started_at: new Date().toISOString()
		});
		flushChips(threadId, state);
	});

	api.on('subagent_ended', (event: any, ctx: any) => {
		const childKey = event?.targetSessionKey;
		if (!childKey) return;
		const threadId = childThread.get(childKey) ?? parseFormatParentThreadId(ctx?.requesterSessionKey);
		if (!threadId) return;
		const state = activeThreads.get(threadId);
		if (!state) return;
		state.chips.end(childKey, Date.now());
		flushChips(threadId, state);
		scheduleFlush(threadId); // re-flush after linger so the chip disappears
	});
}

function liveThread(sessionKey: string | undefined): { threadId: string; state: ThreadState } | null {
	const threadId = parseFormatParentThreadId(sessionKey);
	if (!threadId) return null;
	const state = activeThreads.get(threadId);
	return state ? { threadId, state } : null;
}

function flushStage(threadId: string, state: ThreadState): void {
	const next = state.stage.stageLabel();
	if (next === state.lastStage) return;
	state.lastStage = next;
	void setStage(state.supabase, threadId, next);
}

function flushChips(threadId: string, state: ThreadState): void {
	// Through the composer so codex chips (written by the reconcile) and these
	// subagent chips share active_workers without clobbering each other.
	writeSubagentChips(state.supabase, threadId, state.chips.list(Date.now()));
}

function scheduleFlush(threadId: string): void {
	const state = activeThreads.get(threadId);
	if (!state) return;
	// Own slot, separate from the teardown timer — a late subagent_ended must not
	// cancel endThreadStatus's pending teardown (which would leak the thread).
	if (state.chipTimer) clearTimeout(state.chipTimer);
	state.chipTimer = setTimeout(() => {
		const cur = activeThreads.get(threadId);
		if (cur) flushChips(threadId, cur);
	}, WORKER_LINGER_MS + 500);
}

// handleInbound calls this at turn start: registers the thread so the global
// hooks act on it, and resets per-turn stage/chip state. lastStage starts at
// "Thinking" to match handleInbound's setRunning(…, "Thinking").
export function beginThreadStatus(params: { supabase: SupabaseClient; threadId: string }): void {
	const existing = activeThreads.get(params.threadId);
	if (existing?.chipTimer) clearTimeout(existing.chipTimer);
	if (existing?.teardownTimer) clearTimeout(existing.teardownTimer);
	activeThreads.set(params.threadId, {
		supabase: params.supabase,
		stage: new ThreadStage(),
		chips: new ThreadChips(WORKER_LINGER_MS),
		lastStage: 'Thinking'
	});
}

// handleInbound calls this in its finally: clears chips after the linger, then
// forgets the thread. A fresh turn (beginThreadStatus) cancels this teardown.
export function endThreadStatus(threadId: string): void {
	const state = activeThreads.get(threadId);
	if (!state) return;
	// Teardown supersedes any pending chip re-flush, and gets its OWN timer slot so
	// a late subagent_ended (scheduleFlush) can't clobber the delete below.
	if (state.chipTimer) clearTimeout(state.chipTimer);
	if (state.teardownTimer) clearTimeout(state.teardownTimer);
	state.teardownTimer = setTimeout(() => {
		// A fresh turn replaces the entry + cancels this timer; re-check so a stale
		// teardown can never delete a newly-registered thread.
		if (activeThreads.get(threadId) !== state) return;
		// Clears only the SUBAGENT slice — a still-running codex job keeps its chip
		// via the reconcile's codex slice in the composer.
		writeSubagentChips(state.supabase, threadId, []);
		activeThreads.delete(threadId);
		for (const [child, tid] of childThread) if (tid === threadId) childThread.delete(child);
	}, WORKER_LINGER_MS + 500);
}
