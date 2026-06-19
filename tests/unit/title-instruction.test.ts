import { describe, it, expect } from 'vitest';
import { withTitleInstruction } from '../../src/title-instruction.ts';

describe('withTitleInstruction', () => {
	it('appends the instruction after the body, separated by a blank line', () => {
		const out = withTitleInstruction('What is the capital of France?', 'Geography quiz');
		expect(out.startsWith('What is the capital of France?\n\n')).toBe(true);
		expect(out).toContain('TITLE: <2–6 word topic>');
	});

	it('includes the current title for drift detection', () => {
		const out = withTitleInstruction('hi', 'Quarterly tax plan');
		expect(out).toContain('current sidebar title: "Quarterly tax plan"');
	});

	it('shows (untitled) when there is no current title', () => {
		expect(withTitleInstruction('hi', null)).toContain('current sidebar title: (untitled)');
		expect(withTitleInstruction('hi', '   ')).toContain('current sidebar title: (untitled)');
	});

	it('returns just the note when the body is empty', () => {
		const out = withTitleInstruction('', 'X');
		expect(out.startsWith('(Format chat')).toBe(true);
	});

	it('tells the agent the line is stripped and that manual rename wins', () => {
		const out = withTitleInstruction('hi', null);
		expect(out).toContain('stripped before the user');
		expect(out).toContain('manual rename always wins');
	});
});
