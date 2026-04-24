// Account resolution — pulls Format channel credentials out of the gateway
// config and returns a normalized ResolvedAccount for the plugin runtime.
// The gateway reads channels.format.accounts[accountId] from ~/.openclaw/openclaw.json.

export type FormatResolvedAccount = {
	accountId: string;
	supabaseUrl: string;
	supabaseServiceRole: string;
	formatUrl: string;
	inboundWebhookSecret: string;
	// Stubs expected by the channel-core base contract.
	token: string;
	allowFrom: string[];
	dmPolicy: string | undefined;
};

type FormatAccountConfig = {
	supabaseUrl?: string;
	supabaseServiceRole?: string;
	formatUrl?: string;
	inboundWebhookSecret?: string;
};

type FormatChannelConfig = {
	accounts?: Record<string, FormatAccountConfig>;
	defaultAccount?: string;
};

type CfgShape = {
	channels?: {
		format?: FormatChannelConfig;
	};
};

const DEFAULT_ACCOUNT_ID = 'default';

export function listAccountIds(cfg: CfgShape): string[] {
	const accounts = cfg.channels?.format?.accounts;
	return accounts ? Object.keys(accounts) : [];
}

export function resolveAccount(
	cfg: CfgShape,
	accountId?: string
): FormatResolvedAccount | null {
	const channel = cfg.channels?.format;
	const resolvedId = (accountId ?? channel?.defaultAccount ?? DEFAULT_ACCOUNT_ID).trim();
	const account = channel?.accounts?.[resolvedId];
	if (!account) return null;

	const supabaseUrl = account.supabaseUrl?.trim();
	const supabaseServiceRole = account.supabaseServiceRole?.trim();
	const formatUrl = account.formatUrl?.trim();
	const inboundWebhookSecret = account.inboundWebhookSecret?.trim();

	if (!supabaseUrl || !supabaseServiceRole || !formatUrl || !inboundWebhookSecret) {
		return null;
	}

	return {
		accountId: resolvedId,
		supabaseUrl,
		supabaseServiceRole,
		formatUrl,
		inboundWebhookSecret,
		token: supabaseServiceRole,
		allowFrom: [],
		dmPolicy: undefined
	};
}
