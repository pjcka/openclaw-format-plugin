#!/usr/bin/env node
// Diagnostic for the 35s Realtime re-subscribe cycle observed in the gateway.
// Spins up a Realtime channel with the same client config the plugin uses
// (service-role secret key, no auth refresh, no session persist), enables
// Phoenix protocol logging, and prints every channel/socket event for ~75s.
// Long enough to capture 2 full cycles of the observed CLOSED → reconnect.
//
// Usage:
//   node scripts/test-realtime-channel-lifetime.mjs
//
// Env: needs PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (read
// from the worktree's .env automatically since this runs from the worktree root).

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
	readFileSync('.env', 'utf8')
		.split('\n')
		.filter((l) => l.includes('='))
		.map((l) => {
			const [k, ...rest] = l.split('=');
			return [k.trim(), rest.join('=').trim().replace(/^["']|["']$/g, '')];
		})
);

const SUPABASE_URL = env.PUBLIC_SUPABASE_URL;
const SECRET = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SECRET) {
	console.error('Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
	process.exit(1);
}

console.log(`[test] connecting to ${SUPABASE_URL}`);
console.log(`[test] secret prefix: ${SECRET.slice(0, 12)}…`);
console.log('[test] WARNING: stdout may include redacted-but-still-sensitive transport URLs — review before sharing');

// supabase-js's Realtime client logs the full WebSocket URL on `transport`
// events, which includes `?apikey=<full-secret>`. Redact before stdout.
const REDACT_APIKEY = /(\bapikey=)[^&\s"]+/g;
const redact = (s) => (typeof s === 'string' ? s.replace(REDACT_APIKEY, '$1<redacted>') : s);

const supabase = createClient(SUPABASE_URL, SECRET, {
	auth: { autoRefreshToken: false, persistSession: false },
	realtime: {
		logger: (kind, msg, data) => {
			const ts = new Date().toISOString().slice(11, 23);
			const safeMsg = redact(msg);
			const payload = data !== undefined ? redact(JSON.stringify(data)) : '';
			console.log(`[${ts}] [${kind}] ${safeMsg} ${payload}`);
		}
	}
});

const channel = supabase
	.channel('test-channel-lifetime')
	.on(
		'postgres_changes',
		{ event: 'INSERT', schema: 'public', table: 'chat_messages', filter: 'role=eq.user' },
		(payload) => {
			const ts = new Date().toISOString().slice(11, 23);
			console.log(`[${ts}] [event] postgres INSERT received: ${payload.new?.id?.slice(0, 8)}`);
		}
	)
	.subscribe((status, err) => {
		const ts = new Date().toISOString().slice(11, 23);
		console.log(`[${ts}] [status] ${status}${err ? ` err=${err.message ?? err}` : ''}`);
	});

console.log('[test] running for 75s — Ctrl-C to stop early');
setTimeout(() => {
	console.log('[test] done');
	void supabase.removeChannel(channel);
	process.exit(0);
}, 75_000);
