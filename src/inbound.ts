// Inbound pipeline — `base.gateway.startAccount(ctx)` runs for the lifetime
// of the account. Polls Supabase for new user messages on chat_messages,
// atomically claims them (avoiding double-dispatch if another worker ever
// runs), and hands each off to dispatchInboundMessage so the OpenClaw agent
// pipeline processes it natively — including subagent waits, tool calls, etc.
//
// Plugin runs inside the OpenClaw gateway process, outside the SvelteKit
// module graph — `$lib/utils/logger` is not reachable here. Using `console.*`
// (and the `log` callback passed in via `StartAccountCtx`) is the sanctioned
// pattern for plugin logging (see CLAUDE.md "Logging" section).
//
// Polling (not Realtime) because Supabase Realtime subscriptions consistently
// returned CHANNEL_ERROR inside the gateway process, even though the same
// pattern works in a standalone Node script. For Format's current
// single-user-single-gateway deployment, a 2s poll is indistinguishable from
// Realtime-driven dispatch. Revisit if we scale past that.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
	createReplyDispatcher,
	dispatchInboundMessage
} from 'openclaw/plugin-sdk/reply-runtime';
import { createChannelReplyPipeline } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import type { FormatResolvedAccount } from './setup.ts';
import { getSupabaseClient, sendTextToFormat } from './outbound.ts';
import { setRunning, setStage, setIdle, setFailed, setActiveWorkers, writeHeartbeat } from './status.ts';
import { startWorkersPoll } from './workers-poller.ts';

// Per-thread running poller. Lets a new turn take over cleanly and prevents
// the post-turn tail from overlapping with a fresh turn's poll.
const activeWorkerPollers = new Map<string, () => void>();
// Wait this long after a turn ends before the final clear of active_workers.
// Lets short ACP subworkers remain visible post-completion via the poller's
// linger window (see workers-poller.ts WORKER_LINGER_MS).
const POST_TURN_TAIL_MS = 10_000;
// How often to check chat_threads.status for a user-initiated cancel. Cheap
// single-row SELECT; 1s keeps the Stop button feeling responsive without
// hammering the DB.
const CANCEL_POLL_INTERVAL_MS = 1000;

async function sweepStaleOnStartup(
	supabase: SupabaseClient,
	userId: string,
	log: StartAccountCtx['log']
): Promise<void> {
	// Leave chat_messages.status='delivered' rows alone — 'failed' is not a valid msg status (migration 029).
	const { data: threads, error: threadErr } = await supabase
		.from('chat_threads')
		.update({
			status: 'failed',
			active_run_stage: 'Interrupted — gateway restarted',
			active_run_started_at: null,
			active_workers: []
		})
		.eq('user_id', userId)
		.in('status', ['running', 'cancelling'])
		.select('id');
	if (threadErr) throw threadErr;

	const n = threads?.length ?? 0;
	if (n > 0) log?.info?.(`[format] startup sweep: marked ${n} thread(s) interrupted`);
}

function startCancelWatcher(opts: {
	supabase: SupabaseClient;
	threadId: string;
	abortController: AbortController;
	log?: StartAccountCtx['log'];
}): () => void {
	const { supabase, threadId, abortController, log } = opts;
	let running = true;
	const tick = async () => {
		if (!running || abortController.signal.aborted) return;
		try {
			const { data } = await supabase
				.from('chat_threads')
				.select('status')
				.eq('id', threadId)
				.single();
			if (data?.status === 'cancelling' && !abortController.signal.aborted) {
				log?.info?.(`[format] cancel observed for ${threadId.slice(0, 8)} — aborting dispatch`);
				abortController.abort();
			}
		} catch {
			/* best-effort; next tick */
		}
	};
	const timer = setInterval(tick, CANCEL_POLL_INTERVAL_MS);
	return () => {
		running = false;
		clearInterval(timer);
	};
}

type StartAccountCtx = {
	account: FormatResolvedAccount;
	cfg: unknown;
	runtime?: unknown;
	abortSignal: AbortSignal;
	log?: {
		info?: (msg: string, extra?: unknown) => void;
		warn?: (msg: string, extra?: unknown) => void;
		error?: (msg: string, extra?: unknown) => void;
	};
};

type ChatMessageRow = {
	id: string;
	thread_id: string;
	content: string;
	created_at?: string;
};

const CHANNEL_ID = 'format';
const AGENT_ID = 'main';
const POLL_INTERVAL_MS = 2000;

export async function startFormatAccount(ctx: StartAccountCtx): Promise<void> {
	const { account, cfg, abortSignal, log } = ctx;
	// Share the cached service-role client with outbound.ts so the gateway
	// process only maintains one HTTP pool per account. See #277.
	const supabase = getSupabaseClient(account);

	// userId scopes all cross-user service-role queries — required for multi-account safety (#278).
	const { data: userIdResult, error: userIdErr } = await supabase.rpc(
		'resolve_user_id_by_inbound_secret',
		{ p_secret: account.inboundWebhookSecret }
	);
	if (userIdErr || !userIdResult) {
		log?.error?.(
			`[format:${account.accountId}] failed to resolve user_id from inbound_webhook_secret — plugin cannot start`,
			userIdErr instanceof Error ? userIdErr.message : userIdErr ?? 'no matching user'
		);
		return;
	}
	const userId = userIdResult as string;

	// Orphan sweep surfaces the "Interrupted — gateway restarted" bar; no auto-retry (partial rows may exist).
	try {
		await sweepStaleOnStartup(supabase, userId, log);
	} catch (err) {
		log?.warn?.(
			`[format:${account.accountId}] startup sweep failed`,
			err instanceof Error ? err.message : err
		);
	}

	log?.info?.(`[format:${account.accountId}] starting poll loop (interval ${POLL_INTERVAL_MS}ms)`);

	// Per-thread serialization — within-thread order matters, across-thread parallel so long turns don't block.
	const threadQueues = new Map<string, Promise<void>>();

	const enqueueDispatch = (row: ChatMessageRow): void => {
		const prev = threadQueues.get(row.thread_id) ?? Promise.resolve();
		const next = prev
			.then(() => handleInbound(supabase, cfg, account, row, log))
			.catch((err) => {
				log?.warn?.(
					`[format:${account.accountId}] dispatch error for ${row.id.slice(0, 8)}`,
					err instanceof Error ? err.message : err
				);
			});
		threadQueues.set(row.thread_id, next);
		// Clean up the tail so the Map doesn't grow one-entry-per-thread forever.
		// Only delete if no newer enqueue extended the chain — the Map key check
		// avoids racing with a dispatch that ran while we were awaiting.
		void next.finally(() => {
			if (threadQueues.get(row.thread_id) === next) {
				threadQueues.delete(row.thread_id);
			}
		});
	};

	// Concurrent-poll guard prevents duplicate enqueues before the atomic claim fires inside handleInbound.
	let polling = false;

	const poll = async () => {
		if (polling) return;
		if (abortSignal.aborted) return;
		polling = true;
		try {
			await claimAndDispatchPending(supabase, userId, enqueueDispatch);
		} catch (err) {
			log?.warn?.(
				`[format:${account.accountId}] poll error`,
				err instanceof Error ? err.message : err
			);
		} finally {
			polling = false;
		}
	};

	// First sweep happens immediately so messages queued while the gateway was
	// down don't wait for the first tick.
	void poll();
	const timer = setInterval(poll, POLL_INTERVAL_MS);

	return new Promise<void>((resolve) => {
		const onAbort = () => {
			log?.info?.(`[format:${account.accountId}] stopping poll loop`);
			clearInterval(timer);
			resolve();
		};
		if (abortSignal.aborted) onAbort();
		else abortSignal.addEventListener('abort', onAbort, { once: true });
	});
}

async function claimAndDispatchPending(
	supabase: SupabaseClient,
	userId: string,
	enqueue: (row: ChatMessageRow) => void
): Promise<void> {
	// Join through chat_threads for the user_id filter — chat_messages doesn't
	// carry user_id directly, but each thread does, and RLS treats the join as
	// an AND. Service-role still bypasses RLS, so the filter is explicit here.
	const { data, error } = await supabase
		.from('chat_messages')
		.select('id, thread_id, content, chat_threads!inner(user_id)')
		.eq('role', 'user')
		.eq('status', 'pending')
		.eq('chat_threads.user_id', userId)
		.order('created_at', { ascending: true })
		.limit(10);
	if (error) throw error;
	if (!data || data.length === 0) return;

	for (const row of data) {
		enqueue(row as ChatMessageRow);
	}
}

async function handleInbound(
	supabase: SupabaseClient,
	cfg: unknown,
	account: FormatResolvedAccount,
	row: ChatMessageRow,
	log: StartAccountCtx['log']
): Promise<void> {
	const msgId = row.id;
	const threadId = row.thread_id;
	const body = row.content ?? '';
	if (!msgId || !threadId) return;

	// Atomic claim — the `.eq('status', 'pending')` predicate guarantees only
	// one consumer wins if multiple are racing.
	const { data: claimed, error: claimErr } = await supabase
		.from('chat_messages')
		.update({ status: 'delivered' })
		.eq('id', msgId)
		.eq('status', 'pending')
		.select('id')
		.maybeSingle();
	if (claimErr) {
		console.error('[format-plugin] claim error', {
			msgId,
			code: (claimErr as { code?: string }).code,
			message: claimErr.message,
			details: (claimErr as { details?: string }).details,
			hint: (claimErr as { hint?: string }).hint
		});
		return;
	}
	if (!claimed) {
		// Already claimed by another instance.
		return;
	}

	const sessionKey = `format:${threadId}`;
	log?.info?.(`[format] dispatching ${msgId.slice(0, 8)} → ${sessionKey}`);

	// Migration 039 status surface — flip the thread to running so the UI's
	// status zone appears with an elapsed counter. Migration 040 active_workers
	// come in via the per-thread worker-board poll started below.
	await setRunning(supabase, threadId, 'Thinking');

	// If a previous turn on this thread left a tail poller running, stop it
	// cleanly before starting a fresh one.
	const previous = activeWorkerPollers.get(threadId);
	if (previous) previous();
	const stopWorkersPoll = startWorkersPoll({ supabase, threadId });
	activeWorkerPollers.set(threadId, stopWorkersPoll);

	// Routes the agent's final text through outbound.attachedResults.sendText (inserts as role=assistant).
	const pipeline = createChannelReplyPipeline({
		cfg,
		agentId: AGENT_ID,
		channel: CHANNEL_ID
	});
	// createReplyDispatcher requires a deliver callback — the channel reply
	// pipeline only provides prefix/transform/typing hooks, not routing.
	// deliver invokes our own outbound for each payload block the agent
	// produces (kinds: 'block' for streaming pieces, 'final' for the last
	// chunk, 'tool' for tool-result carryover — we use it as a stage hint).
	const dispatcher = createReplyDispatcher({
		...pipeline,
		deliver: async (
			payload:
				| {
						text?: string | null;
						tool?: { name?: string } | null;
						mediaUrls?: string[] | null;
						mediaUrl?: string | null;
				  }
				| null,
			info: { kind: 'block' | 'final' | 'tool' }
		) => {
			// Once the user has aborted, drop any in-flight or late-arriving
			// payloads. This keeps timeout/error text that the agent pipeline
			// produces AS A SIDE EFFECT of the abort from landing as a
			// spurious assistant message (e.g. "Request timed out before a
			// response was generated. …increase agents.defaults.timeoutSeconds").
			if (abortController.signal.aborted) return;

			// Tool-kind payloads fire on tool END, not start — showing "Using
			// <tool>" at that moment is actively misleading (work is done, not
			// in progress). Ignore them entirely. Media carried here is
			// redundant with the subsequent 'final' payload's MEDIA: sentinel
			// text, which we parse back into mediaUrls below. Tool-start would
			// need onAgentEvent, which isn't publicly exported from plugin-sdk.
			if (info.kind === 'tool') return;

			const text = payload?.text?.toString() ?? '';
			// MEDIA:<path> sentinels in the text are the agent's way of
			// declaring attachments when the pipeline doesn't surface them on
			// payload.mediaUrls. Treat either source as authoritative.
			const mediaFromText = Array.from(text.matchAll(/^\s*MEDIA:\s*(.+?)\s*$/gm)).map(
				(m) => m[1]
			);
			const mediaUrls = [
				...(payload?.mediaUrls ?? []),
				...(payload?.mediaUrl ? [payload.mediaUrl] : []),
				...mediaFromText
			]
				.map((u) => u?.trim())
				.filter((u): u is string => !!u);

			if (!text.trim() && mediaUrls.length === 0) return;
			await sendTextToFormat(account, {
				cfg,
				to: threadId,
				text,
				mediaUrls,
				accountId: account.accountId,
				threadId
			});
		},
		onError: (err: unknown, info?: { kind?: string }) => {
			console.error('[format-plugin] pipeline onError', {
				msgId,
				kind: info?.kind,
				error: err instanceof Error ? err.message : err,
				stack: err instanceof Error ? err.stack : undefined
			});
		}
	});

	const msgCtx = {
		Body: body,
		BodyForAgent: body,
		BodyForCommands: body,
		RawBody: body,
		CommandBody: body,
		SessionKey: sessionKey,
		Provider: CHANNEL_ID,
		Surface: CHANNEL_ID,
		AccountId: account.accountId,
		ChatType: 'direct' as const,
		CommandAuthorized: true,
		MessageSid: msgId,
		From: threadId,
		To: threadId,
		MessageThreadId: threadId
	};

	// AbortController wired through to the agent pipeline via replyOptions,
	// plus a watcher that observes chat_threads.status == 'cancelling' and
	// aborts. Gives the client-side Stop button real teeth.
	const abortController = new AbortController();
	const stopCancelWatcher = startCancelWatcher({
		supabase,
		threadId,
		abortController,
		log
	});

	// Liveness signal — the client treats a stale last_heartbeat_at (> ~15s
	// old) as "plugin/gateway not responding." Writing every 5s gives the
	// client ~3 missed beats before flagging stale: fast detection, no
	// false alarm on legitimately long turns.
	const heartbeatTimer = setInterval(() => {
		void writeHeartbeat(supabase, threadId);
	}, 5000);

	// Stage writer with dedupe — agent-runner emits onItemEvent on every item
	// phase transition, often redundant with what we just wrote. One DB round
	// trip per change is fine; per-duplicate is wasteful.
	let lastStage = 'Thinking';
	const maybeSetStage = (next: string): void => {
		const trimmed = next.trim();
		if (!trimmed || trimmed === lastStage || abortController.signal.aborted) return;
		lastStage = trimmed;
		void setStage(supabase, threadId, trimmed);
	};

	try {
		await dispatchInboundMessage({
			ctx: msgCtx,
			cfg,
			dispatcher,
			replyOptions: {
				abortSignal: abortController.signal,
				// Fires on tool phase start/update (publicly exported equivalent of
				// agent-runner's private onAgentEvent tool stream). Slack/Discord/
				// Telegram all use this same hook — see
				// dist/extensions/slack/provider-*.js:2254.
				onToolStart: (p: { name?: string; phase?: string }) => {
					const name = p.name?.trim();
					if (name) maybeSetStage(`Using ${name}`);
				},
				// Item-level events carry richer progress text (progressText >
				// summary > title > name) and fire for tool/command/patch/search.
				// Phase 'end' reverts to generic 'Thinking' so the stage reflects
				// the agent is still processing post-tool, not the last tool name.
				onItemEvent: (p: {
					name?: string;
					phase?: string;
					title?: string;
					summary?: string;
					progressText?: string;
				}) => {
					if (p.phase === 'end') {
						maybeSetStage('Thinking');
						return;
					}
					const label = p.progressText ?? p.summary ?? p.title ?? p.name;
					if (label && label.trim()) maybeSetStage(label.trim());
				}
			}
		});
		log?.info?.(`[format] completed ${msgId.slice(0, 8)}`);
		await setIdle(supabase, threadId);
	} catch (err) {
		if (abortController.signal.aborted) {
			// User-initiated stop. Don't revert-to-pending (that would trigger
			// a retry on the next poll); just drop the turn and flip idle.
			log?.info?.(`[format] ${msgId.slice(0, 8)} cancelled by user`);
			await setIdle(supabase, threadId);
		} else {
			// Real failure — leave the message in 'delivered' (the atomic claim
			// consumed the 'pending' state already) and flag the thread 'failed'.
			// Earlier we reverted to 'pending' for auto-retry, but for permanent
			// errors (quota exceeded, malformed input the agent rejects) that
			// created a 2s loop of dispatch → fail → revert → re-dispatch with
			// no user escape. The UI's "Connection stalled" + retry button
			// (gated on thread status='failed') already covers the recovery
			// path — user click calls clearFailed + sendMessage for a fresh
			// turn. Transient-network retry is handled by retryLastMessage's
			// stillPending check, which only matters if the plugin died BEFORE
			// claiming (atomic claim stayed pending).
			const errText = err instanceof Error ? err.message : String(err);
			log?.error?.(`[format] dispatch failed for ${msgId.slice(0, 8)}`, errText);
			await setFailed(supabase, threadId, errText);
		}
	} finally {
		clearInterval(heartbeatTimer);
		stopCancelWatcher();
		// Leave the poller running briefly so recently-finished chips linger
		// visibly post-turn. A fresh turn on this thread preempts the tail via
		// the activeWorkerPollers guard.
		setTimeout(() => {
			if (activeWorkerPollers.get(threadId) !== stopWorkersPoll) return;
			stopWorkersPoll();
			activeWorkerPollers.delete(threadId);
			// Final clear — only if we're still the authoritative poller.
			void setActiveWorkers(supabase, threadId, []);
		}, POST_TURN_TAIL_MS);
	}
}
