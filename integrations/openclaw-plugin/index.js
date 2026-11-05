// Agent Office plugin for OpenClaw (#77). OpenClaw loads this folder into its Gateway; the office never loads it. It sends every
// tool call of a session the office opened to the office hold and waits for the decision (gate.js). Install it on the PC that
// runs the Gateway (README, "OpenClaw"):
//   openclaw plugins install --link "<office folder>/integrations/openclaw-plugin" --force
//   openclaw config set plugins.entries.agent-office.config.tokenFile "<office folder>/.office-token"
//   openclaw plugins enable agent-office
// A plain entry object, the shape definePluginEntry returns (src/plugin-sdk/plugin-entry.ts, v2026.10.10), so the plugin
// needs no package from OpenClaw and nothing is installed for it.
import fs from 'node:fs/promises';
import { createGate } from './gate.js';

// OpenClaw's limit for this handler: 600 s, the most its hooks.timeoutMs setting takes (docs/plugins/hooks/reference.md). The
// plugin's own wait (gate.js WAIT_MS) ends 5 s before it.
const HOOK_MS = 600_000;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { tokenFile: { type: 'string', description: 'The token file of the office (.office-token, or .office-token-<port>).' } },
};

export default {
  id: 'agent-office',
  name: 'Agent Office',
  description: 'Sends every tool call of an Agent Office session to the office and waits for the decision.',
  configSchema: {
    jsonSchema: SCHEMA,
    validate(value) {
      if (value === undefined) return { ok: true, value };
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['expected a config object'] };
      const extra = Object.keys(value).filter((k) => k !== 'tokenFile');
      if (extra.length) return { ok: false, errors: [`unknown settings: ${extra.join(', ')}`] };
      if (value.tokenFile !== undefined && typeof value.tokenFile !== 'string') return { ok: false, errors: ['tokenFile must be text'] };
      return { ok: true, value };
    },
  },
  register(api) {
    const gate = createGate({
      config: () => api.pluginConfig || {},
      readFile: (file) => fs.readFile(file, 'utf8'),
      fetch: (...a) => globalThis.fetch(...a),
    });
    // No matcher: every tool. OpenClaw's own limit for the handler is a little longer than the plugin's wait, so the plugin
    // says why it denies; a timeout or an error in the handler blocks the call (OpenClaw's rule for before_tool_call).
    api.on('before_tool_call', (event, ctx) => gate.beforeToolCall(event, ctx), { priority: 1000, timeoutMs: HOOK_MS });
  },
};
