import { describe, it, expect } from 'vitest';
import {
	isImageMime,
	isInlineTextMime,
	maxBytesForMime,
	partitionAttachments,
	formatInlinedTextFile,
	formatAttachmentNote,
	MAX_IMAGE_BYTES,
	MAX_FILE_BYTES,
	MAX_INLINE_TEXT_CHARS,
	type InboundAttachment
} from '../../src/inbound-attachments.ts';

const att = (name: string, mime: string): InboundAttachment => ({
	path: `owner/thread/${name}`,
	mime,
	name
});

describe('isImageMime', () => {
	it('is true for image/* and false otherwise', () => {
		expect(isImageMime('image/png')).toBe(true);
		expect(isImageMime('image/webp')).toBe(true);
		expect(isImageMime('application/pdf')).toBe(false);
		expect(isImageMime('text/plain')).toBe(false);
	});
});

describe('isInlineTextMime', () => {
	it('is true for text/* and application/json', () => {
		expect(isInlineTextMime('text/plain')).toBe(true);
		expect(isInlineTextMime('text/markdown')).toBe(true);
		expect(isInlineTextMime('text/x-typescript')).toBe(true);
		expect(isInlineTextMime('application/json')).toBe(true);
	});
	it('is false for images, PDFs and Office docs', () => {
		expect(isInlineTextMime('image/png')).toBe(false);
		expect(isInlineTextMime('application/pdf')).toBe(false);
		expect(
			isInlineTextMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
		).toBe(false);
	});
});

describe('maxBytesForMime', () => {
	it('caps images tighter than other files', () => {
		expect(maxBytesForMime('image/png')).toBe(MAX_IMAGE_BYTES);
		expect(maxBytesForMime('application/pdf')).toBe(MAX_FILE_BYTES);
		expect(maxBytesForMime('text/plain')).toBe(MAX_FILE_BYTES);
	});
});

describe('partitionAttachments', () => {
	it('splits images, inlinable text, and other binaries, preserving order', () => {
		const { images, text, other } = partitionAttachments([
			att('a.png', 'image/png'),
			att('notes.txt', 'text/plain'),
			att('report.pdf', 'application/pdf'),
			att('data.json', 'application/json'),
			att('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
			att('b.webp', 'image/webp')
		]);
		expect(images.map((a) => a.name)).toEqual(['a.png', 'b.webp']);
		expect(text.map((a) => a.name)).toEqual(['notes.txt', 'data.json']);
		expect(other.map((a) => a.name)).toEqual(['report.pdf', 'deck.pptx']);
	});

	it('returns empty buckets for no attachments', () => {
		expect(partitionAttachments([])).toEqual({ images: [], text: [], other: [] });
	});
});

describe('formatInlinedTextFile', () => {
	it('wraps content in a labelled fenced block', () => {
		const out = formatInlinedTextFile('secret.txt', 'the password is hunter2');
		expect(out).toContain('Attached file "secret.txt":');
		expect(out).toContain('```\nthe password is hunter2\n```');
	});

	it('truncates content past the char cap with a marker', () => {
		const out = formatInlinedTextFile('big.txt', 'x'.repeat(MAX_INLINE_TEXT_CHARS + 500));
		expect(out).toContain('…(truncated)');
		// body is clipped to the cap (plus the fence/label scaffolding)
		expect(out.length).toBeLessThan(MAX_INLINE_TEXT_CHARS + 200);
	});

	it('does not truncate content at or under the cap', () => {
		const out = formatInlinedTextFile('ok.txt', 'short');
		expect(out).not.toContain('…(truncated)');
	});
});

describe('formatAttachmentNote', () => {
	it('names the file and its mime', () => {
		const out = formatAttachmentNote('report.pdf', 'application/pdf');
		expect(out).toContain('report.pdf');
		expect(out).toContain('application/pdf');
	});
});
