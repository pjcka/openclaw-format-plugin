// Tests for the pure derivation behind the "codex agent running" chips —
// codex-job status snapshots → per-Format-thread chips. The fs scan + reconcile
// timer are thin glue verified live in the gateway.

import { describe, it, expect } from 'vitest';
import { deriveCodexChips, type JobSnapshot } from '../../src/codex-chips.ts';

const alive = () => true;
const dead = () => false;
const THREAD = 'ffd2109d-1b24-420f-b21e-fdd27f8c8c59';

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
	jobId: '2026-06-14-101010-write-a-haiku',
	notifyChannel: 'format',
	notifyTarget: THREAD,
	task: 'Write a haiku about the sea',
	state: 'running',
	launcherPid: 4242,
	startedAt: '2026-06-14T10:10:10.000Z',
	createdAt: '2026-06-14T10:10:09.000Z',
	...over
});

describe('deriveCodexChips', () => {
	it('maps a running Format job to a codex chip on its thread', () => {
		const chips = deriveCodexChips([job()], alive).get(THREAD);
		expect(chips).toEqual([
			{
				session_key: 'codex-job:2026-06-14-101010-write-a-haiku',
				runtime: 'codex',
				agent: 'Write a haiku about the sea',
				started_at: '2026-06-14T10:10:10.000Z'
			}
		]);
	});

	it('shows a job still in the "starting" state', () => {
		expect(deriveCodexChips([job({ state: 'starting' })], alive).size).toBe(1);
	});

	it('skips terminal / unknown states', () => {
		for (const state of ['done', 'failed', 'killed', 'unknown', undefined]) {
			expect(deriveCodexChips([job({ state })], alive).size).toBe(0);
		}
	});

	it('skips non-Format jobs (a BlueBubbles or headless job never lands on a Format thread)', () => {
		expect(deriveCodexChips([job({ notifyChannel: 'bluebubbles' })], alive).size).toBe(0);
		expect(deriveCodexChips([job({ notifyChannel: '' })], alive).size).toBe(0);
		expect(deriveCodexChips([job({ notifyChannel: undefined })], alive).size).toBe(0);
	});

	it('skips a job with no thread target', () => {
		expect(deriveCodexChips([job({ notifyTarget: '' })], alive).size).toBe(0);
		expect(deriveCodexChips([job({ notifyTarget: undefined })], alive).size).toBe(0);
	});

	it('skips a job whose launcher died without writing a terminal status', () => {
		expect(deriveCodexChips([job()], dead).size).toBe(0);
	});

	it('groups multiple running jobs onto the same thread', () => {
		const m = deriveCodexChips([job({ jobId: 'a' }), job({ jobId: 'b' })], alive);
		expect(m.get(THREAD)).toHaveLength(2);
	});

	it('routes jobs to different threads independently', () => {
		const m = deriveCodexChips(
			[job({ jobId: 'a', notifyTarget: 't1' }), job({ jobId: 'b', notifyTarget: 't2' })],
			alive
		);
		expect(m.get('t1')).toHaveLength(1);
		expect(m.get('t2')).toHaveLength(1);
	});

	it('truncates a long task summary and falls back to createdAt when startedAt is absent', () => {
		const chip = deriveCodexChips(
			[job({ task: 'x'.repeat(200), startedAt: undefined })],
			alive
		).get(THREAD)![0];
		expect(chip.agent).toHaveLength(80); // 79 chars + ellipsis
		expect(chip.agent!.endsWith('…')).toBe(true);
		expect(chip.started_at).toBe('2026-06-14T10:10:09.000Z');
	});

	it('a job with no task summary → agent null', () => {
		expect(deriveCodexChips([job({ task: undefined })], alive).get(THREAD)![0].agent).toBeNull();
	});
});
