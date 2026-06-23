// Format chats are document-first: a DOCUMENT the agent produces belongs in Format,
// not on local disk where its path is unopenable in the chat. This builds the per-turn
// rule telling the agent to save documents as Format documents and link the Format URL.
// Injected into the agent's view (BodyForAgent) ONLY for Format dispatches — never a
// global rule, which would leak as literal text on channels that don't expect it.
// Capability-oriented (no internal tool name): the push agent's doc tool is
// `format-tool.sh create`, not the in-app `create_document` symbol. Split on artifact
// TYPE: documents always publish; non-document files (a script, data file, binary the
// user asked for) keep the local-path freedom. Kept dependency-free so it's unit-testable
// without the gateway's openclaw SDK (mirrors withTitleInstruction).
export function withPublishInstruction(body: string): string {
	const note =
		`(Format chat — delivery rule: when your reply produces a DOCUMENT (a report, plan, draft, ` +
		`notes, or any prose artifact the user would keep), you must save it as a Format document and ` +
		`reference it by its Format URL. Never hand back a document as a local file path or a link to ` +
		`a local file — those are unopenable here. Local paths are only for non-document files the ` +
		`user explicitly asked for (a script, data file, or binary).)`;
	return body ? `${body}\n\n${note}` : note;
}
