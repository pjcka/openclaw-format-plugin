// Tests for document-context.ts — UC1 doc injection: the pure framing/prepend
// helpers, the per-thread first-turn/changed/unchanged/standalone/failure decision
// cache, and the bearer read_document HTTP request shape (args.thread_id nesting +
// { result } envelope unwrap).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	buildDocumentBlock,
	withDocumentContext,
	loadThreadDocumentContext,
	__resetDocumentContextCache,
} from '../../src/document-context.ts';

const account = {
	accountId: 'default',
	supabaseUrl: 'https://proj.supabase.co',
	supabaseServiceRole: 'service-role-key',
	formatUrl: 'https://format.example/',
	inboundWebhookSecret: 'whsec_1234567890abcdef',
	token: 'service-role-key',
	allowFrom: [],
	dmPolicy: undefined,
} as Parameters<typeof loadThreadDocumentContext>[0]['account'];

const THREAD = '22222222-2222-2222-2222-222222222222';
const okDoc = (updated_at: string, content = 'Hello world') => ({
	id: 'doc-1',
	title: 'My Notes',
	content,
	updated_at,
});

beforeEach(() => {
	__resetDocumentContextCache();
	vi.restoreAllMocks();
});

describe('buildDocumentBlock', () => {
	it('frames first-injection content with title + BEGIN/END markers', () => {
		const out = buildDocumentBlock('My Notes', 'Body text', { updated: false });
		expect(out).toContain('current full content');
		expect(out).toContain('Document title: "My Notes"');
		expect(out).toContain('--- BEGIN DOCUMENT ---\nBody text\n--- END DOCUMENT ---');
		expect(out).not.toContain('UPDATED');
	});

	it('uses the "updated" lead when re-injecting a changed doc', () => {
		const out = buildDocumentBlock('My Notes', 'Body', { updated: true });
		expect(out).toContain('has been UPDATED');
		expect(out).toContain('not any earlier copy');
	});

	it('falls back for an empty document and defaults a blank title', () => {
		const out = buildDocumentBlock('   ', '   ', { updated: false });
		expect(out).toContain('Document title: "Untitled"');
		expect(out).toContain('(the document is currently empty)');
	});
});

describe('withDocumentContext', () => {
	it('prepends the block before the body', () => {
		expect(withDocumentContext('user msg', 'DOC')).toBe('DOC\n\nuser msg');
	});
	it('returns just the block when the body is empty', () => {
		expect(withDocumentContext('', 'DOC')).toBe('DOC');
	});
	it('leaves the body untouched when there is no block', () => {
		expect(withDocumentContext('user msg', null)).toBe('user msg');
	});
});

describe('loadThreadDocumentContext — injection decision', () => {
	it('injects the full doc on the first turn', async () => {
		const invoke = vi.fn().mockResolvedValue(okDoc('2026-06-21T00:00:00Z'));
		const out = await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(out).toContain('Document title: "My Notes"');
		expect(out).toContain('Hello world');
		expect(out).not.toContain('UPDATED');
	});

	it('does NOT re-inject on a later turn when the doc is unchanged', async () => {
		const invoke = vi.fn().mockResolvedValue(okDoc('2026-06-21T00:00:00Z'));
		await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		const second = await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		expect(invoke).toHaveBeenCalledTimes(2); // it still reads to check freshness…
		expect(second).toBeNull(); // …but injects nothing (agent has it in context)
	});

	it('re-injects with the updated lead when the doc changed', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValueOnce(okDoc('2026-06-21T00:00:00Z', 'v1'))
			.mockResolvedValueOnce(okDoc('2026-06-21T01:00:00Z', 'v2'));
		await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		const second = await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		expect(second).toContain('has been UPDATED');
		expect(second).toContain('v2');
	});

	// Change-detection MUST key on the live content, not updated_at — body edits
	// (the common case) land in the Liveblocks room and never bump documents.updated_at.
	it('re-injects when content changed even though updated_at is identical', async () => {
		const SAME_TS = '2026-06-21T00:00:00Z';
		const invoke = vi
			.fn()
			.mockResolvedValueOnce(okDoc(SAME_TS, 'first body'))
			.mockResolvedValueOnce(okDoc(SAME_TS, 'edited body'));
		await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		const second = await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		expect(second).toContain('has been UPDATED');
		expect(second).toContain('edited body');
	});

	it('does NOT re-inject when only updated_at changed but content is identical', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValueOnce(okDoc('2026-06-21T00:00:00Z', 'same body'))
			.mockResolvedValueOnce(okDoc('2026-06-21T09:00:00Z', 'same body')); // e.g. a mere view bumped updated_at
		await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		const second = await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		expect(second).toBeNull();
	});

	it('returns null for a standalone thread (no_document)', async () => {
		const invoke = vi.fn().mockResolvedValue({ no_document: true, message: 'none' });
		const out = await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		expect(out).toBeNull();
	});

	it('a thread that becomes standalone clears its cache (re-injects if it returns)', async () => {
		const invoke = vi
			.fn()
			.mockResolvedValueOnce(okDoc('t1'))
			.mockResolvedValueOnce({ no_document: true })
			.mockResolvedValueOnce(okDoc('t1')); // same updated_at as the first
		await loadThreadDocumentContext({ account, threadId: THREAD, invoke }); // inject
		await loadThreadDocumentContext({ account, threadId: THREAD, invoke }); // standalone → clears
		const third = await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		expect(third).not.toBeNull(); // treated as first turn again
	});

	it('degrades to null on a read failure and does not cache (next turn retries)', async () => {
		const warn = vi.fn();
		const invoke = vi
			.fn()
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce(okDoc('2026-06-21T00:00:00Z'));
		const first = await loadThreadDocumentContext({
			account,
			threadId: THREAD,
			invoke,
			log: { warn },
		});
		expect(first).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
		const second = await loadThreadDocumentContext({ account, threadId: THREAD, invoke });
		expect(second).not.toBeNull(); // not cached after failure → re-read injects
	});

	it('tracks threads independently', async () => {
		const A = '11111111-1111-1111-1111-111111111111';
		const B = '33333333-3333-3333-3333-333333333333';
		const invoke = vi.fn().mockResolvedValue(okDoc('t1'));
		expect(await loadThreadDocumentContext({ account, threadId: A, invoke })).not.toBeNull();
		expect(await loadThreadDocumentContext({ account, threadId: B, invoke })).not.toBeNull();
		expect(await loadThreadDocumentContext({ account, threadId: A, invoke })).toBeNull();
	});

	it('evicts the oldest thread past the cap (its next turn re-injects)', async () => {
		const invoke = vi.fn().mockResolvedValue(okDoc('t1'));
		const evictee = '00000000-0000-0000-0000-000000000000';
		await loadThreadDocumentContext({ account, threadId: evictee, invoke });
		// Fill past MAX_TRACKED_THREADS (500) with distinct ids to push the evictee out.
		for (let i = 0; i < 500; i++) {
			const id = `aaaaaaaa-0000-0000-0000-${i.toString().padStart(12, '0')}`;
			await loadThreadDocumentContext({ account, threadId: id, invoke });
		}
		// Evictee's entry is gone → same updated_at now re-injects instead of returning null.
		expect(await loadThreadDocumentContext({ account, threadId: evictee, invoke })).not.toBeNull();
	});
});

describe('fetchThreadDocument (real path via stubbed fetch)', () => {
	it('POSTs the bearer read_document call with thread_id under args and unwraps result', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ result: okDoc('2026-06-21T00:00:00Z') }),
		});
		vi.stubGlobal('fetch', fetchMock);

		const out = await loadThreadDocumentContext({ account, threadId: THREAD }); // no injected invoke → real fetch
		expect(out).toContain('My Notes');

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://format.example/api/tools/invoke'); // trailing slash stripped
		expect(init.method).toBe('POST');
		expect(init.headers.authorization).toBe('Bearer whsec_1234567890abcdef');
		const body = JSON.parse(init.body);
		expect(body).toEqual({ tool: 'read_document', args: { thread_id: THREAD } });
		expect(body.thread_id).toBeUndefined(); // NOT top-level — read_document reads args.thread_id
	});

	it('degrades to null on a non-2xx response', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => 'Tool failed',
		});
		vi.stubGlobal('fetch', fetchMock);
		const warn = vi.fn();
		const out = await loadThreadDocumentContext({ account, threadId: THREAD, log: { warn } });
		expect(out).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
	});

	it('degrades to null (never throws) on a malformed { result: null } body', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ result: null }),
		});
		vi.stubGlobal('fetch', fetchMock);
		const warn = vi.fn();
		const out = await loadThreadDocumentContext({ account, threadId: THREAD, log: { warn } });
		expect(out).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
	});
});
