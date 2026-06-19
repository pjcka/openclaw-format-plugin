// Outbound delivery — the agent produced a reply and OpenClaw's core is asking
// us to "send" it back to Format. Our "transport" is a Supabase INSERT into
// chat_messages; Format's web client subscribes via Realtime and picks it up.
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
// the OpenClaw media directory. The plugin runs with service-role DB access
// and a filesystem read — without this containment, a prompt-inject of
// `MEDIA:/etc/hosts` (with a .png rename pattern) could exfiltrate arbitrary
// files readable by the gateway process into a chat_messages row. Scope to
// the one directory where OpenClaw tools legitimately write media outputs.
const ALLOWED_MEDIA_ROOT = resolve(homedir(), '.openclaw', 'media') + sep;

// Exported for tests only — covers the path-traversal containment guard.
export function isAllowedMediaPath(path: string): boolean {
	const resolved = resolve(path);
	return (resolved + sep).startsWith(ALLOWED_MEDIA_ROOT);
}

// Keep inlined images small-ish. Supabase rows are limited to ~1 MB; at ~33%
// base64 inflation, 600 KB image → ~800 KB data URL + text overhead still fits.
// Format's editor uses 1 MB for pasted images; chat is bursty so we stay
// conservative and skip any file bigger than this with a visible note.
const MAX_INLINE_IMAGE_BYTES = 600 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp'
};

/**
 * Read a local media path, base64-encode, and return a markdown image tag.
 * Returns a text fallback when the file is missing, too large, or an
 * unsupported type — chat stays functional even when an image can't inline.
 */
// Exported for tests only; consumed by sendTextToFormat below.
export async function inlineMediaAsMarkdown(path: string): Promise<string> {
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
	try {
		const bytes = await readFile(path);
		if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
			const kb = Math.round(bytes.byteLength / 1024);
			return `_(image too large to inline: ${name}, ${kb} KB)_`;
		}
		const b64 = bytes.toString('base64');
		return `![${name}](data:${mime};base64,${b64})`;
	} catch (err) {
		console.warn('[format-plugin] inline media failed', {
			path,
			error: err instanceof Error ? err.message : err
		});
		return `_(attachment unavailable: ${name})_`;
	}
}

// Cache service-role clients per account so we don't spin up a new HTTP pool
// on every turn. Keyed by accountId + supabaseUrl (hash of the credential would
// be overkill — accountId is unique per resolved config entry).
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

type SendTextParams = {
	cfg: unknown;
	to: string;
	text: string;
	accountId?: string;
	replyToId?: string;
	threadId?: string | number;
	/** Local media paths from the agent (e.g. image_generate output). Each is
	 *  inlined as a base64 markdown image appended to the message body. */
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

export async function sendTextToFormat(
	account: FormatResolvedAccount,
	params: SendTextParams
): Promise<SendTextResult | null> {
	const supabase = getSupabaseClient(account);
	const threadId = (params.to ?? '').trim();
	if (!threadId) {
		throw new Error('[format-plugin] sendText: missing thread_id in `to`');
	}

	const cleanedText = stripMediaSentinels(params.text ?? '');
	const mediaMarkdown: string[] = [];
	for (const path of params.mediaUrls ?? []) {
		if (!path?.trim()) continue;
		mediaMarkdown.push(await inlineMediaAsMarkdown(path.trim()));
	}

	const content = [cleanedText, ...mediaMarkdown].filter(Boolean).join('\n\n');
	// An agent turn that's entirely a MEDIA-sentinel with no real media paths
	// (shouldn't happen, but defensive) would leave content empty — skip to
	// avoid writing an empty assistant row that looks like a glitch.
	if (!content) return null;

	const { data, error } = await supabase
		.from('chat_messages')
		.insert({
			thread_id: threadId,
			role: 'assistant',
			content,
			model: 'openclaw/default'
		})
		.select('id')
		.single();

	if (error) {
		// Surface the DB error with enough context to diagnose in gateway logs.
		console.error('[format-plugin] sendText insert failed', {
			threadId,
			code: error.code,
			message: error.message,
			details: error.details
		});
		throw new Error(`chat_messages insert failed: ${error.message}`);
	}

	return { messageId: data.id };
}
