// Single writer for chat_threads.active_workers. Two independent sources feed
// per-thread slices and we always persist their UNION, so neither clobbers the
// other:
//   - subagent chips — live, from agent-events.ts subagent_spawned/ended hooks
//     (turn-scoped: cleared by endThreadStatus shortly after the turn).
//   - codex chips     — reconciled from codex-job status files; OUTLIVE the turn
//     (a detached `codex exec` job runs for minutes after the 5ms dispatch turn).
// Without this, endThreadStatus's active_workers=[] teardown would erase a codex
// chip while its job is still running.
//
// Plugin runs outside the SvelteKit module graph; console.* is sanctioned (CLAUDE.md).

import type { SupabaseClient } from '@supabase/supabase-js';
import { setActiveWorkers, type ActiveWorker } from './status.ts';

type Entry = { subagent: ActiveWorker[]; codex: ActiveWorker[]; lastJson: string };

// threadId -> slices. Entries are dropped once both slices are empty.
const byThread = new Map<string, Entry>();

// codex first so a codex run wins a session_key tie (keys never actually collide:
// codex keys are `codex-job:<id>`, subagent keys are child session keys).
function union(e: Entry): ActiveWorker[] {
	const seen = new Set<string>();
	const out: ActiveWorker[] = [];
	for (const w of [...e.codex, ...e.subagent]) {
		if (seen.has(w.session_key)) continue;
		seen.add(w.session_key);
		out.push(w);
	}
	return out;
}

function entry(threadId: string): Entry {
	let e = byThread.get(threadId);
	if (!e) {
		e = { subagent: [], codex: [], lastJson: '' };
		byThread.set(threadId, e);
	}
	return e;
}

function flush(supabase: SupabaseClient, threadId: string): void {
	const e = byThread.get(threadId);
	if (!e) return;
	const merged = union(e);
	const json = JSON.stringify(merged);
	if (json !== e.lastJson) {
		e.lastJson = json; // dedupe — skip identical writes so we don't fan out Realtime churn
		void setActiveWorkers(supabase, threadId, merged);
	}
	// Forget fully-idle threads so the Map can't grow one-entry-per-thread forever.
	if (e.subagent.length === 0 && e.codex.length === 0) byThread.delete(threadId);
}

export function writeSubagentChips(
	supabase: SupabaseClient,
	threadId: string,
	chips: ActiveWorker[]
): void {
	entry(threadId).subagent = chips;
	flush(supabase, threadId);
}

export function writeCodexChips(
	supabase: SupabaseClient,
	threadId: string,
	chips: ActiveWorker[]
): void {
	entry(threadId).codex = chips;
	flush(supabase, threadId);
}

// Test-only reset for the module-level registry.
export function __resetActiveWorkersForTest(): void {
	byThread.clear();
}
