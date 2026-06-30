// Format chats are document-first: when the user asks to change an EXISTING document, the
// agent should edit it in place (a reviewable suggestion) rather than spin up a new document
// or just narrate the change in chat. This builds the per-turn rule that nudges
// edit-over-recreate — the counterpart to withPublishInstruction's create rule, so the agent
// has a clear create-new vs change-existing split. Injected into the agent's view
// (BodyForAgent) ONLY for Format dispatches — never a global rule, which would leak as literal
// text on channels that don't expect it. Capability-oriented (no internal tool name): the push
// agent's edit tool is `format-tool.sh edit`, not the in-app propose_edits symbol. Kept
// dependency-free so it's unit-testable without the gateway's openclaw SDK (mirrors
// withPublishInstruction / withTitleInstruction).
export function withEditInstruction(body: string): string {
	const note =
		`(Format chat — editing rule: when the user asks you to change an existing Format ` +
		`document — fix, rewrite, update, retitle, or check off a task — edit that document in ` +
		`place rather than creating a new document or only describing the change in chat. Your ` +
		`edit is applied as a suggestion the user reviews and accepts or rejects, so nothing is ` +
		`overwritten until they accept. Target the specific block you are changing.)`;
	return body ? `${body}\n\n${note}` : note;
}
