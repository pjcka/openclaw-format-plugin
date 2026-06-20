// Outbound delivery — the agent produced a reply and OpenClaw's core is asking
// us to "send" it back to Format. Our transport is an HTTP POST to Format's
// `/api/chat/incoming` (bearer auth): the SECURITY DEFINER RPC behind it owns
// message insertion AND the manual-wins title guard, so the plugin no longer
// writes chat_messages / chat_threads directly (the old service-role bypass).
// Format's web client subscribes via Realtime and picks up the inserted row.
//
// Media: reply images are uploaded to the private `chat-images` Storage bucket
// (migration 081) via the service-role client and referenced by a short
// `/api/chat/images/...` proxy URL. Base64-inlining would blow the endpoint's
// 10K content cap, and chat only renders same-origin proxy URLs / base64 (see
// Format's sanitize-markdown allow-list).
//
// Plugin runs inside the OpenClaw gateway process, outside the SvelteKit
// module graph — `$lib/utils/logger` is not reachable here. Using `console.*`
// directly is the sanctioned pattern (see CLAUDE.md "Logging" section).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { FormatResolvedAccount } from './setup.ts';

// Media paths supplied by the agent are only trusted when they resolve under
// the OpenClaw media directory. The plugin runs with service-role storage access
// and a filesystem read — without this containment, a prompt-inject of
// `MEDIA:/etc/hosts` (with a .png rename pattern) could exfiltrate arbitrary
// files readable by the gateway process into the chat-images bucket. Scope to
// the one directory where OpenClaw tools legitimately write media outputs.
const ALLOWED_MEDIA_ROOT = resolve(homedir(), '.openclaw', 'media') + sep;

// Exported for tests only — covers the path-traversal containment guard.
export function isAllowedMediaPath(path: string): boolean {
	const resolved = resolve(path);
	return (resolved + sep).startsWith(ALLOWED_MEDIA_ROOT);
}

// chat-images bucket cap (migration 081) — matches the editor's document-images
// 5 MB limit. Since the reply carries a URL, not the bytes, this only bounds the
// upload, not the message size.
const CHAT_IMAGES_BUCKET = 'chat-images';
const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp'
};

/**
 * Upload a local reply image to the chat-images bucket and return a markdown
 * image tag pointing at the auth-gated `/api/chat/images` proxy. URL-based (not
 * base64) so the reply fits the incoming-chat content cap. Returns a text
 * fallback marker when the file is blocked, missing, too large, or unsupported —
 * chat stays functional even when an image can't attach.
 */
// Exported for tests only; consumed by sendTextToFormat below.
export async function uploadMediaAsMarkdown(
	supabase: SupabaseClient,
	ownerId: string,
	threadId: string,
	path: string
): Promise<string> {
	const name = basename(path);
	if (!isAllowedMediaPath(path)) {
		console.warn('[format-plugin] rejecting media path outside allowed root', {
			path,
			allowedRoot: ALLOWED_MEDIA_ROOT
		});
		return `_(attachment blocked: ${name})_`;
	}
	const ext = extname(path).toLowerCase();
	const mime = MIME_BY_EXT[ext];
	if (!mime) return `_(attachment: ${name})_`;
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (err) {
		console.warn('[format-plugin] read media failed', {
			path,
			error: err instanceof Error ? err.message : err
		});
		return `_(attachment unavailable: ${name})_`;
	}
	if (bytes.byteLength > MAX_UPLOAD_IMAGE_BYTES) {
		const kb = Math.round(bytes.byteLength / 1024);
		return `_(image too large to attach: ${name}, ${kb} KB)_`;
	}
	const objectPath = `${ownerId}/${threadId}/${crypto.randomUUID()}${ext}`;
	const { error } = await supabase.storage
		.from(CHAT_IMAGES_BUCKET)
		.upload(objectPath, bytes, { contentType: mime, upsert: false });
	if (error) {
		console.warn('[format-plugin] media upload failed', { path, error: error.message });
		return `_(attachment unavailable: ${name})_`;
	}
	return `![${name}](/api/chat/images/${objectPath})`;
}

// Cache service-role clients per account so we don't spin up a new HTTP pool
// on every turn. Keyed by accountId + supabaseUrl (hash of the credential would
// be overkill — accountId is unique per resolved config entry). Still needed for
// the media upload + thread-owner lookup; shared with inbound.ts.
const clientCache = new Map<string, SupabaseClient>();

function clientKey(account: FormatResolvedAccount): string {
	return `${account.accountId}::${account.supabaseUrl}`;
}

export function getSupabaseClient(account: FormatResolvedAccount): SupabaseClient {
	const key = clientKey(account);
	const cached = clientCache.get(key);
	if (cached) return cached;
	const client = createClient(account.supabaseUrl, account.supabaseServiceRole, {
		auth: { autoRefreshToken: false, persistSession: false },
		realtime: { heartbeatIntervalMs: 10_000 } // halved from Phoenix default; gateway event-loop saturation pushes heartbeat callbacks past the ~30s server timeout
	});
	clientCache.set(key, client);
	return client;
}

// The chat-images object path is owner-scoped (`<ownerId>/<threadId>/<uuid>`),
// mirroring document-images. Resolve the thread's owner via service-role; only
// needed when a turn actually carries media.
async function resolveThreadOwner(
	supabase: SupabaseClient,
	threadId: string
): Promise<string | null> {
	const { data, error } = await supabase
		.from('chat_threads')
		.select('user_id')
		.eq('id', threadId)
		.maybeSingle();
	if (error) {
		console.warn('[format-plugin] thread owner lookup failed', { threadId, error: error.message });
		return null;
	}
	return (data as { user_id?: string } | null)?.user_id ?? null;
}

type SendTextParams = {
	cfg: unknown;
	to: string;
	text: string;
	accountId?: string;
	replyToId?: string;
	threadId?: string | number;
	/** Local media paths from the agent (e.g. image_generate output). Each is
	 *  uploaded to the chat-images bucket and appended as a markdown image URL. */
	mediaUrls?: string[];
};

type SendTextResult = { messageId: string };

// OpenClaw emits `MEDIA:/path` as a sentinel in the final text when the agent
// produced an attachment. We strip those lines since the media is handled
// separately via mediaUrls — leaving them would render as literal text.
const MEDIA_SENTINEL_LINE_RE = /^\s*MEDIA:.*$/gm;

function stripMediaSentinels(text: string): string {
	return text.replace(MEDIA_SENTINEL_LINE_RE, '').trim();
}

// The OpenClaw agent emits an optional `TITLE: <label>` line with its reply —
// same sentinel idea as MEDIA: above. Uppercase + line-leading only, so prose
// that merely contains "title:" isn't stripped. Format owns persistence (a
// manual rename wins, enforced server-side); the agent only suggests.
// Strip the whole line incl. its trailing newline so removal doesn't leave a
// blank line mid-body; the capture variant (/m, no /g) reads the first value.
const TITLE_SENTINEL_LINE_RE = /^[ \t]*TITLE:.*\n?/gm;
const TITLE_SENTINEL_CAPTURE_RE = /^[ \t]*TITLE:[ \t]*(.*)$/m;
const TITLE_MAX_CHARS = 60;

// Exported for tests only; consumed by sendTextToFormat below.
export function extractTitleSentinel(text: string): { title: string | null; body: string } {
	const source = text ?? '';
	const match = source.match(TITLE_SENTINEL_CAPTURE_RE);
	const body = source.replace(TITLE_SENTINEL_LINE_RE, '').trim();
	if (!match) return { title: null, body };

	const cleaned = match[1]
		.trim()
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	// Cap by code point, not UTF-16 unit, so a boundary emoji can't leave a lone surrogate.
	const normalized = [...cleaned].slice(0, TITLE_MAX_CHARS).join('').trim();
	return { title: normalized || null, body };
}

export async function sendTextToFormat(
	account: FormatResolvedAccount,
	params: SendTextParams
): Promise<SendTextResult | null> {
	const threadId = (params.to ?? '').trim();
	if (!threadId) {
		throw new Error('[format-plugin] sendText: missing thread_id in `to`');
	}

	// The agent may suggest a sidebar title via a `TITLE:` line; forward it as
	// `suggested_title` so the RPC applies the manual-wins guard (no client-side
	// title write). Absent → omitted → Format keeps the existing title.
	const { title: suggestedTitle, body } = extractTitleSentinel(params.text ?? '');
	const cleanedText = stripMediaSentinels(body);

	const mediaPaths = (params.mediaUrls ?? [])
		.map((p) => p?.trim())
		.filter((p): p is string => !!p);
	const mediaMarkdown: string[] = [];
	if (mediaPaths.length) {
		const supabase = getSupabaseClient(account);
		const ownerId = await resolveThreadOwner(supabase, threadId);
		for (const path of mediaPaths) {
			mediaMarkdown.push(
				ownerId
					? await uploadMediaAsMarkdown(supabase, ownerId, threadId, path)
					: `_(attachment unavailable: ${basename(path)})_`
			);
		}
	}

	// /api/chat/incoming hard-caps content at 10K chars; truncate long reply TEXT
	// (keeping the short media URLs intact) rather than 400 and lose the whole reply.
	const CONTENT_MAX_CHARS = 10000; // matches Format's CHAT_INCOMING_MAX_CONTENT
	const mediaBlock = mediaMarkdown.filter(Boolean).join('\n\n');
	let text = cleanedText;
	const sep = text && mediaBlock ? 2 : 0;
	if (text.length + sep + mediaBlock.length > CONTENT_MAX_CHARS) {
		const marker = '\n\n…(truncated)';
		const budget = Math.max(0, CONTENT_MAX_CHARS - mediaBlock.length - sep - marker.length);
		text = text.slice(0, budget).trimEnd() + marker;
	}
	let content = [text, mediaBlock].filter(Boolean).join('\n\n');
	// Backstop for a pathological media-heavy turn (text already trimmed): land a clipped reply, never a 400.
	if (content.length > CONTENT_MAX_CHARS) content = content.slice(0, CONTENT_MAX_CHARS);
	// An agent turn with no text and no usable media would leave content empty —
	// skip to avoid an empty assistant row (and the endpoint requires content).
	if (!content) return null;

	const endpoint = `${account.formatUrl.replace(/\/+$/, '')}/api/chat/incoming`;
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${account.inboundWebhookSecret}`
		},
		body: JSON.stringify({
			thread_id: threadId,
			content,
			role: 'assistant',
			model: 'openclaw/default',
			...(suggestedTitle ? { suggested_title: suggestedTitle } : {})
		})
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		console.error('[format-plugin] chat/incoming POST failed', {
			threadId,
			status: res.status,
			body: detail.slice(0, 200)
		});
		throw new Error(`chat/incoming POST failed: ${res.status}`);
	}

	const data = (await res.json().catch(() => null)) as { message_id?: string } | null;
	return { messageId: data?.message_id ?? '' };
}
