// OpenClaw's worker-board runs as a separate process on port 8766 and exposes
// activeWorkers / liveSessions / recentFinished. We poll it per-thread while
// the thread is active and write the filtered slice to
// chat_threads.active_workers (migration 040) so the UI's status zone can
// render worker chips.
//
// Matches the out-of-tree bridge's logic — recentFinished + 5s linger so
// short ACP workers (3-6s) register before being dropped.

import type { SupabaseClient } from '@supabase/supabase-js';
import { setActiveWorkers, type ActiveWorker } from './status.ts';

// Env-overridable so dev/test setups can point at a non-default gateway port.
const WORKER_BOARD_URL =
	process.env.OPENCLAW_WORKER_BOARD_URL ?? 'http://127.0.0.1:8766/api/workers';
// Chip survives this long after a worker finishes — gives Realtime +
// client-render enough time to catch short-lived ACP subworkers.
const WORKER_LINGER_MS = 10000;
const FETCH_TIMEOUT_MS = 1500;

type WorkerBoardEntry = {
	requesterSessionKey?: string;
	childSessionKey?: string;
	taskId?: string;
	runtime?: string;
	task?: string;
	taskShort?: string;
	computedStatus?: string;
	lastEventAgoMs?: number;
	runDurationMs?: number;
};

type WorkerBoardResponse = {
	activeWorkers?: WorkerBoardEntry[];
	liveSessions?: WorkerBoardEntry[];
	recentFinished?: WorkerBoardEntry[];
};

export async function fetchChildWorkersForThread(
	threadId: string,
	prevList: ActiveWorker[]
): Promise<ActiveWorker[] | null> {
	let data: WorkerBoardResponse;
	try {
		const res = await fetch(WORKER_BOARD_URL, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!res.ok) return null;
		data = (await res.json()) as WorkerBoardResponse;
	} catch {
		return null;
	}

	const parentKey = `format:${threadId}`;
	const now = Date.now();
	const all: WorkerBoardEntry[] = [
		...(Array.isArray(data.activeWorkers) ? data.activeWorkers : []),
		...(Array.isArray(data.liveSessions) ? data.liveSessions : []),
		...(Array.isArray(data.recentFinished) ? data.recentFinished : [])
	];

	const children = all
		.filter((w) => {
			if (w.requesterSessionKey !== parentKey) return false;
			// Drop the parent session itself (appears when the board lists it).
			if (w.childSessionKey === w.requesterSessionKey) return false;
			// Finished workers get a 5s grace window so short runs register.
			const ageMs = typeof w.lastEventAgoMs === 'number' ? w.lastEventAgoMs : null;
			if (w.computedStatus && w.computedStatus !== 'running') {
				if (ageMs === null || ageMs > WORKER_LINGER_MS) return false;
			}
			return true;
		})
		.map((w): ActiveWorker => {
			const sessionKey = w.childSessionKey ?? w.taskId ?? `unknown-${Math.random()}`;
			const prior = prevList.find((p) => p.session_key === sessionKey);
			return {
				session_key: sessionKey,
				runtime: w.runtime ?? 'unknown',
				agent: w.task ?? w.taskShort ?? null,
				started_at:
					prior?.started_at ??
					(typeof w.lastEventAgoMs === 'number' && typeof w.runDurationMs === 'number'
						? new Date(now - w.lastEventAgoMs - w.runDurationMs).toISOString()
						: new Date(now).toISOString())
			};
		});

	// Dedupe by session_key — the same child can appear in multiple buckets.
	const bySession = new Map<string, ActiveWorker>();
	for (const c of children) bySession.set(c.session_key, c);
	return [...bySession.values()];
}

export function startWorkersPoll(opts: {
	supabase: SupabaseClient;
	threadId: string;
	intervalMs?: number;
}): () => void {
	const { supabase, threadId } = opts;
	const intervalMs = opts.intervalMs ?? 1000;

	let prev: ActiveWorker[] = [];
	let running = true;
	let pollInflight = false;

	const tick = async () => {
		if (!running || pollInflight) return;
		pollInflight = true;
		try {
			const next = await fetchChildWorkersForThread(threadId, prev);
			if (next === null) return;
			// Only write if the set materially changed (cheap string compare).
			if (JSON.stringify(next) === JSON.stringify(prev)) return;
			prev = next;
			await setActiveWorkers(supabase, threadId, next);
		} catch {
			/* best-effort; next tick */
		} finally {
			pollInflight = false;
		}
	};

	void tick();
	const timer = setInterval(tick, intervalMs);

	return () => {
		running = false;
		clearInterval(timer);
	};
}
