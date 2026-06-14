// "Codex agent running" chips, reconciled from codex-job's own status files.
//
// codex-job runs each task as a DETACHED `codex exec` process and already writes
// a per-job `status.json` (state: starting|running|done|failed|killed) + a
// `meta.json` (now stamped with the launching notifyChannel/notifyTarget). That
// directory is the existing source of truth for "what's running" — we just read
// it and project Format-thread jobs into worker chips. No OpenClaw task-runtime,
// no cross-process coupling beyond reading sibling files on the same machine.
//
// The dispatch turn ends in ~5ms while the job runs for minutes, so this is a
// steady light poll (not tied to the turn lifecycle); a job's chip drops on the
// next tick once status.json flips terminal. Plugin runs outside the SvelteKit
// module graph; console.* is sanctioned (CLAUDE.md).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActiveWorker } from './status.ts';
import { writeCodexChips } from './active-workers.ts';

const JOBS_DIR = join(homedir(), '.openclaw/workspace/codex-jobs');
const RECONCILE_MS = 4000;
// Only the newest job dirs can plausibly still be running; matches listJobs' window.
const MAX_DIRS = 40;
const ACTIVE_STATES = new Set(['starting', 'running']);

export type JobSnapshot = {
	jobId: string;
	notifyChannel?: string;
	notifyTarget?: string;
	task?: string;
	state?: string;
	launcherPid?: number | null;
	startedAt?: string;
	createdAt?: string;
};

// Pure: snapshots → per-Format-thread chips. A job shows iff it targets a Format
// thread, is in an active state, and its launcher process is still alive (guards
// a job that hard-crashed without ever writing a terminal status).
export function deriveCodexChips(
	jobs: JobSnapshot[],
	isAlive: (pid: number | null | undefined) => boolean
): Map<string, ActiveWorker[]> {
	const byThread = new Map<string, ActiveWorker[]>();
	for (const j of jobs) {
		if (j.notifyChannel !== 'format' || !j.notifyTarget) continue;
		if (!j.state || !ACTIVE_STATES.has(j.state)) continue;
		if (!isAlive(j.launcherPid)) continue;
		const chip: ActiveWorker = {
			session_key: `codex-job:${j.jobId}`,
			runtime: 'codex',
			agent: summarizeTask(j.task),
			started_at: j.startedAt ?? j.createdAt ?? new Date().toISOString()
		};
		const list = byThread.get(j.notifyTarget) ?? [];
		list.push(chip);
		byThread.set(j.notifyTarget, list);
	}
	return byThread;
}

function summarizeTask(task: string | undefined): string | null {
	if (!task) return null;
	const s = task.replace(/\s+/g, ' ').trim();
	if (!s) return null;
	return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

// Same liveness probe codex-job uses: signal 0 tests existence; EPERM = alive but
// not ours to signal (treated as alive).
function pidAlive(pid: number | null | undefined): boolean {
	if (!pid || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string })?.code === 'EPERM';
	}
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		return JSON.parse(await readFile(path, 'utf-8'));
	} catch {
		return null;
	}
}

async function scanJobs(): Promise<JobSnapshot[]> {
	let entries: string[];
	try {
		entries = await readdir(JOBS_DIR);
	} catch {
		return []; // dir absent until the first job runs
	}
	const dirs = entries
		.filter((e) => /^\d{4}-\d{2}-\d{2}-/.test(e))
		.sort()
		.reverse()
		.slice(0, MAX_DIRS);
	const out: JobSnapshot[] = [];
	for (const jobId of dirs) {
		const status = await readJson(join(JOBS_DIR, jobId, 'status.json'));
		// Cheap pre-filter: skip terminal/missing before reading meta.json.
		if (!status || !ACTIVE_STATES.has(status.state as string)) continue;
		const meta = await readJson(join(JOBS_DIR, jobId, 'meta.json'));
		out.push({
			jobId,
			notifyChannel: meta?.notifyChannel as string | undefined,
			notifyTarget: meta?.notifyTarget as string | undefined,
			task: meta?.task as string | undefined,
			state: status.state as string,
			// 'starting' status carries launcherPid:null; fall back to meta's pid.
			launcherPid: (status.launcherPid ?? meta?.launcherPid) as number | null | undefined,
			startedAt: status.startedAt as string | undefined,
			createdAt: meta?.createdAt as string | undefined
		});
	}
	return out;
}

// Reconcile loop. Reads codex-job status files and writes per-Format-thread chips,
// clearing a thread's chips the tick after its last job goes terminal. The timer
// is scoped to this account's lifetime (torn down on its abortSignal).
export function startCodexChipReconcile(opts: {
	supabase: SupabaseClient;
	abortSignal: AbortSignal;
}): void {
	const { supabase, abortSignal } = opts;
	let lastThreads = new Set<string>();

	const tick = async (): Promise<void> => {
		if (abortSignal.aborted) return;
		const byThread = deriveCodexChips(await scanJobs(), pidAlive);
		const now = new Set(byThread.keys());
		for (const [threadId, chips] of byThread) writeCodexChips(supabase, threadId, chips);
		// Threads that had codex chips last tick but no longer → clear once.
		for (const threadId of lastThreads) {
			if (!now.has(threadId)) writeCodexChips(supabase, threadId, []);
		}
		lastThreads = now;
	};

	const timer = setInterval(() => {
		void tick().catch((err) =>
			console.warn(
				'[format-plugin] codex-chip reconcile failed',
				err instanceof Error ? err.message : err
			)
		);
	}, RECONCILE_MS);

	abortSignal.addEventListener('abort', () => clearInterval(timer), { once: true });

	void tick();
}
