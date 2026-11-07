// The Paperclip adapter plugin of the office (src/integrations/paperclip-adapter, #200), loaded by the stand-in host
// test/fixtures/fake-paperclip-host.mjs the way Paperclip loads an external adapter, and pointed at a fake office: a real HTTP server on
// loopback that answers the three run routes from a script. No Paperclip, no office, no model. The office's own side is in
// test/paperclip-runs.test.mjs (the broker) and test/paperclip-adapter-routes.test.mjs (the whole way through the office).
// Run: node --test test/paperclip-adapter.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdapter } from './fixtures/fake-paperclip-host.mjs';
import { createRunner, promptOf, contextOf, ROUTES } from '../src/integrations/paperclip-adapter/run.js';
import { routeOf } from '../src/auth.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'integrations', 'paperclip-adapter');
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

// A fake office. script(route, body, seen) -> { status, json } or a promise of it. seen: every request.
async function office(script) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      const rec = { url: req.url, method: req.method, headers: req.headers, body: JSON.parse(b || '{}') };
      seen.push(rec);
      const a = await script(req.url, rec.body, seen);
      res.writeHead(a.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.json ?? {}));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pc-adapter-'));
  temps.push(dir);
  const tokenFile = path.join(dir, '.office-token');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'agent-token-1', port: srv.address().port }));
  return { seen, tokenFile, port: srv.address().port, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}
const OK = { ok: true, error: null, uid: 'o1', provider: 'claude-code', model: 'claude-haiku-4-5', sessionId: 'sid-1', summary: 'Done.', turns: 1, cost: 0.0421, costUnknown: false, usage: { inputTokens: 500, outputTokens: 300, cachedInputTokens: 700 } };
const happy = (result = OK) => {
  let waits = 0;
  return (url) => {
    if (url === ROUTES.start) return { json: { key: 'run-1', resumed: false } };
    if (url === ROUTES.wait) return ++waits === 1 ? { json: { done: false, cursor: 2, log: [{ stream: 'stdout', text: '> Bash npm test' }, { stream: 'stdout', text: 'Looking.' }] } } : { json: { done: true, cursor: 3, log: [{ stream: 'stdout', text: '[agent-office] The run finished.' }], result } };
    return { json: { ok: true } };
  };
};
const config = (tokenFile, over = {}) => ({ tokenFile, agentKind: 'claude-code', model: 'haiku', cwd: 'C:\\work\\acme', ...over });
const noWait = { sleep: async () => {} };

test('the folder is a Paperclip external adapter: package entry, createServerAdapter, type, config doc, no import from Paperclip', async () => {
  const host = await loadAdapter(DIR);
  assert.equal(host.entry, './index.js');
  assert.equal(host.adapter.type, 'agent_office');
  assert.equal(host.mod.type, host.adapter.type);
  assert.match(host.adapter.agentConfigurationDoc, /agentKind/);
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const src of files) assert.doesNotMatch(src, /from ['"]@paperclipai|require\(['"]@paperclipai/, 'nothing to install');
});

test('the routes the plugin calls are agent routes of the office', () => {
  for (const r of Object.values(ROUTES)) assert.equal(routeOf('POST', r), 'agent', r);
});

test('a run goes end to end: start, the log reaches onLog, the result carries cost, usage and the office session', async () => {
  const o = await office(happy());
  try {
    const host = await loadAdapter(DIR);
    const { result, logs, meta } = await host.run({ config: config(o.tokenFile), context: { taskId: 'task-9', wakeReason: 'issue_assigned', issueTitle: 'Add a health route' }, runId: 'run-1' });
    const start = o.seen.find((r) => r.url === ROUTES.start);
    assert.equal(start.headers['x-office-token'], 'agent-token-1');
    assert.equal(start.headers['content-type'], 'application/json');
    assert.deepEqual({ ...start.body, prompt: undefined }, { run_id: 'run-1', agent: { id: 'agent-1', company_id: 'co-1', name: 'Ada' }, agent_kind: 'claude-code', model: 'haiku', cwd: 'C:\\work\\acme', isolation: 'same', task_id: 'task-9', prompt: undefined, context: { wake_reason: 'issue_assigned' } });
    assert.match(start.body.prompt, /Add a health route/);
    assert.match(start.body.prompt, /issue_assigned/);
    assert.deepEqual(o.seen.filter((r) => r.url === ROUTES.wait).map((r) => r.body), [{ key: 'run-1', cursor: 0 }, { key: 'run-1', cursor: 2 }]);
    assert.deepEqual(logs.map((l) => l[0]), ['stdout', 'stdout', 'stdout']);
    assert.equal(logs.map((l) => l[1]).join(''), '> Bash npm test\nLooking.\n[agent-office] The run finished.\n');
    assert.deepEqual(meta.map((m) => [m.adapterType, m.command]), [['agent_office', 'agent-office:claude-code']]);
    assert.deepEqual({ exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, errorMessage: result.errorMessage ?? null }, { exitCode: 0, signal: null, timedOut: false, errorMessage: null });
    assert.deepEqual(result.usage, { inputTokens: 500, outputTokens: 300, cachedInputTokens: 700 });
    assert.equal(result.costUsd, 0.0421);
    assert.equal(result.costStatus, 'reported');
    assert.deepEqual([result.provider, result.model, result.sessionDisplayId, result.summary], ['claude-code', 'claude-haiku-4-5', 'o1', 'Done.']);
    assert.equal(result.resultJson.office.uid, 'o1');
  } finally { o.close(); }
});

test('an unknown cost is not 0: costUsd stays null and the status says unpriced; usage the office could not split is left out', async () => {
  const o = await office(happy({ ...OK, cost: null, costUnknown: true, usage: null }));
  try {
    const { result } = await (await loadAdapter(DIR)).run({ config: config(o.tokenFile) });
    assert.equal(result.costUsd ?? null, null);
    assert.equal(result.costStatus, 'unpriced');
    assert.equal(result.usage, undefined);
    assert.equal(result.usageComplete, false);
  } finally { o.close(); }
});

test('a run the office ends as failed is a failed run with its reason: exit 1, the error text', async () => {
  const o = await office(happy({ ...OK, ok: false, error: 'The turn was stopped in the office.' }));
  try {
    const { result } = await (await loadAdapter(DIR)).run({ config: config(o.tokenFile) });
    assert.deepEqual([result.exitCode, result.errorMessage, result.timedOut], [1, 'The turn was stopped in the office.', false]);
  } finally { o.close(); }
});

test('an abort by Paperclip cancels the run in the office and ends the plugin run at once', async () => {
  const ctl = new AbortController();
  const o = await office((url, body, seen) => {
    if (url === ROUTES.start) return { json: { key: 'run-1' } };
    if (url === ROUTES.wait) { setTimeout(() => ctl.abort(), 20); return new Promise(() => {}); } // the office holds the wait
    return { json: { ok: true, done: true } };
  });
  try {
    const { result } = await (await loadAdapter(DIR)).run({ config: config(o.tokenFile), signal: ctl.signal });
    assert.deepEqual([result.exitCode, result.signal, result.timedOut, result.errorMessage], [null, 'SIGTERM', false, 'Paperclip cancelled the run.']);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(o.seen.filter((r) => r.url === ROUTES.cancel).map((r) => r.body), [{ key: 'run-1' }]);
  } finally { o.close(); }
});

test('the office refuses the start: the run fails with the office\'s own words, and nothing waits', async () => {
  const o = await office((url) => (url === ROUTES.start ? { status: 409, json: { error: 'Hermes opens only in a room of its own.' } } : { json: {} }));
  try {
    const { result } = await (await loadAdapter(DIR)).run({ config: config(o.tokenFile, { agentKind: 'hermes' }) });
    assert.deepEqual([result.exitCode, result.errorMessage, result.errorCode], [1, 'Agent Office refused the run: Hermes opens only in a room of its own.', 'agent_office_refused']);
    assert.deepEqual(o.seen.map((r) => r.url), [ROUTES.start]);
  } finally { o.close(); }
});

test('no token file, a bad token file, a wrong token and no office each fail the run with a reason that says what to do', async () => {
  const host = await loadAdapter(DIR);
  const none = (await host.run({ config: { agentKind: 'claude-code', cwd: 'C:\\x' } })).result;
  assert.match(none.errorMessage, /AGENT_OFFICE_TOKEN_FILE|tokenFile/);
  assert.equal(none.exitCode, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pc-adapter-')); temps.push(dir);
  fs.writeFileSync(path.join(dir, 't'), 'not json');
  assert.match((await host.run({ config: config(path.join(dir, 't')) })).result.errorMessage, /not JSON/);
  assert.match((await host.run({ config: config(path.join(dir, 'missing')) })).result.errorMessage, /cannot read the office token file/);
  const wrong = await office(() => ({ status: 401, json: { error: 'Unauthorized' } }));
  try { assert.match((await host.run({ config: config(wrong.tokenFile) })).result.errorMessage, /refused the run: Unauthorized/); } finally { wrong.close(); }
  const down = await office(() => ({ json: {} }));
  down.close();
  assert.match((await host.run({ config: config(down.tokenFile) })).result.errorMessage, /is not running or does not answer on 127\.0\.0\.1/);
});

test('no folder to work in is a failed run, not a guess', async () => {
  const o = await office(happy());
  try {
    const { result } = await (await loadAdapter(DIR)).run({ config: { tokenFile: o.tokenFile } });
    assert.match(result.errorMessage, /no folder/i);
    assert.deepEqual(o.seen, []);
    const ws = await (await loadAdapter(DIR)).run({ config: { tokenFile: o.tokenFile }, context: { paperclipWorkspace: { cwd: 'C:\\ws\\acme' } } });
    assert.equal(o.seen.find((r) => r.url === ROUTES.start).body.cwd, 'C:\\ws\\acme', 'the workspace Paperclip gives the run');
    assert.equal(ws.result.exitCode, 0);
  } finally { o.close(); }
});

test('a wait that fails once is tried again; five in a row end the run as failed', async () => {
  let n = 0;
  const flaky = await office((url) => {
    if (url === ROUTES.start) return { json: { key: 'run-1' } };
    return ++n === 1 ? { status: 502, json: { error: 'busy' } } : { json: { done: true, cursor: 0, log: [], result: OK } };
  });
  try {
    const r = createRunner({ env: () => ({}), readFile: async (f) => fs.readFileSync(f, 'utf8'), ...noWait });
    const ctx = (cfg) => ({ runId: 'run-1', agent: { id: 'agent-1', companyId: 'co-1', name: 'Ada' }, config: cfg, context: {}, onLog: async () => {} });
    assert.equal((await r.execute(ctx(config(flaky.tokenFile)))).exitCode, 0);
  } finally { flaky.close(); }
  const dead = await office((url) => (url === ROUTES.start ? { json: { key: 'run-1' } } : { status: 404, json: { error: 'No such run. The office may have restarted.' } }));
  try {
    const r = createRunner({ env: () => ({}), readFile: async (f) => fs.readFileSync(f, 'utf8'), ...noWait });
    const out = await r.execute({ runId: 'run-1', agent: { id: 'agent-1', companyId: 'co-1', name: 'Ada' }, config: config(dead.tokenFile), context: {}, onLog: async () => {} });
    assert.deepEqual([out.exitCode, out.errorCode], [1, 'agent_office_lost']);
    assert.match(out.errorMessage, /office may have restarted/);
    assert.equal(dead.seen.filter((x) => x.url === ROUTES.wait).length, 1, 'a 404 is final: the run is gone, not busy');
  } finally { dead.close(); }
});

test('promptOf: the template is filled in, the task and the wake reason follow, and an empty setup still gives a prompt', () => {
  const agent = { id: 'agent-1', name: 'Ada' };
  assert.equal(promptOf({ agent, config: {}, context: {} }), 'Continue your work.');
  const p = promptOf({ agent, config: { promptTemplate: 'You are {{agent.name}} ({{agent.id}}).' }, context: { taskId: 't1', issueIdentifier: 'ACM-12', issueTitle: 'Add a health route', wakeReason: 'issue_assigned', wakeCommentId: 'c1' } });
  assert.equal(p, 'You are Ada (agent-1).\n\nTask: ACM-12 Add a health route (t1)\nWake reason: issue_assigned\nComment: c1');
  assert.doesNotMatch(promptOf({ agent, config: { promptTemplate: '{{agent.name}} {{nope}}' }, context: {} }), /\{\{/);
});

test('testEnvironment: pass when the office answers; the token file, the office and the folder each have their own check', async () => {
  const o = await office((url) => (url === ROUTES.wait ? { status: 404, json: { error: 'No such run.' } } : { json: {} }));
  try {
    const host = await loadAdapter(DIR);
    const good = await host.test(config(o.tokenFile));
    assert.equal(good.status, 'pass');
    assert.equal(good.adapterType, 'agent_office');
    assert.ok(good.checks.every((c) => c.level === 'info'), JSON.stringify(good.checks));
    assert.equal((await host.test(config(o.tokenFile, { cwd: 'relative' }))).checks.find((c) => c.code === 'cwd_not_absolute').level, 'warn');
    assert.equal((await host.test({})).status, 'fail');
    const bad = await office(() => ({ status: 401, json: {} }));
    try { assert.equal((await host.test(config(bad.tokenFile))).checks.find((c) => c.code === 'office_refused').level, 'error'); } finally { bad.close(); }
  } finally { o.close(); }
});

test('contextOf (#206): the wake reason, the saved session, the instructions file and the skills, only as Paperclip passed them', () => {
  assert.equal(contextOf({}), undefined, 'nothing passed: nothing sent');
  const c = contextOf({
    config: { instructionsFilePath: 'C:\\work\\AGENTS.md', paperclipRuntimeSkills: [{ key: 'a/review', name: 'review' }, { runtimeName: 'deploy' }, 'lint', {}] },
    context: { wakeReason: 'issue_assigned' },
    runtime: { sessionParams: { sessionId: 'sess-1', cwd: 'C:\\work', taskId: 'task-1', instructionsFile: 'C:\\old\\AGENTS.md' } },
  });
  assert.deepEqual(c, { wake_reason: 'issue_assigned', prior: { session_id: 'sess-1', cwd: 'C:\\work', task_id: 'task-1', instructions: 'C:\\old\\AGENTS.md' }, instructions: { file: 'C:\\work\\AGENTS.md', key: 'C:\\work\\AGENTS.md' }, skills: ['review', 'deploy', 'lint'] });
  assert.deepEqual(contextOf({ runtime: { sessionId: 's2' } }), { prior: { session_id: 's2' } });
});
