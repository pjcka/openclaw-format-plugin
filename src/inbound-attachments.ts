// Shapes a chat message's attachments for the agent turn. Pure + dependency-free
// (no gateway SDK, no Supabase) so it's unit-testable; the download + media-store
// staging glue lives in inbound.ts. MIME conventions mirror Format's
// chat-file-types. OpenClaw's agent turn only renders IMAGE media as native model
// blocks, so the split is: images → staged media (image blocks); text/code →
// inlined into the prompt verbatim (reliable, needs no media-understanding model);
// PDF/Office → staged best-effort (a doc-capable provider can read them) with a
// text note so the agent is never silently blind to an attached file.

export type InboundAttachment = {
	path: string;
	mime: string;
	name: string;
	size?: number;
};

// Caps mirror Format's composer (chat-file-types.ts) and stay under Anthropic's
// per-request media limits. Already enforced at upload; re-checked as defense.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Inlined text is injected into the prompt — capped well below the file cap so one
// large file can't crowd out the turn; longer content is truncated with a marker.
export const MAX_INLINE_TEXT_CHARS = 100_000;

export function isImageMime(mime: string): boolean {
	return mime.startsWith('image/');
}

// Text + code (Format stores these as text/*, plus application/json). Inlined
// verbatim rather than sent as media: Claude reads the text directly with no
// media-understanding model — unlike non-image media on the agent-turn path.
export function isInlineTextMime(mime: string): boolean {
	return mime.startsWith('text/') || mime === 'application/json';
}

export function maxBytesForMime(mime: string): number {
	return isImageMime(mime) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
}

export type AttachmentBuckets = {
	images: InboundAttachment[];
	text: InboundAttachment[];
	other: InboundAttachment[];
};

// images → native image blocks; text → inlined; other (pdf/office/…) → best-effort media.
export function partitionAttachments(attachments: InboundAttachment[]): AttachmentBuckets {
	const images: InboundAttachment[] = [];
	const text: InboundAttachment[] = [];
	const other: InboundAttachment[] = [];
	for (const att of attachments) {
		if (isImageMime(att.mime)) images.push(att);
		else if (isInlineTextMime(att.mime)) text.push(att);
		else other.push(att);
	}
	return { images, text, other };
}

// One decoded text/code file as a labelled fenced block for the prompt.
export function formatInlinedTextFile(name: string, content: string): string {
	const clipped = content.length > MAX_INLINE_TEXT_CHARS;
	const body = clipped ? content.slice(0, MAX_INLINE_TEXT_CHARS) + '\n…(truncated)' : content;
	return `Attached file "${name}":\n\`\`\`\n${body}\n\`\`\``;
}

// Breadcrumb for media the model may not ingest (PDF/Office) so the agent knows a
// file was attached even when the runtime can't read it.
export function formatAttachmentNote(name: string, mime: string): string {
	return `[Attached file "${name}" (${mime}) — provided as media; use it if you can read it.]`;
}
