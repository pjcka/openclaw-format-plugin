// Tests for outbound.ts — the path-traversal guard (isAllowedMediaPath), media
// upload to the chat-images bucket (uploadMediaAsMarkdown), the TITLE: sentinel
// parser, and the reply transport (sendTextToFormat POSTs to /api/chat/incoming
// — no direct chat_messages / chat_threads write).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

const { readFileMock, uploadMock, maybeSingleMock, fromMock, fetchMock } = vi.hoisted(() => {
	const maybeSingleMock = vi.fn();
	return {
		readFileMock: vi.fn(),
		uploadMock: vi.fn(),
		maybeSingleMock,
		fromMock: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) })),
		fetchMock: vi.fn(),
	};
});

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import('node:fs/promises');
	return { ...actual, default: { ...actual, readFile: readFileMock }, readFile: readFileMock };
});

// getSupabaseClient() builds its client via createClient — return a stub whose
// storage.upload + from() chain the tests drive.
vi.mock('@supabase/supabase-js', () => ({
	createClient: () => ({
		storage: { from: () => ({ upload: uploadMock }) },
		from: fromMock,
	}),
}));

vi.stubGlobal('fetch', fetchMock);

import {
	isAllowedMediaPath,
	uploadMediaAsMarkdown,
	extractTitleSentinel,
	sendTextToFormat,
} from '../../src/outbound.ts';

const ALLOWED_ROOT = resolve(homedir(), '.openclaw', 'media');
const OWNER = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';

const account = {
	accountId: 'default',
	supabaseUrl: 'https://proj.supabase.co',
	supabaseServiceRole: 'service-role-key',
	formatUrl: 'https://format.example/',
	inboundWebhookSecret: 'whsec_1234567890abcdef',
	token: 'service-role-key',
	allowFrom: [],
	dmPolicy: undefined,
} as Parameters<typeof sendTextToFormat>[0];

beforeEach(() => {
	vi.clearAllMocks();
	readFileMock.mockReset();
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({ message_id: 'msg-1', thread_id: THREAD }),
	});
	maybeSingleMock.mockResolvedValue({ data: { user_id: OWNER }, error: null });
	uploadMock.mockResolvedValue({ error: null });
});

function lastPostBody() {
	const [, init] = fetchMock.mock.calls.at(-1)!;
	return JSON.parse((init as RequestInit).body as string);
}

describe('isAllowedMediaPath', () => {
	it('accepts paths under the allowed root', () => {
		expect(isAllowedMediaPath(resolve(ALLOWED_ROOT, 'foo.png'))).toBe(true);
		expect(isAllowedMediaPath(resolve(ALLOWED_ROOT, 'tool-image-generation', 'x.jpg'))).toBe(true);
	});

	it('rejects absolute paths outside the allowed root', () => {
		expect(isAllowedMediaPath('/etc/passwd')).toBe(false);
		expect(isAllowedMediaPath('/tmp/secret.png')).toBe(false);
	});

	it('rejects traversal via .. even when prefix looks allowed', () => {
		const traversal = ALLOWED_ROOT + sep + '..' + sep + 'sensitive.png';
		expect(isAllowedMediaPath(traversal)).toBe(false);
	});

	it('rejects the sibling-directory prefix trick', () => {
		const sibling = ALLOWED_ROOT + '-shadow' + sep + 'evil.png';
		expect(isAllowedMediaPath(sibling)).toBe(false);
	});

	it('rejects relative paths that resolve outside the root', () => {
		expect(isAllowedMediaPath('./foo.png')).toBe(false);
	});
});

describe('uploadMediaAsMarkdown', () => {
	function stub() {
		return { storage: { from: () => ({ upload: uploadMock }) } } as never;
	}

	it('returns blocked marker for paths outside the root (never reads or uploads)', async () => {
		const out = await uploadMediaAsMarkdown(stub(), OWNER, THREAD, '/etc/hosts');
		expect(out).toBe('_(attachment blocked: hosts)_');
		expect(readFileMock).not.toHaveBeenCalled();
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('returns unsupported marker for disallowed extensions', async () => {
		const out = await uploadMediaAsMarkdown(stub(), OWNER, THREAD, resolve(ALLOWED_ROOT, 'doc.pdf'));
		expect(out).toBe('_(attachment: doc.pdf)_');
		expect(readFileMock).not.toHaveBeenCalled();
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('uploads PNG to chat-images and returns a proxy-URL markdown tag', async () => {
		readFileMock.mockResolvedValueOnce(Buffer.from('hello-png'));
		const out = await uploadMediaAsMarkdown(stub(), OWNER, THREAD, resolve(ALLOWED_ROOT, 'cat.png'));
		expect(out).toMatch(
			new RegExp(`^!\\[cat\\.png\\]\\(/api/chat/images/${OWNER}/${THREAD}/[0-9a-f-]+\\.png\\)$`),
		);
		const [objectPath, , opts] = uploadMock.mock.calls[0];
		expect(objectPath).toMatch(new RegExp(`^${OWNER}/${THREAD}/[0-9a-f-]+\\.png$`));
		expect(opts).toMatchObject({ contentType: 'image/png', upsert: false });
	});

	it('returns too-large marker when file exceeds 5 MB (never uploads)', async () => {
		readFileMock.mockResolvedValueOnce(Buffer.alloc(5 * 1024 * 1024 + 1));
		const out = await uploadMediaAsMarkdown(stub(), OWNER, THREAD, resolve(ALLOWED_ROOT, 'big.png'));
		expect(out).toMatch(/^_\(image too large to attach: big\.png, \d+ KB\)_$/);
		expect(uploadMock).not.toHaveBeenCalled();
	});

	it('returns unavailable marker when readFile throws', async () => {
		readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
		const out = await uploadMediaAsMarkdown(stub(), OWNER, THREAD, resolve(ALLOWED_ROOT, 'missing.png'));
		expect(out).toBe('_(attachment unavailable: missing.png)_');
	});

	it('returns unavailable marker when the upload errors', async () => {
		readFileMock.mockResolvedValueOnce(Buffer.from('x'));
		uploadMock.mockResolvedValueOnce({ error: { message: 'storage down' } });
		const out = await uploadMediaAsMarkdown(stub(), OWNER, THREAD, resolve(ALLOWED_ROOT, 'a.png'));
		expect(out).toBe('_(attachment unavailable: a.png)_');
	});
});

describe('extractTitleSentinel', () => {
	it('extracts a TITLE: line and strips it from the body', () => {
		const { title, body } = extractTitleSentinel('Here is your answer.\nTITLE: Quarterly tax plan');
		expect(title).toBe('Quarterly tax plan');
		expect(body).toBe('Here is your answer.');
	});

	it('returns null title and the trimmed body when there is no TITLE line', () => {
		const { title, body } = extractTitleSentinel('Just a reply.');
		expect(title).toBeNull();
		expect(body).toBe('Just a reply.');
	});

	it('strips surrounding quotes and caps the title at 60 chars', () => {
		const long = 'a'.repeat(80);
		const { title } = extractTitleSentinel(`reply\nTITLE: "${long}"`);
		expect(title).toHaveLength(60);
		expect(title).not.toMatch(/"/);
	});

	it('treats a blank TITLE line as no title (and still strips it)', () => {
		const { title, body } = extractTitleSentinel('reply\nTITLE:   ');
		expect(title).toBeNull();
		expect(body).toBe('reply');
	});

	it('only matches an uppercase line-leading TITLE: (not prose)', () => {
		const text = 'We discussed the title: of the book';
		const { title, body } = extractTitleSentinel(text);
		expect(title).toBeNull();
		expect(body).toBe(text);
	});

	it('uses the first TITLE line as the value and strips every TITLE line', () => {
		const { title, body } = extractTitleSentinel('reply\nTITLE: First\nmore\nTITLE: Second');
		expect(title).toBe('First');
		expect(body).toBe('reply\nmore');
	});
});

describe('sendTextToFormat', () => {
	it('POSTs the reply to /api/chat/incoming with bearer auth and role=assistant', async () => {
		const res = await sendTextToFormat(account, { cfg: {}, to: THREAD, text: 'Hello there' });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://format.example/api/chat/incoming'); // trailing slash normalized
		expect(init.method).toBe('POST');
		expect(init.headers.authorization).toBe('Bearer whsec_1234567890abcdef');
		expect(lastPostBody()).toMatchObject({
			thread_id: THREAD,
			content: 'Hello there',
			role: 'assistant',
			model: 'openclaw/default',
		});
		expect(res).toEqual({ messageId: 'msg-1' });
	});

	it('omits suggested_title when there is no TITLE line', async () => {
		await sendTextToFormat(account, { cfg: {}, to: THREAD, text: 'Hello' });
		expect(lastPostBody()).not.toHaveProperty('suggested_title');
	});

	it('forwards a TITLE: sentinel as suggested_title and strips it from content', async () => {
		await sendTextToFormat(account, {
			cfg: {},
			to: THREAD,
			text: 'Your answer.\nTITLE: Tax planning',
		});
		const body = lastPostBody();
		expect(body.suggested_title).toBe('Tax planning');
		expect(body.content).toBe('Your answer.');
	});

	it('never writes chat_messages / chat_threads directly for a text reply', async () => {
		await sendTextToFormat(account, { cfg: {}, to: THREAD, text: 'Hello' });
		// No media → no owner lookup → the DB client is never touched.
		expect(fromMock).not.toHaveBeenCalled();
	});

	it('uploads media and embeds the proxy URL in content (no base64)', async () => {
		readFileMock.mockResolvedValueOnce(Buffer.from('img-bytes'));
		await sendTextToFormat(account, {
			cfg: {},
			to: THREAD,
			text: 'See this',
			mediaUrls: [resolve(ALLOWED_ROOT, 'gen.png')],
		});
		expect(fromMock).toHaveBeenCalledWith('chat_threads'); // owner lookup
		expect(fromMock).not.toHaveBeenCalledWith('chat_messages');
		expect(uploadMock).toHaveBeenCalledTimes(1);
		const body = lastPostBody();
		expect(body.content).toContain('See this');
		expect(body.content).toMatch(
			new RegExp(`!\\[gen\\.png\\]\\(/api/chat/images/${OWNER}/${THREAD}/[0-9a-f-]+\\.png\\)`),
		);
		expect(body.content).not.toContain('base64');
	});

	it('degrades to an unavailable marker when the thread owner cannot be resolved', async () => {
		maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
		readFileMock.mockResolvedValue(Buffer.from('x'));
		await sendTextToFormat(account, {
			cfg: {},
			to: THREAD,
			text: 'See this',
			mediaUrls: [resolve(ALLOWED_ROOT, 'gen.png')],
		});
		expect(uploadMock).not.toHaveBeenCalled();
		expect(lastPostBody().content).toContain('_(attachment unavailable: gen.png)_');
	});

	it('returns null and never POSTs when there is no text and no media', async () => {
		const res = await sendTextToFormat(account, { cfg: {}, to: THREAD, text: '   ' });
		expect(res).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('throws when the endpoint returns a non-2xx response', async () => {
		fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Invalid token' });
		await expect(
			sendTextToFormat(account, { cfg: {}, to: THREAD, text: 'Hello' }),
		).rejects.toThrow(/chat\/incoming POST failed: 401/);
	});

	it('throws when fetch itself rejects (network error)', async () => {
		fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		await expect(
			sendTextToFormat(account, { cfg: {}, to: THREAD, text: 'Hello' }),
		).rejects.toThrow(/ECONNREFUSED/);
	});

	it('returns an empty messageId when the response body is not JSON', async () => {
		fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('not json'); } });
		const res = await sendTextToFormat(account, { cfg: {}, to: THREAD, text: 'Hello' });
		expect(res).toEqual({ messageId: '' });
	});

	it('truncates reply text over the 10K cap, keeping media URLs intact', async () => {
		readFileMock.mockResolvedValueOnce(Buffer.from('img'));
		await sendTextToFormat(account, {
			cfg: {},
			to: THREAD,
			text: 'A'.repeat(11000),
			mediaUrls: [resolve(ALLOWED_ROOT, 'gen.png')],
		});
		const body = lastPostBody();
		expect(body.content.length).toBeLessThanOrEqual(10000);
		expect(body.content).toContain('…(truncated)');
		// media URL survived the truncation
		expect(body.content).toMatch(/\/api\/chat\/images\/.+\.png\)/);
	});

	it('throws when thread_id is missing', async () => {
		await expect(sendTextToFormat(account, { cfg: {}, to: '  ', text: 'Hello' })).rejects.toThrow(
			/missing thread_id/,
		);
	});
});
