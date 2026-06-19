// Tests for outbound.ts — the path-traversal guard (isAllowedMediaPath) and
// the end-to-end inlining behavior (inlineMediaAsMarkdown). Originally
// imported from Format's tree (follow-up #275 from PR #274) and migrated
// here when the plugin moved to its own repo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import('node:fs/promises');
	return { ...actual, default: { ...actual, readFile: readFileMock }, readFile: readFileMock };
});

// Not imported directly — we drive it via readFileMock below.
import {
	isAllowedMediaPath,
	inlineMediaAsMarkdown,
	extractTitleSentinel,
	persistThreadTitle
} from '../../src/outbound.ts';

const ALLOWED_ROOT = resolve(homedir(), '.openclaw', 'media');

beforeEach(() => {
	readFileMock.mockReset();
});

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
		// path.resolve normalizes .. before the prefix check.
		const traversal = ALLOWED_ROOT + sep + '..' + sep + 'sensitive.png';
		expect(isAllowedMediaPath(traversal)).toBe(false);
	});

	it('rejects the sibling-directory prefix trick', () => {
		// Example: if ALLOWED_ROOT = /Users/pa/.openclaw/media, a path like
		// /Users/pa/.openclaw/media-shadow/evil.png starts with the root string
		// but is NOT a child — the trailing `sep` check blocks it.
		const sibling = ALLOWED_ROOT + '-shadow' + sep + 'evil.png';
		expect(isAllowedMediaPath(sibling)).toBe(false);
	});

	it('rejects relative paths that resolve outside the root', () => {
		// resolve() against cwd; pretty much always != the openclaw media dir.
		expect(isAllowedMediaPath('./foo.png')).toBe(false);
	});
});

describe('inlineMediaAsMarkdown', () => {
	it('returns blocked marker for paths outside the root', async () => {
		const out = await inlineMediaAsMarkdown('/etc/hosts');
		expect(out).toBe('_(attachment blocked: hosts)_');
		expect(readFileMock).not.toHaveBeenCalled();
	});

	it('returns unsupported marker for disallowed extensions', async () => {
		const out = await inlineMediaAsMarkdown(resolve(ALLOWED_ROOT, 'doc.pdf'));
		expect(out).toBe('_(attachment: doc.pdf)_');
		expect(readFileMock).not.toHaveBeenCalled();
	});

	it('inlines PNG as base64 markdown when file is readable', async () => {
		const bytes = Buffer.from('hello-png');
		readFileMock.mockResolvedValueOnce(bytes);

		const path = resolve(ALLOWED_ROOT, 'cat.png');
		const out = await inlineMediaAsMarkdown(path);
		const b64 = bytes.toString('base64');

		expect(out).toBe(`![cat.png](data:image/png;base64,${b64})`);
		expect(readFileMock).toHaveBeenCalledWith(path);
	});

	it('maps .jpg and .jpeg both to image/jpeg', async () => {
		readFileMock.mockResolvedValue(Buffer.from('j'));
		const jpg = await inlineMediaAsMarkdown(resolve(ALLOWED_ROOT, 'a.jpg'));
		const jpeg = await inlineMediaAsMarkdown(resolve(ALLOWED_ROOT, 'b.jpeg'));
		expect(jpg).toContain('data:image/jpeg;base64,');
		expect(jpeg).toContain('data:image/jpeg;base64,');
	});

	it('returns too-large marker when file exceeds 600 KB', async () => {
		const big = Buffer.alloc(600 * 1024 + 1);
		readFileMock.mockResolvedValueOnce(big);

		const out = await inlineMediaAsMarkdown(resolve(ALLOWED_ROOT, 'big.png'));
		expect(out).toMatch(/^_\(image too large to inline: big\.png, \d+ KB\)_$/);
	});

	it('returns unavailable marker when readFile throws', async () => {
		readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
		const out = await inlineMediaAsMarkdown(resolve(ALLOWED_ROOT, 'missing.png'));
		expect(out).toBe('_(attachment unavailable: missing.png)_');
	});
});

// The OpenClaw agent emits an optional `TITLE: <label>` line with its reply
// (mirrors the existing MEDIA: sentinel). We pull it out, strip it from the
// body, and persist it under the same manual-wins guard Format uses.
describe('extractTitleSentinel', () => {
	it('extracts a TITLE: line and strips it from the body', () => {
		const { title, body } = extractTitleSentinel(
			'Here is your answer.\nTITLE: Quarterly tax plan'
		);
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

describe('persistThreadTitle', () => {
	function makeThreadStub() {
		const rec: { vals: unknown; eqs: Record<string, unknown> } = { vals: null, eqs: {} };
		const builder = {
			update(v: unknown) {
				rec.vals = v;
				return builder;
			},
			eq(col: string, val: unknown) {
				rec.eqs[col] = val;
				return builder;
			},
			then(resolve: (r: { error: null }) => void) {
				resolve({ error: null });
			}
		};
		const from = vi.fn(() => builder);
		return { supabase: { from } as never, from, rec };
	}

	it('updates chat_threads.title guarded by title_source = auto', async () => {
		const { supabase, rec } = makeThreadStub();
		await persistThreadTitle(supabase, 'thread-1', 'New Title');
		expect(rec.vals).toEqual({ title: 'New Title' });
		expect(rec.eqs).toEqual({ id: 'thread-1', title_source: 'auto' });
	});

	it('is a no-op when the title is null (never touches the DB)', async () => {
		const { supabase, from } = makeThreadStub();
		await persistThreadTitle(supabase, 'thread-1', null);
		expect(from).not.toHaveBeenCalled();
	});

	it('never throws when the update returns a DB error (must not fail the reply)', async () => {
		const builder = {
			update() {
				return builder;
			},
			eq() {
				return builder;
			},
			then(resolve: (r: { error: { message: string } }) => void) {
				resolve({ error: { message: 'boom' } });
			}
		};
		const supabase = { from: () => builder } as never;
		await expect(persistThreadTitle(supabase, 'thread-1', 'X')).resolves.toBeUndefined();
	});
});
