// Format chats have a sidebar title; other channels don't. This builds the
// per-turn instruction telling the agent it may suggest one via a `TITLE:` line.
// It is injected into the agent's view (BodyForAgent) ONLY for Format dispatches —
// never as a global rule, which would leak `TITLE:` as literal text on channels
// whose adapter doesn't strip it (e.g. iMessage). Drift-aware: the current title
// is included so the agent retitles only on a real topic change; the manual-wins
// guard is enforced server-side regardless. Kept dependency-free so it's unit-
// testable without the gateway's openclaw SDK.
export function withTitleInstruction(body: string, currentTitle: string | null): string {
	const shown = currentTitle?.trim() ? `"${currentTitle.trim()}"` : '(untitled)';
	const note =
		`(Format chat — current sidebar title: ${shown}. After your reply, set the title if needed: ` +
		`when the title is missing, a raw or truncated snippet of an earlier message, or no longer ` +
		`matches the conversation's topic, add a final line ` +
		'`TITLE: <2–6 word topic>`' +
		` with a clean Title-Case label. If the current title is already a good short topic label, omit ` +
		`the line. It is stripped before the user sees your reply, and a manual rename always wins.)`;
	return body ? `${body}\n\n${note}` : note;
}
