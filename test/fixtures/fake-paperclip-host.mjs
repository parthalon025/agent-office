// A stand-in Paperclip adapter host (#200): it loads an external adapter plugin the way Paperclip's plugin loader does
// (server/src/adapters/plugin-loader.ts at v2026.1106.0: package.json exports["."], then import, then createServerAdapter(), which must
// return a module with a `type`) and runs an employee run the way the heartbeat does: execute(ctx) with a context, the log sink, the
// meta sink and an abort signal, and a result that has the AdapterExecutionResult shape. Not a recording: the shapes follow
// packages/adapter-utils/src/types.ts. No Paperclip, no model.
//
//   const host = await loadAdapter(dir);          -> { adapter, entry, pkg }
//   const run = await host.run({ config, context, agent, runId, signal });  -> { result, logs: [[stream, chunk]], meta: [..] }
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function entryOf(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const exp = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports['.'] : null;
  return { pkg, entry: exp ? (typeof exp === 'string' ? exp : exp.import ?? exp.default ?? 'index.js') : pkg.main ?? 'index.js' };
}

export async function loadAdapter(dir) {
  const { pkg, entry } = entryOf(dir);
  const mod = await import(pathToFileURL(path.resolve(dir, entry)).href);
  if (typeof mod.createServerAdapter !== 'function') throw new Error('does not export createServerAdapter()');
  const adapter = mod.createServerAdapter();
  if (!adapter || !adapter.type) throw new Error('createServerAdapter() returned a module with no type');
  for (const f of ['execute', 'testEnvironment']) if (typeof adapter[f] !== 'function') throw new Error(`the adapter has no ${f}()`);
  return {
    adapter, entry, pkg, mod,
    async run({ config = {}, context = {}, agent, runId = 'run-1', signal } = {}) {
      const logs = [], meta = [];
      const ctx = {
        runId, agent: agent || { id: 'agent-1', companyId: 'co-1', name: 'Ada', adapterType: adapter.type, adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config, context, signal,
        onLog: async (stream, chunk) => { logs.push([stream, chunk]); }, onMeta: async (m) => { meta.push(m); },
      };
      const result = await adapter.execute(ctx);
      return { result, logs, meta };
    },
    test: (config = {}) => adapter.testEnvironment({ companyId: 'co-1', adapterType: adapter.type, config }),
  };
}
