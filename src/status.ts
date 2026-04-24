// chat_threads column writers for the status surface (migration 039 + 040).
// Service-role client bypasses RLS so these writes land even though the user
// never sees a JWT. The UI subscribes to chat_threads UPDATE via Realtime
// and renders the status zone + worker chips from these columns.
//
// Plugin runs inside the OpenClaw gateway process, outside the SvelteKit
// module graph — `$lib/utils/logger` is not reachable here. Using `console.*`
// directly is the sanctioned pattern (see CLAUDE.md "Logging" section).

import type { SupabaseClient } from '@supabase/supabase-js';

export type ActiveWorker = {
	session_key: string;
	runtime: string;
	agent: string | null;
	started_at: string;
};

export async function setRunning(
	supabase: SupabaseClient,
	threadId: string,
	stage: string
): Promise<void> {
	const now = new Date().toISOString();
	const { error } = await supabase
		.from('chat_threads')
		.update({
			status: 'running',
			active_run_started_at: now,
			active_run_stage: stage,
			last_heartbeat_at: now
		})
		.eq('id', threadId);
	if (error) {
		console.warn('[format-plugin] setRunning failed', { threadId, error: error.message });
	}
}

export async function writeHeartbeat(
	supabase: SupabaseClient,
	threadId: string
): Promise<void> {
	const { error } = await supabase
		.from('chat_threads')
		.update({ last_heartbeat_at: new Date().toISOString() })
		.eq('id', threadId);
	if (error) {
		// Heartbeat is best-effort — don't raise — but a silent drop makes a
		// broken heartbeat loop indistinguishable from a healthy one. One
		// warn-per-failure is cheap observability for the rare-but-real case
		// where RLS / network / constraint errors stop heartbeats entirely.
		console.warn('[format-plugin] heartbeat write failed', {
			threadId,
			message: error.message,
			code: error.code
		});
	}
}

export async function setStage(
	supabase: SupabaseClient,
	threadId: string,
	stage: string
): Promise<void> {
	const { error } = await supabase
		.from('chat_threads')
		.update({ active_run_stage: stage })
		.eq('id', threadId);
	if (error) {
		console.warn('[format-plugin] setStage failed', { threadId, error: error.message });
	}
}

export async function setIdle(
	supabase: SupabaseClient,
	threadId: string
): Promise<void> {
	// Graceful turn end: let the workers-poller tail own active_workers so
	// chips linger briefly after completion. (setFailed intentionally clears
	// the field immediately — failed turns shouldn't show "still working"
	// chips.)
	const { error } = await supabase
		.from('chat_threads')
		.update({
			status: 'idle',
			active_run_started_at: null,
			active_run_stage: null
		})
		.eq('id', threadId);
	if (error) {
		console.warn('[format-plugin] setIdle failed', { threadId, error: error.message });
	}
}

export async function setFailed(
	supabase: SupabaseClient,
	threadId: string,
	errorText: string
): Promise<void> {
	const { error } = await supabase
		.from('chat_threads')
		.update({
			status: 'failed',
			active_run_started_at: null,
			active_run_stage: errorText.slice(0, 120),
			active_workers: []
		})
		.eq('id', threadId);
	if (error) {
		console.warn('[format-plugin] setFailed failed', { threadId, error: error.message });
	}
}

export async function setActiveWorkers(
	supabase: SupabaseClient,
	threadId: string,
	workers: ActiveWorker[]
): Promise<void> {
	const { error } = await supabase
		.from('chat_threads')
		.update({ active_workers: workers })
		.eq('id', threadId);
	if (error) {
		console.warn('[format-plugin] setActiveWorkers failed', { threadId, error: error.message });
	}
}
