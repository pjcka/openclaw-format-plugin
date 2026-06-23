import { describe, it, expect } from 'vitest';
import { withPublishInstruction } from '../../src/publish-instruction.ts';

describe('withPublishInstruction', () => {
	it('appends the instruction after the body, separated by a blank line', () => {
		const out = withPublishInstruction('Write me a project plan.');
		expect(out.startsWith('Write me a project plan.\n\n')).toBe(true);
		expect(out).toContain('save it as a Format document');
	});

	it('returns just the note when the body is empty', () => {
		const out = withPublishInstruction('');
		expect(out.startsWith('(Format chat')).toBe(true);
	});

	it('makes the document rule categorical (must save, never a local path)', () => {
		const out = withPublishInstruction('hi');
		expect(out).toContain('you must save it as a Format document');
		expect(out).toContain('Never hand back a document as a local file path');
	});

	it('is capability-oriented — does not name the in-app create_document symbol', () => {
		expect(withPublishInstruction('hi')).not.toContain('create_document');
	});

	it('still permits local paths for non-document files', () => {
		const out = withPublishInstruction('hi');
		expect(out).toContain('non-document files');
	});
});
