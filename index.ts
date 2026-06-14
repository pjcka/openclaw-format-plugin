import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { formatPlugin } from './src/plugin.ts';
import { registerStatusEventHooks } from './src/agent-events.ts';

export default defineChannelPluginEntry({
	id: 'format',
	name: 'Format',
	description: 'Format — chat + doc editor, as an OpenClaw channel',
	plugin: formatPlugin,
	// Live-status bridge: registers the global tool/subagent hooks that write
	// active_run_stage + active_workers. Runs after the channel registers, so it
	// can't disturb the coarse status surface.
	registerFull: registerStatusEventHooks
});
