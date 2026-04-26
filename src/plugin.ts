// Format channel plugin entry. Composes createChatChannelPlugin with:
// - inbound: Supabase polling → dispatchInboundMessage (see ./inbound.ts)
// - outbound: writes agent replies to chat_messages, base64-inlines media
//   (see ./outbound.ts)
// - status: chat_threads.status / stage / workers / heartbeat writes
//   (see ./status.ts + ./workers-poller.ts)
//
// Runs in-process inside the OpenClaw gateway. See
// docs/reference/openclaw-async-delegation.md for the deferred
// "async subagent resurfacing" analysis.

import {
	createChatChannelPlugin,
	createChannelPluginBase
} from 'openclaw/plugin-sdk/channel-core';
import { resolveAccount, listAccountIds, type FormatResolvedAccount } from './setup.ts';
import { sendTextToFormat } from './outbound.ts';
import { startFormatAccount } from './inbound.ts';

// Targets are always Format thread UUIDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// createChannelPluginBase only passes through a fixed set of fields; `messaging`
// isn't one of them. Compose it onto the base alongside.
const base = {
	...createChannelPluginBase<FormatResolvedAccount>({
		id: 'format',
		meta: {
			label: 'Format',
			selectionLabel: 'Format (chat + doc editor)',
			docsPath: '/channels/format',
			blurb: 'Format chat — Supabase-backed conversations that write to chat_messages.'
		},
		setup: {
			resolveAccount
		},
		config: {
			listAccountIds,
			resolveAccount,
			defaultAccountId: () => 'default'
		}
	}),
	messaging: {
		targetResolver: {
			hint: '<thread-uuid>',
			looksLikeId: (input: string) => UUID_RE.test(input.trim()),
			resolveTarget: async ({ input }: { input: string }) => {
				const trimmed = input?.trim();
				if (!trimmed || !UUID_RE.test(trimmed)) return null;
				return { to: trimmed, kind: 'direct' as const, source: 'input' as const };
			}
		}
	},
	gateway: {
		startAccount: startFormatAccount
	}
};

export const formatPlugin = createChatChannelPlugin<FormatResolvedAccount>({
	base,
	outbound: {
		base: {
			deliveryMode: 'direct',
			resolveTarget: ({ to }) => {
				const trimmed = to?.trim();
				if (!trimmed) {
					return {
						ok: false,
						error: new Error(
							'Format channel requires `to=<threadId>` (UUID).'
						)
					};
				}
				return { ok: true, to: trimmed };
			}
		},
		attachedResults: {
			channel: 'format',
			sendText: async (params) => {
				const account = resolveAccount(params.cfg, params.accountId);
				if (!account) {
					throw new Error(
						`[format-plugin] sendText: no resolvable account (requested accountId=${params.accountId ?? 'default'})`
					);
				}
				return sendTextToFormat(account, params);
			}
		}
	}
});
