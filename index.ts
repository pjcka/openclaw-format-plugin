import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { formatPlugin } from './src/plugin.ts';

export default defineChannelPluginEntry({
	id: 'format',
	name: 'Format',
	description: 'Format — chat + doc editor, as an OpenClaw channel',
	plugin: formatPlugin
});
