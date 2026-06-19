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
	inlineMediaAsMarkdown
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
