import { describe, it, expect } from 'vitest';
import { withEditInstruction } from '../../src/edit-instruction.ts';

describe('withEditInstruction', () => {
	it('appends the instruction after the body, separated by a blank line', () => {
		const out = withEditInstruction('Fix the typo in my notes.');
		expect(out.startsWith('Fix the typo in my notes.\n\n')).toBe(true);
		expect(out).toContain('edit that document in place');
	});

	it('returns just the note when the body is empty', () => {
		const out = withEditInstruction('');
		expect(out.startsWith('(Format chat')).toBe(true);
	});

	it('makes the change-existing rule categorical', () => {
		const out = withEditInstruction('hi');
		expect(out).toContain('change an existing Format');
		expect(out).toContain('edit that document in place');
	});

	it('makes the create-vs-edit split explicit (edit existing, do not recreate or only narrate)', () => {
		const out = withEditInstruction('hi');
		expect(out).toContain('rather than creating a new document');
		expect(out).toContain('only describing the change in chat');
	});

	it('states the edit is a reviewable suggestion (nothing overwritten until accepted)', () => {
		const out = withEditInstruction('hi');
		expect(out).toContain('accepts or rejects');
		expect(out).toContain('until they accept');
	});

	it('is capability-oriented — does not name internal tool symbols', () => {
		const out = withEditInstruction('hi');
		expect(out).not.toContain('propose_edits');
		expect(out).not.toContain('create_document');
	});
});
