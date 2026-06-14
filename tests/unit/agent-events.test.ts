// Tests for agent-events.ts — the pure status-derivation logic behind the
// live-status repoint (tool-stage + subagent chips). The hook registration +
// Supabase writes are thin glue verified live in the gateway; the logic that
// decides WHAT to show is unit-tested here.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	parseFormatParentThreadId,
	normalizeToolName,
	subagentThreadId,
	registerStatusEventHooks,
	beginThreadStatus,
	endThreadStatus,
	ThreadStage,
	ThreadChips
} from '../../src/agent-events.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActiveWorker } from '../../src/status.ts';

describe('parseFormatParentThreadId', () => {
	it('extracts the threadId from a Format parent session key', () => {
		expect(
			parseFormatParentThreadId('agent:main:format:direct:ffd2109d-1b24-420f-b21e-fdd27f8c8c59')
		).toBe('ffd2109d-1b24-420f-b21e-fdd27f8c8c59');
	});

	it('returns null for a subagent key (extra segments) so subagent tool calls do not move the parent stage', () => {
		expect(
			parseFormatParentThreadId(
				'agent:main:format:direct:ffd2109d-1b24-420f-b21e-fdd27f8c8c59:subagent:codex:abc'
			)
		).toBeNull();
	});

	it('returns null for non-Format sessions (boot, cron, other channels)', () => {
		expect(parseFormatParentThreadId('agent:main:boot')).toBeNull();
		expect(parseFormatParentThreadId('agent:main:cron:d93a7d4a')).toBeNull();
		expect(
			parseFormatParentThreadId('agent:main:bluebubbles:direct:+16123063571')
		).toBeNull();
	});

	it('returns null for undefined/empty input', () => {
		expect(parseFormatParentThreadId(undefined)).toBeNull();
		expect(parseFormatParentThreadId('')).toBeNull();
	});
});

describe('normalizeToolName', () => {
	it('strips the openclaw prefix so the dual-name fires collapse to one display name', () => {
		expect(normalizeToolName('openclawimage_generate')).toBe('image_generate');
		expect(normalizeToolName('openclawcodex_job')).toBe('codex_job');
		expect(normalizeToolName('openclawsessions_list')).toBe('sessions_list');
	});

	it('leaves already-normalized / core tool names unchanged', () => {
		expect(normalizeToolName('image_generate')).toBe('image_generate');
		expect(normalizeToolName('exec')).toBe('exec');
		expect(normalizeToolName('message')).toBe('message');
	});

	it('returns null for undefined/empty', () => {
		expect(normalizeToolName(undefined)).toBeNull();
		expect(normalizeToolName('')).toBeNull();
	});
});

describe('subagentThreadId', () => {
	it('routes a Format subagent to its thread via requester.{channel,threadId}', () => {
		const event = { requester: { channel: 'format', threadId: 'ffd2109d-1b24-420f-b21e-fdd27f8c8c59' } };
		expect(subagentThreadId(event, undefined)).toBe('ffd2109d-1b24-420f-b21e-fdd27f8c8c59');
	});

	it('falls back to ctx.requesterSessionKey when requester is absent', () => {
		const ctx = { requesterSessionKey: 'agent:main:format:direct:ffd2109d-1b24-420f-b21e-fdd27f8c8c59' };
		expect(subagentThreadId({}, ctx)).toBe('ffd2109d-1b24-420f-b21e-fdd27f8c8c59');
	});

	it('does NOT claim a subagent from another channel (e.g. BlueBubbles)', () => {
		const event = { requester: { channel: 'bluebubbles', threadId: '+16123063571' } };
		expect(subagentThreadId(event, undefined)).toBeNull();
	});
});

describe('ThreadStage', () => {
	it('reads "Thinking" with no tools in flight', () => {
		expect(new ThreadStage().stageLabel()).toBe('Thinking');
	});

	it('shows "Using <tool>" while a tool is in flight, reverting to Thinking when it ends', () => {
		const s = new ThreadStage();
		s.toolStart('c1', 'exec');
		expect(s.stageLabel()).toBe('Using exec');
		s.toolEnd('c1');
		expect(s.stageLabel()).toBe('Thinking');
	});

	it('dedupes by toolCallId so the dual-name fire counts once (no stuck stage)', () => {
		const s = new ThreadStage();
		// Same call, two name aliases — same toolCallId.
		s.toolStart('c1', 'image_generate');
		s.toolStart('c1', 'image_generate');
		expect(s.stageLabel()).toBe('Using image_generate');
		// A single end clears it — would stay stuck if counted twice.
		s.toolEnd('c1');
		expect(s.stageLabel()).toBe('Thinking');
	});

	it('with concurrent tools, shows the most recent and falls back as they end', () => {
		const s = new ThreadStage();
		s.toolStart('c1', 'exec');
		s.toolStart('c2', 'image_generate');
		expect(s.stageLabel()).toBe('Using image_generate');
		s.toolEnd('c2');
		expect(s.stageLabel()).toBe('Using exec');
		s.toolEnd('c1');
		expect(s.stageLabel()).toBe('Thinking');
	});

	it('ignores an end for an unknown toolCallId', () => {
		const s = new ThreadStage();
		s.toolStart('c1', 'exec');
		s.toolEnd('nope');
		expect(s.stageLabel()).toBe('Using exec');
	});
});

describe('registerStatusEventHooks registration gating', () => {
	// Regression: registerFull fires multiple times per boot, and only a LATER
	// "full" pass is the live one. An earlier "register once" guard latched onto
	// the first (inert) pass and dropped every tool/subagent event.
	const fakeApi = (mode: string, sink: string[]) => ({
		registrationMode: mode,
		on: (name: string) => sink.push(name)
	});

	it('registers all four hooks on a "full" pass', () => {
		const hooks: string[] = [];
		registerStatusEventHooks(fakeApi('full', hooks));
		expect(hooks).toEqual([
			'before_tool_call',
			'after_tool_call',
			'subagent_spawned',
			'subagent_ended'
		]);
	});

	it('registers nothing on a non-"full" (inert) pass', () => {
		const hooks: string[] = [];
		registerStatusEventHooks(fakeApi('tool-discovery', hooks));
		expect(hooks).toEqual([]);
	});

	it('re-registers on a SECOND full pass — never latches onto an earlier one', () => {
		const first: string[] = [];
		const second: string[] = [];
		registerStatusEventHooks(fakeApi('full', first));
		registerStatusEventHooks(fakeApi('full', second));
		// The buggy guard made `second` empty (registered only on pass 1).
		expect(first).toHaveLength(4);
		expect(second).toHaveLength(4);
	});

	it('an inert non-full pass BEFORE the live full pass does not block it (the exact incident shape)', () => {
		// The original bug latched onto an inert earlier pass; a guard checked
		// before the full-mode check would set the latch here and drop the full pass.
		const inert: string[] = [];
		const live: string[] = [];
		registerStatusEventHooks(fakeApi('tool-discovery', inert));
		registerStatusEventHooks(fakeApi('full', live));
		expect(inert).toHaveLength(0);
		expect(live).toHaveLength(4);
	});
});

describe('ThreadChips', () => {
	const worker = (key: string): ActiveWorker => ({
		session_key: key,
		runtime: 'codex',
		agent: 'haiku writer',
		started_at: '2026-06-14T00:00:00.000Z'
	});

	it('is empty with no spawns', () => {
		expect(new ThreadChips(10_000).list(0)).toEqual([]);
	});

	it('lists a spawned worker', () => {
		const c = new ThreadChips(10_000);
		c.spawn('s1', worker('s1'));
		expect(c.list(0)).toEqual([worker('s1')]);
	});

	it('keeps an ended worker visible during the linger window, then drops it', () => {
		const c = new ThreadChips(10_000);
		c.spawn('s1', worker('s1'));
		c.end('s1', 1_000);
		expect(c.list(1_000 + 9_999)).toEqual([worker('s1')]); // within linger
		expect(c.list(1_000 + 10_001)).toEqual([]); // past linger
	});

	it('drops only the ended worker, keeping a still-running one', () => {
		const c = new ThreadChips(10_000);
		c.spawn('s1', worker('s1'));
		c.spawn('s2', worker('s2'));
		c.end('s1', 1_000);
		expect(c.list(1_000 + 10_001).map((w) => w.session_key)).toEqual(['s2']);
	});

	it('ignores an end for an unknown session key', () => {
		const c = new ThreadChips(10_000);
		c.spawn('s1', worker('s1'));
		c.end('unknown', 1_000);
		expect(c.list(0).map((w) => w.session_key)).toEqual(['s1']);
	});

	it('prunes exactly AT the linger boundary (>= lingerMs)', () => {
		const c = new ThreadChips(10_000);
		c.spawn('s1', worker('s1'));
		c.end('s1', 0);
		expect(c.list(10_000)).toEqual([]); // delta == lingerMs → pruned
	});

	it('re-spawning an ended worker clears its linger (visible again indefinitely)', () => {
		const c = new ThreadChips(10_000);
		c.spawn('s1', worker('s1'));
		c.end('s1', 1_000);
		c.spawn('s1', worker('s1')); // re-spawn resets endedAtMs to null
		expect(c.list(1_000_000).map((w) => w.session_key)).toEqual(['s1']);
	});
});

describe('hook handler glue + lifecycle (integration)', () => {
	// Unique threadId per test → no collision in the module-level activeThreads Map.
	let tidSeq = 0;
	const newTid = () => `tid-${++tidSeq}`;
	const parentKey = (tid: string) => `agent:main:format:direct:${tid}`;

	// Capture the handlers registered via api.on so tests can invoke them directly.
	function captureHandlers(): Record<string, (e: unknown, c: unknown) => void> {
		const handlers: Record<string, (e: unknown, c: unknown) => void> = {};
		registerStatusEventHooks({
			registrationMode: 'full',
			on: (name: string, fn: (e: unknown, c: unknown) => void) => {
				handlers[name] = fn;
			}
		});
		return handlers;
	}

	// Mock Supabase that records the column payloads passed to .update().
	function mockSupabase() {
		const writes: Array<Record<string, unknown>> = [];
		const client = {
			from: () => ({
				update: (payload: Record<string, unknown>) => {
					writes.push(payload);
					return { eq: () => Promise.resolve({ error: null, data: [{}] }) };
				}
			})
		} as unknown as SupabaseClient;
		return { client, writes };
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('writes "Using <tool>" for the live parent thread, reverts on end, ignores other sessions', () => {
		const h = captureHandlers();
		const sb = mockSupabase();
		const tid = newTid();
		beginThreadStatus({ supabase: sb.client, threadId: tid });

		// openclaw-prefixed name normalizes; the parent sessionKey matches.
		h.before_tool_call({ toolName: 'openclawimage_generate', toolCallId: 'c1' }, { sessionKey: parentKey(tid) });
		expect(sb.writes.at(-1)).toEqual({ active_run_stage: 'Using image_generate' });

		h.after_tool_call({ toolCallId: 'c1' }, { sessionKey: parentKey(tid) });
		expect(sb.writes.at(-1)).toEqual({ active_run_stage: 'Thinking' });

		// A tool call from an unrelated session (e.g. boot) must not write.
		const before = sb.writes.length;
		h.before_tool_call({ toolName: 'exec', toolCallId: 'c2' }, { sessionKey: 'agent:main:boot' });
		expect(sb.writes.length).toBe(before);
	});

	it('spawn keys the chip by childSessionKey; ended routes back via targetSessionKey', () => {
		vi.useFakeTimers();
		const h = captureHandlers();
		const sb = mockSupabase();
		const tid = newTid();
		beginThreadStatus({ supabase: sb.client, threadId: tid });

		h.subagent_spawned(
			{ childSessionKey: 'child-1', agentId: 'codex', label: 'job', requester: { channel: 'format', threadId: tid } },
			{}
		);
		const spawnWrite = sb.writes.filter((w) => 'active_workers' in w).at(-1) as { active_workers: { session_key: string; runtime: string }[] };
		expect(spawnWrite.active_workers).toHaveLength(1);
		expect(spawnWrite.active_workers[0].session_key).toBe('child-1');
		expect(spawnWrite.active_workers[0].runtime).toBe('codex');

		// If targetSessionKey didn't match childSessionKey, ended would no-op (no write).
		const beforeEnd = sb.writes.length;
		h.subagent_ended({ targetSessionKey: 'child-1' }, {});
		expect(sb.writes.length).toBeGreaterThan(beforeEnd);
	});

	it('teardown survives a late subagent_ended — separate timers, no slot clobber', () => {
		vi.useFakeTimers();
		const h = captureHandlers();
		const sb = mockSupabase();
		const tid = newTid();
		beginThreadStatus({ supabase: sb.client, threadId: tid });
		h.subagent_spawned(
			{ childSessionKey: 'c1', agentId: 'codex', requester: { channel: 'format', threadId: tid } },
			{}
		);
		endThreadStatus(tid); // arms the teardown timer
		// A late ended event (within the linger window) must NOT cancel teardown.
		h.subagent_ended({ targetSessionKey: 'c1' }, {});
		vi.advanceTimersByTime(11_000); // past WORKER_LINGER_MS + 500

		// Thread must be torn down: a stray tool call for it is now ignored.
		const before = sb.writes.length;
		h.before_tool_call({ toolName: 'exec', toolCallId: 'x' }, { sessionKey: parentKey(tid) });
		expect(sb.writes.length).toBe(before);
	});
});
