// A stand-in for the OpenClaw Gateway's plugin host, for test/openclaw-plugin.test.mjs. Not a recording: OpenClaw on the
// owner's PC (2026.1.29) is too old to start, so no real Gateway ran the plugin yet (#77). It follows the v2026.10.10 sources
// and docs that the plugin is built against:
//   - the entry is a default export { id, name, description, configSchema, register(api) } (src/plugin-sdk/plugin-entry.ts);
//   - register(api) gets api.pluginConfig (plugins.entries.<id>.config) and api.on(hookName, handler, { priority, timeoutMs });
//   - before_tool_call handlers run by priority, higher first; block: true is terminal (docs/plugins/hooks/tool-policy.md);
//   - a handler that throws or does not settle within its timeoutMs (default 15 s) blocks the call
//     (docs/plugins/hooks/reference.md, the per-handler table). The timer is injected, so a test can end it at once;
//   - the operator settings plugins.entries.<id>.hooks.timeouts.before_tool_call, then .hooks.timeoutMs, win over the
//     handler's own timeoutMs (src/plugins/registry-state.ts resolveTypedHookTimeoutMs); api.config is the Gateway config.
// load(dir, { config, gateway, setTimer }) imports the plugin folder's entry (package.json openclaw.extensions[0]) and
// registers it. config: the plugin config (api.pluginConfig); gateway: the whole Gateway config (api.config).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOOK_MS = 15_000;

export async function load(dir, { config = {}, gateway = {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'openclaw.plugin.json'), 'utf8'));
  const entry = (await import(pathToFileURL(path.join(dir, pkg.openclaw.extensions[0])).href)).default;
  if (!entry || entry.id !== manifest.id || typeof entry.register !== 'function') throw new Error('not a plugin entry, or its id is not the manifest id');
  const v = entry.configSchema?.validate ? entry.configSchema.validate(config) : { ok: true };
  if (!v.ok) throw new Error(`invalid plugin config: ${v.errors.join(', ')}`);
  const hooks = [];
  const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
  const policy = gateway?.plugins?.entries?.[entry.id]?.hooks || {};
  entry.register({
    id: entry.id, pluginConfig: config, config: gateway,
    on(name, handler, opts = {}) {
      const timeoutMs = positive(policy.timeouts?.[name]) ?? positive(policy.timeoutMs) ?? positive(opts.timeoutMs) ?? DEFAULT_HOOK_MS;
      hooks.push({ name, handler, priority: opts.priority ?? 0, timeoutMs, matcher: opts.matcher });
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  /** One tool call through the before_tool_call handlers, with the host's failure rule. Returns the result OpenClaw acts on. */
  async function beforeToolCall(event, ctx) {
    const list = hooks.filter((h) => h.name === 'before_tool_call' && (!h.matcher || h.matcher.includes(event.toolName))).sort((a, b) => b.priority - a.priority);
    for (const h of list) {
      let t;
      const late = new Promise((resolve) => { t = setTimer(() => resolve({ block: true, blockReason: `plugin ${entry.id} timed out` }), h.timeoutMs); });
      let r;
      try { r = await Promise.race([Promise.resolve().then(() => h.handler({ ...event, params: { ...event.params } }, ctx)), late]); } catch { r = { block: true, blockReason: `plugin ${entry.id} failed` }; } finally { clearTimer(t); }
      if (r && r.block === true) return r;
    }
    return undefined;
  }
  return { entry, manifest, hooks, beforeToolCall };
}
