// Inbound pipeline: Realtime push primary, safety poll fallback (60s drift-catch
// when healthy, 2s when degraded). Atomic claim in handleInbound makes the race
// safe. Plugin runs outside the SvelteKit module graph; `console.*` is sanctioned
// per CLAUDE.md.

import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
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
// Healthy = drift-catch when Realtime is up; degraded = original 2s poll cadence.
const SAFETY_POLL_INTERVAL_HEALTHY_MS = 60_000;
const SAFETY_POLL_INTERVAL_DEGRADED_MS = 2_000;
// Hard cap on the SELECT — without it, a hung fetch leaves the inflight flag stuck and the loop dies.
const POLL_QUERY_TIMEOUT_MS = 5_000;
// Belt-and-braces against any future await in the poll path that forgets a timeout.
const POLL_WATCHDOG_MS = 30_000;
// Mirrors openclaw's built-in Slack Socket Mode plugin (jitter avoids reconnect dogpile; maxAttempts surfaces stuck state, safety poll keeps chat working).
const REALTIME_RECONNECT_POLICY = {
	initialMs: 2_000,
	maxMs: 30_000,
	factor: 1.8,
	jitter: 0.25,
	maxAttempts: 12
} as const;

function computeReconnectDelayMs(attempt: number): number {
	const { initialMs, maxMs, factor, jitter } = REALTIME_RECONNECT_POLICY;
	const base = Math.min(maxMs, initialMs * Math.pow(factor, attempt));
	const spread = base * jitter;
	return Math.round(base + (Math.random() * 2 - 1) * spread);
}

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

	log?.info?.(`[format:${account.accountId}] starting Realtime + safety-poll dispatcher`);

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

	// pollStartedAt initialized so the watchdog comparison is meaningful even if a future refactor flips pollInflight outside safetyPoll.
	let pollInflight = false;
	let pollStartedAt = Date.now();

	const safetyPoll = async (): Promise<void> => {
		if (abortSignal.aborted) return;
		if (pollInflight) {
			if (Date.now() - pollStartedAt > POLL_WATCHDOG_MS) {
				log?.warn?.(
					`[format:${account.accountId}] safety-poll watchdog tripped after ${POLL_WATCHDOG_MS}ms; resetting flag`
				);
				pollInflight = false;
			} else {
				return;
			}
		}
		pollStartedAt = Date.now();
		pollInflight = true;
		try {
			await claimAndDispatchPending(supabase, userId, enqueueDispatch);
		} catch (err) {
			const isTimeout =
				err instanceof Error &&
				(err.name === 'AbortError' || err.name === 'TimeoutError' || err.message.includes('timeout'));
			log?.warn?.(
				isTimeout
					? `[format:${account.accountId}] safety-poll SELECT timed out after ${POLL_QUERY_TIMEOUT_MS}ms`
					: `[format:${account.accountId}] safety-poll error`,
				err instanceof Error ? err.message : err
			);
		} finally {
			pollInflight = false;
		}
	};

	// Dynamic safety-poll cadence — fast when Realtime is broken, slow drift-catch when healthy.
	let safetyTimer: ReturnType<typeof setInterval> | null = null;
	const setSafetyPollInterval = (intervalMs: number): void => {
		if (safetyTimer) clearInterval(safetyTimer);
		safetyTimer = setInterval(() => void safetyPoll(), intervalMs);
	};

	// Realtime is the fast path. Handler fires safetyPoll() rather than dispatching payload.new — keeps filtering centralized; atomic claim in handleInbound makes the race safe.
	let channel: RealtimeChannel | null = null;
	let reconnectAttempt = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	const cancelReconnect = (): void => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};

	const scheduleReconnect = (): void => {
		// reconnectTimer guard: re-arming on every CLOSED/CHANNEL_ERROR creates the CLOSED→reconnect→removeChannel→CLOSED dispatch loop seen in earlier deploys.
		if (abortSignal.aborted || reconnectTimer) return;
		if (reconnectAttempt >= REALTIME_RECONNECT_POLICY.maxAttempts) {
			log?.error?.(
				`[format:${account.accountId}] Realtime reconnect gave up after ${reconnectAttempt} attempts; safety poll continues at ${SAFETY_POLL_INTERVAL_DEGRADED_MS}ms`
			);
			return;
		}
		const delay = computeReconnectDelayMs(reconnectAttempt);
		// Increment inside the timer body so the count reflects attempts taken, not scheduled.
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (abortSignal.aborted) return;
			reconnectAttempt += 1;
			log?.info?.(
				`[format:${account.accountId}] reconnecting Realtime (attempt ${reconnectAttempt}/${REALTIME_RECONNECT_POLICY.maxAttempts})`
			);
			if (channel) {
				void supabase.removeChannel(channel);
				channel = null;
			}
			startRealtime();
		}, delay);
	};

	const startRealtime = (): void => {
		if (abortSignal.aborted) return;
		// myChannel closure-captured so the subscribe callback can short-circuit on removed-channel events; otherwise stale CLOSED tears down the new healthy channel.
		const myChannel = supabase
			.channel(`format-inbound-${userId.slice(0, 8)}`)
			.on(
				'postgres_changes',
				{
					event: 'INSERT',
					schema: 'public',
					table: 'chat_messages',
					// Tenant-broad on purpose (postgres_changes filters don't compose); user_id boundary is enforced downstream in claimAndDispatchPending. See #353.
					filter: 'role=eq.user'
				},
				() => {
					void safetyPoll();
				}
			);
		channel = myChannel;
		myChannel.subscribe((status, err) => {
			if (channel !== myChannel) return; // stale callback — channel was removed
			if (status === 'SUBSCRIBED') {
				reconnectAttempt = 0;
				cancelReconnect(); // channel recovered on its own; firing the timer would tear down the healthy channel

				log?.info?.(
					`[format:${account.accountId}] Realtime SUBSCRIBED — safety poll → ${SAFETY_POLL_INTERVAL_HEALTHY_MS}ms`
				);
				setSafetyPollInterval(SAFETY_POLL_INTERVAL_HEALTHY_MS);
				void safetyPoll(); // drain any rows that arrived during SUBSCRIBE handshake
			} else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
				log?.warn?.(
					`[format:${account.accountId}] Realtime ${status} — safety poll → ${SAFETY_POLL_INTERVAL_DEGRADED_MS}ms`,
					err instanceof Error ? err.message : err
				);
				setSafetyPollInterval(SAFETY_POLL_INTERVAL_DEGRADED_MS);
				void safetyPoll(); // first setInterval tick is intervalMs away — covers the cadence-change blind spot
				scheduleReconnect();
			} else if (status === 'CLOSED') {
				log?.info?.(`[format:${account.accountId}] Realtime CLOSED`);
				setSafetyPollInterval(SAFETY_POLL_INTERVAL_DEGRADED_MS);
				void safetyPoll();
				scheduleReconnect();
			}
		});
	};

	// Boot degraded; SUBSCRIBE callback drops to healthy. Immediate sweep drains anything queued while gateway was down.
	setSafetyPollInterval(SAFETY_POLL_INTERVAL_DEGRADED_MS);
	void safetyPoll();
	startRealtime();

	return new Promise<void>((resolve) => {
		const onAbort = () => {
			log?.info?.(`[format:${account.accountId}] stopping inbound dispatcher`);
			if (safetyTimer) clearInterval(safetyTimer);
			cancelReconnect();
			// Null channel BEFORE removeChannel — async CLOSED then hits the stale-callback guard and skips setSafetyPollInterval (which would orphan a timer).
			const ch = channel;
			channel = null;
			if (ch) void supabase.removeChannel(ch);
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
	// AbortSignal.timeout: protects against a hung fetch silently killing the
	// dispatcher (the failure mode that broke prod when this was poll-only).
	const { data, error } = await supabase
		.from('chat_messages')
		.select('id, thread_id, content, chat_threads!inner(user_id)')
		.eq('role', 'user')
		.eq('status', 'pending')
		.eq('chat_threads.user_id', userId)
		.order('created_at', { ascending: true })
		.limit(10)
		.abortSignal(AbortSignal.timeout(POLL_QUERY_TIMEOUT_MS));
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
