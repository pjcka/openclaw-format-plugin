// Tests for the active_workers composer — the single writer that merges live
// subagent chips and reconciled codex chips so neither clobbers the other.

import { describe, it, expect, beforeEach } from 'vitest';
import {
	writeSubagentChips,
	writeCodexChips,
	__resetActiveWorkersForTest
} from '../../src/active-workers.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActiveWorker } from '../../src/status.ts';

// Records the (threadId, active_workers) of each setActiveWorkers write.
function mockSupabase() {
	const writes: Array<{ threadId: string; workers: ActiveWorker[] }> = [];
	const client = {
		from: () => ({
			update: (payload: { active_workers: ActiveWorker[] }) => ({
				eq: (_col: string, threadId: string) => {
					writes.push({ threadId, workers: payload.active_workers });
					return Promise.resolve({ error: null });
				}
			})
		})
	} as unknown as SupabaseClient;
	return { client, writes };
}

const codex = (id: string): ActiveWorker => ({
	session_key: `codex-job:${id}`,
	runtime: 'codex',
	agent: 'job',
	started_at: '2026-06-14T00:00:00.000Z'
});
const sub = (key: string): ActiveWorker => ({
	session_key: key,
	runtime: 'codex',
	agent: 'sub',
	started_at: '2026-06-14T00:00:00.000Z'
});
const keys = (w: { workers: ActiveWorker[] }) => w.workers.map((x) => x.session_key);

describe('active-workers composer', () => {
	beforeEach(() => __resetActiveWorkersForTest());

	it('writes codex chips on their own', () => {
		const sb = mockSupabase();
		writeCodexChips(sb.client, 't', [codex('a')]);
		expect(sb.writes.at(-1)).toEqual({ threadId: 't', workers: [codex('a')] });
	});

	it('merges codex + subagent into a union (neither clobbers the other)', () => {
		const sb = mockSupabase();
		writeCodexChips(sb.client, 't', [codex('a')]);
		writeSubagentChips(sb.client, 't', [sub('child-1')]);
		expect(keys(sb.writes.at(-1)!)).toEqual(['codex-job:a', 'child-1']);
	});

	it('clearing the subagent slice keeps a running codex chip (the endThreadStatus case)', () => {
		const sb = mockSupabase();
		writeCodexChips(sb.client, 't', [codex('a')]);
		writeSubagentChips(sb.client, 't', [sub('child-1')]);
		writeSubagentChips(sb.client, 't', []); // endThreadStatus teardown
		expect(keys(sb.writes.at(-1)!)).toEqual(['codex-job:a']);
	});

	it('clearing the codex slice keeps live subagent chips', () => {
		const sb = mockSupabase();
		writeSubagentChips(sb.client, 't', [sub('child-1')]);
		writeCodexChips(sb.client, 't', [codex('a')]);
		writeCodexChips(sb.client, 't', []); // job finished
		expect(keys(sb.writes.at(-1)!)).toEqual(['child-1']);
	});

	it('dedupes identical writes (no Realtime churn from the 4s reconcile re-tick)', () => {
		const sb = mockSupabase();
		writeCodexChips(sb.client, 't', [codex('a')]);
		const n = sb.writes.length;
		writeCodexChips(sb.client, 't', [codex('a')]);
		writeCodexChips(sb.client, 't', [codex('a')]);
		expect(sb.writes.length).toBe(n);
	});

	it('writes an empty list when both slices drain', () => {
		const sb = mockSupabase();
		writeCodexChips(sb.client, 't', [codex('a')]);
		writeCodexChips(sb.client, 't', []);
		expect(sb.writes.at(-1)).toEqual({ threadId: 't', workers: [] });
	});

	it('keeps threads independent', () => {
		const sb = mockSupabase();
		writeCodexChips(sb.client, 't1', [codex('a')]);
		writeCodexChips(sb.client, 't2', [codex('b')]);
		expect(keys(sb.writes.filter((w) => w.threadId === 't1').at(-1)!)).toEqual(['codex-job:a']);
		expect(keys(sb.writes.filter((w) => w.threadId === 't2').at(-1)!)).toEqual(['codex-job:b']);
	});
});
