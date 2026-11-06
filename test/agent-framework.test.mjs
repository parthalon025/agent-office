// Microsoft Agent Framework provider tests (#23). The team runner is a fake child process that plays recorded runner lines
// (test/fixtures/agent-framework.jsonl), with a real tracker and the real tool gate. One test runs the real Python runner
// against a stand-in framework package (test/fixtures/fake-af), when Python is on this machine. No model, no network, no cost.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createTracker } from '../src/tracker.mjs';
import { providerEvents, checkProvider, createRegistry, describe as describeKind } from '../src/providers/index.mjs';
import { createAgentFramework, readTeam, teamOf, runnerEnv, DEFAULT_TEAM, TEAM_FILE, TOOL_NAMES, RUNNER, SETUP, MAX_STEPS } from '../src/providers/agent-framework.mjs';
import { TOOL_DEFINITIONS } from '../src/providers/local-tools.mjs';
import { createLocal } from '../src/providers/local.mjs';
import { resolveExe } from '../src/git.mjs';
import { cleanRules, setRule, decide } from '../src/security.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = fs.readFileSync(path.join(HERE, 'fixtures', 'agent-framework.jsonl'), 'utf8').split('\n').filter((l) => l.trim());

async function until(fn, what, ms = 30000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) assert.fail('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fakeChild(pid = 5151) {
  const c = new EventEmitter();
  c.pid = pid; c.exitCode = null;
  c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.written = '';
  c.stdin.on('data', (d) => { c.written += d; });
  c.lines = () => c.written.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  c.say = (obj) => c.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n');
  c.exit = (code) => { c.exitCode = code; c.emit('exit', code); };
  return c;
}

const LMSTUDIO = { kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', models: async () => [{ id: 'qwen/qwen3-8b', label: 'qwen/qwen3-8b' }] };
const OLLAMA_DOWN = { kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: async () => { throw new Error('ECONNREFUSED'); } };

// Security room rules (security.mjs) for the team's column. The defaults ask about every call, a low read inside the worktree
// included (#23 is a new kind: nothing it did before needs keeping). INSIDE: a user who set Allow on reads and edits inside.
const allowCell = (row, r = cleanRules(null)) => setRule(r, { scope: 'office', row, col: 'agent-framework', value: 'allow', confirmed: true }).rules;
const INSIDE = allowCell('edit-inside', allowCell('read-inside'));

// The office side: a tracker, the events, the holds without sockets (as server.mjs holds them), and the provider.
// rules: the Security room rules; the tracker checks them before a hold, as the server's tracker does, and a decision is
// answered on a later tick (the server's holdRequest). The session works in its own git worktree, as an office session does.
// Every folder a rig or a test makes is removed at the end of the file, so a test that fails before its cleanup leaves
// nothing in %TEMP% (#124). The test's own cleanup removes its folder first.
const made = new Set();
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function rig({ env = {}, servers = [LMSTUDIO, OLLAMA_DOWN], execFile, exe, officeTools, tools, rules = cleanRules(null) } = {}) {
  const o = { holds: new Map(), ids: {}, spawned: [], killed: [], ran: [] };
  o.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-af-'));
  made.add(o.cwd);
  o.tracker = createTracker({
    now: Date.now, makeId: (k) => `${k[0]}${(o.ids[k] = (o.ids[k] || 0) + 1)}`, locate: async () => null,
    setTimer: () => 0, releaseHold: (id, d) => o.release(id, d),
    screen: (s, p, opts) => decide(rules, { building: null, kind: s.provider, tool: p.tool_name, input: p.full_input || p.tool_input, root: o.tracker.rootOf(s), worktree: !!(s.worktree && s.worktree.root), provider: opts.provider }),
  });
  o.events = providerEvents({ tracker: o.tracker,
    hold: (r) => (r.auto ? setImmediate(() => o.provider.answer(r.s, { id: r.id, suggestions: [] }, r.auto)) : o.holds.set(r.id, { s: r.s, suggestions: r.suggestions })) });
  o.release = (id, d) => {
    const h = o.holds.get(id);
    if (!h) return false;
    o.holds.delete(id); o.tracker.settle(h.s.uid, id); o.provider.answer(h.s, { id, suggestions: h.suggestions }, d || {});
    return true;
  };
  o.provider = createAgentFramework({
    events: o.events, servers, officeTools,
    env: { PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-cloud', AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', ANTHROPIC_API_KEY: 'k', ...env },
    exe: exe || ((name) => (name.includes('\\') ? name : `C:\\py\\${name}.exe`)),
    spawn: (file, args, opts) => { const child = fakeChild(); o.spawned.push({ file, args, opts, child }); return child; },
    execFile: execFile || ((file, args, opts, cb) => cb(null, JSON.stringify({ ok: true, version: '1.24.0' }) + '\n')),
    kill: (pid) => o.killed.push(pid),
    makeTools: tools || (() => ({ run: async (name, input) => { o.ran.push({ name, input }); return { ok: true, text: `ran ${name}` }; }, stop: () => {} })),
  });
  o.session = () => o.tracker.newSession({ uid: 'o1', officeId: 'o1', name: 'team', cwd: o.cwd, headless: true, status: 'starting', provider: 'agent-framework', worktree: { root: o.cwd, branch: 'agent/team-1', repo: o.cwd } });
  o.say = (s, text) => { o.provider.message(s, { text }); o.tracker.startTurn(s, text); };
  o.child = () => o.spawned[o.spawned.length - 1].child;
  o.done = () => fs.rmSync(o.cwd, { recursive: true, force: true });
  return o;
}

// Plays runner lines. After a tool line it waits until the office answered that tool, as the real runner does.
async function play(child, lines) {
  for (const line of lines) {
    child.say(line);
    const m = JSON.parse(line);
    if (m.type === 'tool') await until(() => child.lines().some((x) => x.type === 'tool_result' && x.id === m.id), `the answer to ${m.id}`);
    else await new Promise((r) => setImmediate(r));
  }
}

const RIG_PY = 'C:\\py\\' + (process.platform === 'win32' ? 'python' : 'python3') + '.exe'; // the rig's path for the name the provider asks for
test('the provider has the seam shape: free, gated, a model to pick, no resume, a team', () => {
  const o = rig();
  const p = checkProvider(o.provider);
  assert.equal(p.kind, 'agent-framework');
  assert.equal(p.label, 'Agent Framework');
  // gated: every member call goes to the office first (the Security room rules); cost reported: it is 0, never unknown.
  assert.deepEqual(describeKind(p), { kind: 'agent-framework', label: 'Agent Framework', paid: false, terminal: false, modes: [], needsModel: true, control: false,
    gated: true, supervision: null, cost: 'reported', team: true });
  assert.deepEqual(p.features, ['teams'], 'the Agent teams feature word (#72)');
  assert.equal(globalThis.OfficeVocab.security.columnOf(p.kind), 'agent-framework', 'its own Security room column');
  assert.equal(p.canResume, false);
  assert.throws(() => checkProvider({ ...p, team: 'yes' }), /team \(optional, but then true or false\)/);
  assert.equal(createRegistry([p]).get('agent-framework'), p);
  o.done();
});

test('the team file: the default team, a valid file, and every mistake says what to fix', () => {
  const def = readTeam(JSON.stringify(DEFAULT_TEAM));
  assert.equal(def.start, 'lead');
  assert.deepEqual(def.agents.map((a) => a.name), ['lead', 'coder', 'reviewer']);
  assert.equal(def.pattern, 'handoff');
  const t = readTeam(JSON.stringify({ name: 'Docs', pattern: 'sequential', agents: [{ name: 'writer', instructions: 'Write.' }, { name: 'editor', instructions: 'Edit.', tools: ['Read', 'Edit', 'Read'] }] }));
  assert.deepEqual(t, { name: 'Docs', pattern: 'sequential', start: 'writer', agents: [
    { name: 'writer', description: '', instructions: 'Write.', tools: ['Read', 'LS', 'Grep'] },
    { name: 'editor', description: '', instructions: 'Edit.', tools: ['Read', 'Edit'] }] }, 'start is the first agent; tools default to reading; a tool is listed once');
  const bad = (team, re) => assert.throws(() => readTeam(typeof team === 'string' ? team : JSON.stringify(team)), (e) => e.status === 400 && re.test(e.message) && e.message.startsWith(TEAM_FILE));
  bad('{nope', /not valid JSON/);
  bad([], /one object/);
  bad({ agents: [] }, /at least one agent/);
  bad({ agents: Array.from({ length: 9 }, (_, i) => ({ name: 'a' + i, instructions: 'x' })) }, /at most 8 agents/);
  bad({ agents: [{ name: 'Lead', instructions: 'x' }] }, /lower-case letters/);
  bad({ agents: [{ name: 'a b', instructions: 'x' }] }, /lower-case letters/);
  bad({ agents: [{ name: 'a', instructions: 'x' }, { name: 'a', instructions: 'y' }] }, /two agents have the name a/);
  bad({ agents: [{ name: 'a', instructions: '' }] }, /a: instructions must be text/);
  bad({ agents: [{ name: 'a', instructions: 'x', tools: ['WebFetch'] }] }, /unknown tool WebFetch/);
  bad({ agents: [{ name: 'a', instructions: 'x' }], pattern: 'magentic' }, /pattern must be handoff or sequential/);
  bad({ agents: [{ name: 'a', instructions: 'x' }], start: 'b' }, /start must be the name of an agent/);
  assert.ok(TOOL_NAMES.includes('Bash') && TOOL_NAMES.includes('office_ask'), 'the local tools and the office tools');
});

test('teamOf: the folder\'s agent-team.json, else the default team; an unreadable file is a 400', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-'));
  try {
    assert.deepEqual(teamOf(dir).agents.map((a) => a.name), ['lead', 'coder', 'reviewer']);
    fs.writeFileSync(path.join(dir, TEAM_FILE), JSON.stringify({ agents: [{ name: 'solo', instructions: 'Do it.' }] }));
    assert.deepEqual(teamOf(dir).agents.map((a) => a.name), ['solo']);
    assert.throws(() => teamOf(dir, () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; }), (e) => e.status === 400 && /cannot read it \(EACCES\)/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the runner gets no cloud key: only the allowlist, and UTF-8 pipes', () => {
  const env = runnerEnv({ PATH: 'p', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: 'https://api.openai.com', AZURE_OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'g', PYTHONPATH: 'x' });
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'PYTHONPATH', 'PYTHONUNBUFFERED', 'PYTHONUTF8', 'SystemRoot']);
});

test('models: the models of every local server that answers, named by server; check refuses what cannot run', async () => {
  const o = rig();
  assert.deepEqual(await o.provider.models(), [{ id: 'lmstudio:qwen/qwen3-8b', label: 'qwen/qwen3-8b (LM Studio)' }], 'Ollama is down: skipped');
  const err = (fn, status, re) => assert.throws(fn, (e) => e.status === status && re.test(e.message));
  err(() => o.provider.check({ cwd: o.cwd }), 400, /Pick a model for this team/);
  err(() => o.provider.check({ cwd: o.cwd, model: 'qwen' }), 400, /model of LM Studio or Ollama/);
  err(() => o.provider.check({ cwd: o.cwd, model: 'copilot:gpt' }), 400, /model of LM Studio or Ollama/);
  assert.doesNotThrow(() => o.provider.check({ cwd: o.cwd, model: 'ollama:llama3:8b' }), 'a colon in the server\'s own id is fine');
  fs.writeFileSync(path.join(o.cwd, TEAM_FILE), '{"agents":[]}');
  err(() => o.provider.check({ cwd: o.cwd, model: 'lmstudio:qwen/qwen3-8b' }), 400, /agent-team\.json: agents must list/);
  assert.doesNotThrow(() => o.provider.check({ cwd: o.cwd, model: 'lmstudio:qwen/qwen3-8b', isolation: 'worktree' }), 'a new worktree has its own copy: open() reads it');
  assert.doesNotThrow(() => o.provider.check({}), 'Reopen: Python is there');
  const none = rig({ exe: () => { throw new Error('Program not found'); } });
  err(() => none.provider.check({}), 409, /cannot find Python/);
  const own = rig({ env: { OFFICE_AF_PYTHON: 'C:\\venv\\python.exe' }, exe: (n) => { if (n === 'C:\\venv\\python.exe') return n; throw new Error('x'); } });
  assert.doesNotThrow(() => own.provider.check({}), 'OFFICE_AF_PYTHON is the Python');
  const ownGone = rig({ env: { OFFICE_AF_PYTHON: 'C:\\gone\\python.exe' }, exe: () => { throw new Error('x'); } });
  err(() => ownGone.provider.check({}), 409, /OFFICE_AF_PYTHON does not point to a program: C:\\gone\\python\.exe/);
  for (const x of [o, none, own, ownGone]) x.done();
});

test('readiness: no Python, no framework, no model server, ready; each not-ready answer gives the steps', async () => {
  const noPy = rig({ exe: () => { throw new Error('Program not found'); } });
  assert.deepEqual(await noPy.provider.readiness(), { ready: false, version: null, needs: SETUP });
  const calls = [];
  const noAf = rig({ execFile: (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, JSON.stringify({ ok: false, error: "ModuleNotFoundError: No module named 'agent_framework'" }) + '\n'); } });
  const r = await noAf.provider.readiness();
  assert.equal(r.ready, false);
  assert.match(r.needs[0], /could not load Agent Framework: ModuleNotFoundError: No module named 'agent_framework'/);
  assert.match(r.needs.join(' '), /pip install agent-framework/);
  assert.match(r.needs.join(' '), /OFFICE_AF_PYTHON/);
  assert.equal(calls[0].file, RIG_PY, 'Python by its full path');
  assert.deepEqual(calls[0].args, ['-u', RUNNER, '--check']);
  assert.equal(calls[0].opts.env.OPENAI_API_KEY, undefined, 'the check gets the scrubbed environment too');
  const broken = rig({ execFile: (f, a, o, cb) => cb(new Error('Command failed: exit 1'), 'Traceback ...\n') });
  assert.match((await broken.provider.readiness()).needs[0], /could not load Agent Framework: Command failed/);
  const noModel = rig({ servers: [OLLAMA_DOWN] });
  assert.deepEqual(await noModel.provider.readiness(), { ready: false, version: 'Agent Framework 1.24.0', needs: ['Start LM Studio or Ollama with a chat model. The team runs on it.'] });
  const ok = rig();
  assert.deepEqual(await ok.provider.readiness(), { ready: true, version: 'Agent Framework 1.24.0', needs: [] });
  for (const x of [noPy, noAf, broken, noModel, ok]) x.done();
});

test('open: Python runs the runner outside the worktree with a scrubbed environment; the start line names the local server and the team', async () => {
  const o = rig();
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const sp = o.spawned[0];
  assert.equal(sp.file, RIG_PY);
  assert.deepEqual(sp.args, ['-u', RUNNER]);
  assert.notEqual(sp.opts.cwd, o.cwd, 'not the worktree: a planted module there is never imported');
  assert.equal(sp.opts.env.OPENAI_API_KEY, undefined);
  assert.equal(sp.opts.env.AZURE_OPENAI_ENDPOINT, undefined);
  assert.equal(sp.opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(s.pid, 5151);
  const [start] = sp.child.lines();
  assert.equal(start.type, 'start');
  assert.equal(start.model, 'qwen/qwen3-8b', 'the server\'s own model id');
  assert.equal(start.base_url, 'http://127.0.0.1:1234/v1', 'the default model client is the local server');
  assert.deepEqual(start.team.agents.map((a) => a.name), ['lead', 'coder', 'reviewer']);
  assert.match(start.team.agents[1].instructions, new RegExp(`^You work in the folder ${o.cwd.replace(/\\/g, '\\\\')} as coder in the team Team\\.`));
  assert.deepEqual(start.tools.map((t) => t.function.name).sort(), ['Bash', 'Edit', 'Grep', 'LS', 'Read', 'Write', 'office_ask', 'office_room'], 'the definitions of the tools the team uses');
  await until(() => s.model === 'lmstudio:qwen/qwen3-8b', 'the model on the session');
  o.done();
});

test('a recorded team turn: the lead is the bot, members are helpers by hand-off, tool calls go through the office gate', async () => {
  const o = rig({ rules: INSIDE });
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'Fix a.txt');
  await until(() => child.lines().some((m) => m.type === 'message'), 'the message on stdin');
  assert.deepEqual(child.lines()[1], { type: 'message', text: 'Fix a.txt' });
  const playing = play(child, RECORDED);
  // The coder's git push is a high-risk call: it comes to the office, on the coder's helper, with no Always allow.
  await until(() => s.pending.length === 1, 'the approval');
  const req = s.pending[0];
  assert.equal(req.tool, 'Bash');
  assert.equal(req.risk, 'high');
  assert.match(req.agent, /^coder-\d+$/, 'the request is the coder\'s');
  assert.equal(s.status, 'waiting');
  o.release(req.id, { allow: true });
  await playing;
  await until(() => s.status === 'idle', 'the end of the turn');
  // Replies: one per agent response; a member's starts with its name.
  assert.deepEqual(s.replies.map((r) => r.text), ['I plan the work.', 'coder: I change a.txt.', 'reviewer: Looks right.', 'The team changed a.txt.']);
  // Teams to bots, hand-offs to delegations: coder and reviewer became helpers, and both finished.
  assert.deepEqual(s.agents.map((a) => ({ type: a.type, done: a.done, ok: a.ok })), [{ type: 'coder', done: true, ok: true }, { type: 'reviewer', done: true, ok: true }]);
  // Tool calls to tool calls: the lead's Read is the bot's own; the coder's Bash is on its helper.
  const calls = s.calls.map((c) => ({ name: c.name, agent: c.agent || null, ok: c.ok }));
  assert.deepEqual(calls, [
    { name: 'Read', agent: null, ok: true },
    { name: 'Agent', agent: null, ok: true },
    { name: 'Bash', agent: s.agents[0].id, ok: true },
    { name: 'Agent', agent: null, ok: true },
  ]);
  assert.deepEqual(o.ran, [{ name: 'Read', input: { file_path: 'a.txt' } }, { name: 'Bash', input: { command: 'git push' } }], 'the office ran both tools');
  const results = child.lines().filter((m) => m.type === 'tool_result');
  assert.deepEqual(results, [{ type: 'tool_result', id: 't1', text: 'ran Read' }, { type: 'tool_result', id: 't2', text: 'ran Bash' }]);
  assert.equal(s.usage.tokens, 360, 'tokens from the local server');
  assert.equal(s.cost, 0, 'a local team costs nothing');
  assert.equal(s.error, null);
  assert.equal(s.tool, null);
  o.done();
});

test('a sequential team: each member is a helper from its first word until its executor completes', async () => {
  const o = rig({ rules: INSIDE });
  fs.writeFileSync(path.join(o.cwd, TEAM_FILE), JSON.stringify({ pattern: 'sequential', agents: [
    { name: 'writer', instructions: 'Write.' }, { name: 'editor', instructions: 'Edit.' }, { name: 'checker', instructions: 'Check.' }] }));
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'Write the docs');
  await until(() => child.lines().some((m) => m.type === 'message'), 'the message');
  const ev = (event, id, extra = {}) => JSON.stringify({ type: 'event', event, executor_id: id, ...extra });
  const said = (id, rid, text) => ev('output', id, { author: id, response_id: rid, contents: [{ type: 'text', text }] });
  await play(child, [ev('executor_invoked', 'writer'), said('writer', 'w1', 'Draft done.'), ev('executor_completed', 'writer'),
    ev('executor_invoked', 'editor'), said('editor', 'e1', 'Edited.'),
    JSON.stringify({ type: 'tool', id: 't1', agent: 'editor', name: 'Read', input: { file_path: 'a.txt' } }), ev('executor_completed', 'editor')]);
  assert.deepEqual(s.agents.map((a) => ({ type: a.type, done: a.done, ok: a.ok })), [{ type: 'editor', done: true, ok: true }], 'the editor finished when its executor completed');
  await play(child, [ev('executor_invoked', 'checker'), said('checker', 'c1', 'Checked.'), ev('executor_completed', 'checker'), JSON.stringify({ type: 'turn_end' })]);
  await until(() => s.status === 'idle', 'the end of the turn');
  assert.deepEqual(s.agents.map((a) => ({ type: a.type, done: a.done, ok: a.ok })), [{ type: 'editor', done: true, ok: true }, { type: 'checker', done: true, ok: true }]);
  assert.deepEqual(s.replies.map((r) => r.text), ['Draft done.', 'editor: Edited.', 'checker: Checked.']);
  o.done();
});

test('a tool call that throws in the office goes back to the team as a failed call; the office does not crash', async () => {
  const o = rig({ rules: INSIDE, tools: () => ({ run: async () => { throw new Error('disk gone'); }, stop: () => {} }) });
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'go');
  await until(() => child.lines().some((m) => m.type === 'message'), 'the message');
  child.say({ type: 'tool', id: 't1', agent: 'lead', name: 'Read', input: { file_path: 'a.txt' } });
  await until(() => child.lines().some((m) => m.type === 'tool_result' && m.id === 't1'), 'the answer to t1');
  assert.deepEqual(child.lines().find((m) => m.id === 't1'), { type: 'tool_result', id: 't1', text: 'Error: disk gone' });
  assert.deepEqual(((c) => ({ ok: c.ok, err: c.err }))(s.calls.find((c) => c.name === 'Read')), { ok: false, err: 'Error: disk gone' }, 'the call shows as failed at once');
  // A throw before the tool runs (here: the approval hold of a risky call) is caught the same way.
  o.events.permission = () => { throw new Error('hold broke'); };
  child.say({ type: 'event', event: 'handoff_sent', source: 'lead', target: 'coder' });
  child.say({ type: 'tool', id: 't2', agent: 'coder', name: 'Bash', input: { command: 'git push' } });
  await until(() => child.lines().some((m) => m.type === 'tool_result' && m.id === 't2'), 'the answer to t2');
  assert.equal(child.lines().find((m) => m.id === 't2').text, 'Error: hold broke');
  assert.deepEqual(((c) => ({ ok: c.ok, err: c.err, agent: c.agent }))(s.calls.find((c) => c.name === 'Bash')), { ok: false, err: 'Error: hold broke', agent: s.agents[0].id });
  assert.deepEqual(o.ran, [], 'nothing ran');
  child.say({ type: 'turn_end' });
  await until(() => s.status === 'idle', 'the end of the turn');
  assert.equal(s.error, null, 'a failed call is not a failed turn');
  o.done();
});

test('a member calls only its own tools: a tool not in its list, or an agent not in the team, is refused', async () => {
  const o = rig();
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'go');
  await until(() => child.lines().some((m) => m.type === 'message'), 'the message');
  child.say({ type: 'event', event: 'handoff_sent', source: 'lead', target: 'reviewer' });
  child.say({ type: 'tool', id: 't1', agent: 'reviewer', name: 'Edit', input: { file_path: 'a.txt', old_string: 'a', new_string: 'b' } });
  child.say({ type: 'tool', id: 't2', agent: 'ghost', name: 'Read', input: { file_path: 'a.txt' } });
  child.say({ type: 'tool', id: 't3', agent: 'lead', name: 'Bash', input: { command: 'dir' } });
  await until(() => child.lines().filter((m) => m.type === 'tool_result').length === 3, 'three answers');
  const text = (id) => child.lines().find((m) => m.type === 'tool_result' && m.id === id).text;
  assert.equal(text('t1'), 'Edit is not a tool of reviewer.');
  assert.equal(text('t2'), 'ghost is not an agent of the team Team.');
  assert.equal(text('t3'), 'Bash is not a tool of lead.');
  assert.deepEqual(o.ran, [], 'nothing ran');
  assert.equal(s.pending.length, 0, 'nothing asked');
  const edit = s.calls.find((c) => c.name === 'Edit');
  assert.equal(edit.ok, false);
  assert.equal(edit.agent, s.agents[0].id, 'the refused call shows on the reviewer\'s helper');
  o.done();
});

test(`a team turn has at most ${MAX_STEPS} steps (tool calls and hand-offs); then the office stops the run and says why`, async () => {
  const o = rig({ rules: INSIDE });
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'loop');
  await until(() => child.lines().some((m) => m.type === 'message'), 'the message');
  const lines = [JSON.stringify({ type: 'event', event: 'handoff_sent', source: 'lead', target: 'coder' })];
  for (let i = 1; i < MAX_STEPS; i++) lines.push(JSON.stringify({ type: 'tool', id: `t${i}`, agent: 'coder', name: 'Read', input: { file_path: 'a.txt' } }));
  await play(child, lines);
  assert.equal(o.ran.length, MAX_STEPS - 1, 'every step up to the limit ran');
  assert.equal(child.lines().some((m) => m.type === 'stop'), false, 'no stop yet');
  child.say({ type: 'tool', id: 'over', agent: 'coder', name: 'Read', input: { file_path: 'a.txt' } });
  await until(() => child.lines().some((m) => m.type === 'tool_result' && m.id === 'over'), 'the answer to the step over the limit');
  assert.equal(o.ran.length, MAX_STEPS - 1, 'the step over the limit did not run');
  assert.match(child.lines().find((m) => m.id === 'over').text, new RegExp(`^Stopped: The team used all ${MAX_STEPS} steps of one turn\\.`));
  assert.equal(child.lines().filter((m) => m.type === 'stop').length, 1, 'the office stopped the run');
  child.say({ type: 'turn_end', stopped: true });
  await until(() => s.status === 'idle' && s.error, 'the failed turn');
  assert.equal(s.error.text, `Agent Framework: The team used all ${MAX_STEPS} steps of one turn.`);
  assert.equal(s.agents[0].ok, false, 'the coder did not finish');
  // The next turn has its own steps.
  o.say(s, 'again');
  await until(() => child.lines().filter((m) => m.type === 'message').length === 2, 'the next message');
  child.say({ type: 'tool', id: 'n1', agent: 'lead', name: 'Read', input: { file_path: 'a.txt' } });
  await until(() => child.lines().some((m) => m.type === 'tool_result' && m.id === 'n1'), 'the answer to n1');
  assert.equal(o.ran.length, MAX_STEPS);
  const docs = (f) => fs.readFileSync(path.join(HERE, '..', 'docs', f), 'utf8');
  assert.ok(docs('agents.md').includes(`at most ${MAX_STEPS} steps`) && docs('troubleshooting.md').includes(`all ${MAX_STEPS} steps of one turn`), 'the docs say the same limit');
  o.done();
});

test('a declined call goes back to the team as declined; the turn goes on', async () => {
  const o = rig();
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'push it');
  await until(() => child.lines().some((m) => m.type === 'message'), 'the message');
  child.say({ type: 'event', event: 'handoff_sent', source: 'lead', target: 'coder' });
  child.say({ type: 'tool', id: 't9', agent: 'coder', name: 'Bash', input: { command: 'git push --force' } });
  await until(() => s.pending.length === 1, 'the approval');
  o.release(s.pending[0].id, { allow: false });
  await until(() => child.lines().some((m) => m.type === 'tool_result'), 'the answer');
  assert.deepEqual(child.lines().find((m) => m.type === 'tool_result'), { type: 'tool_result', id: 't9', text: 'Declined from Agent Office.' });
  assert.deepEqual(o.ran, [], 'nothing ran');
  const bash = s.calls.find((c) => c.name === 'Bash');
  assert.equal(bash.ok, false);
  assert.equal(bash.err, 'Declined from Agent Office.');
  child.say({ type: 'turn_end' });
  await until(() => s.status === 'idle', 'the end of the turn');
  assert.equal(s.error, null);
  o.done();
});

// The Security room rules (security.mjs) decide every member call before a hold, from the team's own column (#23).
test('the Security room decides every member call: a default Ask holds even a low read, Deny refuses at once, a user-set Allow runs it', async () => {
  const turn = async (rules, call) => {
    const o = rig({ rules });
    const s = o.session();
    o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
    const child = o.child();
    o.say(s, 'go');
    await until(() => child.lines().some((m) => m.type === 'message'), 'the message');
    child.say({ type: 'event', event: 'handoff_sent', source: 'lead', target: 'coder' });
    child.say({ type: 'tool', id: 't1', agent: 'coder', ...call });
    return { o, s, child, answer: () => until(() => child.lines().some((m) => m.type === 'tool_result'), 'the answer').then(() => child.lines().find((m) => m.type === 'tool_result').text) };
  };
  const READ = { name: 'Read', input: { file_path: 'a.txt' } }, BASH = { name: 'Bash', input: { command: 'echo hi' } };
  // The defaults: a low read inside the worktree waits for the user, on the coder's helper.
  let r = await turn(cleanRules(null), READ);
  await until(() => r.s.pending.length === 1, 'the read to wait');
  assert.equal(r.s.pending[0].tool, 'Read');
  assert.equal(r.s.pending[0].agent, r.s.agents[0].id, 'the request is on the coder');
  assert.deepEqual(r.o.ran, [], 'nothing runs before the answer');
  r.o.release(r.s.pending[0].id, { allow: true });
  assert.equal(await r.answer(), 'ran Read');
  r.o.done();
  // A Deny the user set: refused at once with the reason for the team, one feed line, no hold.
  const deny = setRule(cleanRules(null), { scope: 'office', row: 'shell', col: 'agent-framework', value: 'deny' }).rules;
  r = await turn(deny, BASH);
  assert.equal(await r.answer(), 'Denied by the Security room: Shell commands.');
  assert.equal(r.o.holds.size, 0, 'nothing waited for the user');
  assert.deepEqual(r.o.ran, []);
  assert.deepEqual(((c) => [c.ok, c.agent])(r.s.calls.find((c) => c.name === 'Bash')), [false, r.s.agents[0].id]);
  assert.ok(r.o.tracker.feed.some((f) => f.text === 'denied by Security: Shell commands'));
  r.o.done();
  // The local model's column is not the team's: its Deny holds the team's command for the user.
  const localDeny = setRule(cleanRules(null), { scope: 'office', row: 'shell', col: 'local', value: 'deny' }).rules;
  r = await turn(localDeny, BASH);
  await until(() => r.s.pending.length === 1, 'the command to wait');
  r.o.done();
  // An Allow the user set on reads inside: the read runs with no question and no feed line (a low call, quiet).
  r = await turn(INSIDE, READ);
  assert.equal(await r.answer(), 'ran Read');
  assert.equal(r.o.holds.size, 0);
  assert.ok(!r.o.tracker.feed.some((f) => /allowed by Security/.test(f.text)), 'a quiet answer writes no line');
  r.o.done();
});

test('an office tool needs no approval; a member reaches office_ask through the office tools', async () => {
  const asked = [];
  const o = rig({ officeTools: { ask: async (s, q) => { asked.push(q); return 'Yes'; }, inbox: async () => '', room: async () => 'Room 1', roomUpdate: async () => 'ok' } });
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'go');
  await until(() => child.lines().some((m) => m.type === 'message'), 'the message');
  child.say({ type: 'tool', id: 't1', agent: 'lead', name: 'office_ask', input: { question: 'Push now?' } });
  await until(() => child.lines().some((m) => m.type === 'tool_result'), 'the answer');
  assert.deepEqual(asked, ['Push now?']);
  assert.equal(child.lines().find((m) => m.type === 'tool_result').text, 'Yes');
  assert.equal(s.pending.length, 0);
  o.done();
});

test('a message during a run waits, then reaches the team at the end of the run (Stop), before the turn ends', async () => {
  const o = rig();
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'first');
  await until(() => child.lines().filter((m) => m.type === 'message').length === 1, 'the first message');
  s.inbox.push({ text: 'also update the docs', t: Date.now() }); // the office queues a chat message for the busy session
  child.say({ type: 'event', event: 'output', executor_id: 'lead', author: 'lead', response_id: 'r1', contents: [{ type: 'text', text: 'Done.' }] });
  child.say({ type: 'turn_end' });
  await until(() => child.lines().filter((m) => m.type === 'message').length === 2, 'the second message');
  assert.match(child.lines().filter((m) => m.type === 'message')[1].text, /Message from the user in Agent Office:\n- also update the docs/);
  assert.equal(s.status, 'working', 'no result between: the run goes on');
  child.say({ type: 'turn_end' });
  await until(() => s.status === 'idle', 'the end of the turn');
  o.done();
});

test('interrupt: stop goes to the runner, a waiting approval is dropped, and the stopped run is not an error', async () => {
  const o = rig();
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'go');
  await until(() => child.lines().some((m) => m.type === 'message'), 'the message');
  child.say({ type: 'event', event: 'handoff_sent', source: 'lead', target: 'coder' });
  child.say({ type: 'tool', id: 't1', agent: 'coder', name: 'Bash', input: { command: 'npm test' } });
  await until(() => s.pending.length === 1, 'the approval');
  o.provider.interrupt(s);
  o.tracker.interrupt(s); // the server marks the turn after the call (seam rule 1)
  assert.equal(child.lines().pop().type, 'stop');
  await until(() => child.lines().some((m) => m.type === 'tool_result'), 'the dropped call');
  assert.equal(child.lines().find((m) => m.type === 'tool_result').text, 'Stopped');
  child.say({ type: 'turn_end', stopped: true });
  await until(() => s.status === 'idle', 'the stopped turn');
  assert.equal(s.error, null, 'a stopped turn is not an error');
  assert.equal(s.agents[0].done, true);
  assert.equal(s.agents[0].ok, false, 'the helper stopped before it finished');
  o.done();
});

test('a failed run shows as Error; a member that failed shows on its helper', async () => {
  const o = rig();
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  o.say(s, 'go');
  await until(() => child.lines().some((m) => m.type === 'message'), 'the message');
  child.say({ type: 'event', event: 'handoff_sent', source: 'lead', target: 'coder' });
  child.say({ type: 'event', event: 'executor_failed', executor_id: 'coder', error: 'APIConnectionError: Connection error.' });
  child.say({ type: 'turn_end', error: 'APIConnectionError: Connection error.' });
  await until(() => s.error, 'the error');
  assert.match(s.error.text, /^Agent Framework: APIConnectionError: Connection error\.$/);
  assert.equal(s.calls.find((c) => c.name === 'Agent').err, 'APIConnectionError: Connection error.');
  o.done();
});

test('the runner stops: a fatal start or an exit ends the session with the reason; after close nothing is reported', async () => {
  const o = rig();
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  const child = o.child();
  child.say({ type: 'fatal', error: "ImportError: cannot import name 'HandoffBuilder'" });
  await new Promise((r) => setImmediate(r));
  child.exit(1);
  assert.equal(s.status, 'ended');
  assert.match(s.replies.pop().text, /Agent Framework stopped: ImportError: cannot import name 'HandoffBuilder'/);
  assert.throws(() => o.provider.message(s, { text: 'hi' }), (e) => e.status === 409);

  const o2 = rig();
  const s2 = o2.session();
  o2.provider.open(s2, { model: 'lmstudio:qwen/qwen3-8b' });
  const c2 = o2.child();
  o2.say(s2, 'go');
  await until(() => c2.lines().some((m) => m.type === 'message'), 'the message');
  c2.stderr.write('Traceback: boom\n');
  await new Promise((r) => setImmediate(r));
  c2.exit(1);
  assert.equal(s2.status, 'ended');
  assert.match(s2.error.text, /Agent Framework stopped: Traceback: boom/, 'a run that was going shows as Error');

  const o3 = rig();
  const s3 = o3.session();
  o3.provider.open(s3, { model: 'lmstudio:qwen/qwen3-8b' });
  const c3 = o3.child();
  const before = s3.replies.length;
  await o3.provider.close(s3);
  assert.equal(c3.lines().pop().type, 'close');
  c3.say({ type: 'event', event: 'output', author: 'lead', response_id: 'x', contents: [{ type: 'text', text: 'late' }] });
  c3.exit(0);
  await new Promise((r) => setImmediate(r));
  assert.equal(s3.replies.length, before, 'nothing after close');
  assert.notEqual(s3.status, 'ended', 'the office ends a closed session, not the runner exit');
  assert.throws(() => o3.provider.message(s3, { text: 'hi' }), (e) => e.status === 409);
  for (const x of [o, o2, o3]) x.done();
});

test('close kills a runner that does not end', async () => {
  const o = rig();
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  await o.provider.close(s);
  await until(() => o.killed.length === 1, 'the kill', 5000);
  assert.deepEqual(o.killed, [5151]);
  o.done();
});

test('open with a bad team file or a model of no server: the session says why and ends', async () => {
  const o = rig();
  fs.writeFileSync(path.join(o.cwd, TEAM_FILE), '{');
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  await until(() => s.status === 'ended', 'the end');
  assert.match(s.replies.pop().text, /^Could not start the team: agent-team\.json: the file is not valid JSON\./);
  assert.equal(o.spawned.length, 0, 'no runner');
  o.done();
});

test('message: text only, and only while the team runs', () => {
  const o = rig();
  const s = o.session();
  assert.throws(() => o.provider.message(s, { text: 'x' }), (e) => e.status === 409);
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  assert.throws(() => o.provider.message(s, { text: 'x', attachments: [{ name: 'a.png', mime: 'image/png', data: '' }] }), (e) => e.status === 415);
  o.done();
});

test('the server offers the kind next to Claude Code and the local models (one registry)', () => {
  const events = { hook() {}, permission() {}, stream() {}, reply() {}, feed() {}, end() {} };
  const lm = createLocal({ events, kind: 'lmstudio' });
  const af = createAgentFramework({ events, servers: [lm] });
  assert.equal(lm.baseUrl, 'http://127.0.0.1:1234/v1', 'a local provider says which server it uses');
  assert.deepEqual(createRegistry([lm, af]).kinds().map((k) => k.kind), ['lmstudio', 'agent-framework']);
});

// ---------- the real runner against a stand-in framework (Python only) ----------
function findPython() {
  for (const name of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    try {
      const file = resolveExe(name);
      execFileSync(file, ['-c', 'import sys; assert sys.version_info >= (3, 9)'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
      return file;
    } catch { /* next */ }
  }
  return null;
}
const PY = findPython();

test('the real runner: --check without the framework says what is missing', { skip: !PY && 'no Python on this machine' }, () => {
  const out = execFileSync(PY, ['-u', RUNNER, '--check'], { env: runnerEnv(process.env), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const r = JSON.parse(out.trim().split('\n').pop());
  // The machine may have the real framework. Without it the answer names the module.
  if (r.ok) assert.ok(r.version);
  else assert.match(r.error, /agent_framework/);
});

// The provider as the server builds it, with real Python and the real runner; only the framework is a stand-in.
// rules: a user who allowed reads and edits inside the worktree, unless the test gives others.
async function realRig(t, rules = INSIDE) {
  const fake = path.join(HERE, 'fixtures', 'fake-af');
  const o = rig({ rules });
  const real = await import('node:child_process');
  o.provider = createAgentFramework({
    events: o.events, servers: [LMSTUDIO],
    env: { ...process.env, PYTHONPATH: fake, OPENAI_API_KEY: 'sk-cloud', OFFICE_AF_PYTHON: PY },
    spawn: (file, args, opts) => { const c = real.spawn(file, args, opts); o.spawned.push({ file, args, opts, child: c }); return c; },
    makeTools: () => ({ run: async (name, input) => { o.ran.push({ name, input }); return { ok: true, text: name === 'LS' ? 'a.txt' : 'checked' }; }, stop: () => {} }),
  });
  t.after(() => { for (const x of o.spawned) if (x.child.exitCode === null) x.child.kill(); o.done(); });
  return o;
}

test('the real runner with a stand-in framework: Stop cancels the run in a tool call; the team is built again and takes the next message', { skip: !PY && 'no Python on this machine' }, async (t) => {
  const o = await realRig(t);
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  o.say(s, 'Check the folder');
  await until(() => s.pending.length === 1, 'the coder\'s Bash approval', 15000);
  o.provider.interrupt(s);
  o.tracker.interrupt(s);
  await until(() => s.status === 'idle', 'the stopped run', 15000);
  assert.equal(s.error, null, 'a stopped run is not an error');
  assert.equal(o.ran.some((r) => r.name === 'Bash'), false, 'the stopped call did not run');
  const n = s.replies.length;
  o.say(s, 'Again');
  await until(() => s.pending.length === 1, 'the approval of the new run', 15000);
  o.release(s.pending[0].id, { allow: true });
  await until(() => s.status === 'idle' && s.replies.length >= n + 4, 'the new run', 15000);
  assert.equal(s.error, null);
});

test('the real runner with a stand-in framework: a team run, two proxied tools, a hand-off, then the user\'s answer', { skip: !PY && 'no Python on this machine' }, async (t) => {
  const o = await realRig(t);
  assert.deepEqual(await o.provider.readiness(), { ready: true, version: 'Agent Framework 0.0-fake', needs: [] });
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  o.say(s, 'Check the folder');
  await until(() => s.pending.length === 1, 'the coder\'s Bash approval', 15000);
  assert.match(s.pending[0].agent, /^coder-/);
  o.release(s.pending[0].id, { allow: true });
  await until(() => s.status === 'idle' && s.replies.length >= 4, 'the end of the first run', 15000);
  // A response is split at its tool call, like a Claude Code turn: text, the tool, more text.
  assert.deepEqual(s.replies.map((r) => r.text), ['I look first.', 'The folder has: a.txt', 'coder: Running the check.', 'coder: Result: checked']);
  assert.deepEqual(o.ran, [{ name: 'LS', input: { path: '.' } }, { name: 'Bash', input: { command: 'echo checked' } }]);
  assert.deepEqual(s.agents.map((a) => ({ type: a.type, ok: a.ok })), [{ type: 'coder', ok: true }]);
  assert.equal(s.usage.tokens, 150);
  // The team asked for input: the next message is the answer, and the client was the local server, with no cloud key.
  o.say(s, 'thanks');
  await until(() => s.replies.length === 5 && s.status === 'idle', 'the second run', 15000);
  assert.equal(s.replies[4].text, 'Done. You said: thanks. Model qwen/qwen3-8b at http://127.0.0.1:1234/v1 with key agent-office-local.');
  assert.equal(s.error, null);
  const child = o.child();
  await o.provider.close(s);
  await until(() => child.exitCode !== null, 'the runner exit', 10000);
  assert.equal(child.exitCode, 0, 'the runner ends on close');
});

test('the real runner with a stand-in framework: a sequential team shows every member\'s reply, not only the last one', { skip: !PY && 'no Python on this machine' }, async (t) => {
  const o = await realRig(t);
  fs.writeFileSync(path.join(o.cwd, TEAM_FILE), JSON.stringify({ pattern: 'sequential', agents: [
    { name: 'writer', instructions: 'Write.' }, { name: 'editor', instructions: 'Edit.' }, { name: 'checker', instructions: 'Check.' }] }));
  const s = o.session();
  o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
  o.say(s, 'Write the docs');
  await until(() => s.status === 'idle' && s.replies.length >= 3, 'the sequential run', 15000);
  // Each later member gets a user turn after the one before it (a chat server can answer an assistant-last prompt with nothing).
  assert.deepEqual(s.replies.map((r) => r.text), ['writer did its part.', 'editor: editor did its part (user turn).', 'checker: checker did its part (user turn).']);
  assert.deepEqual(s.agents.map((a) => ({ type: a.type, ok: a.ok })), [{ type: 'editor', ok: true }, { type: 'checker', ok: true }]);
  assert.equal(s.error, null);
});

test('the real runner: a message that comes while a run runs is kept and runs next, never dropped', { skip: !PY && 'no Python on this machine' }, async (t) => {
  const real = await import('node:child_process');
  const child = real.spawn(PY, ['-u', RUNNER], { env: { ...runnerEnv(process.env), PYTHONPATH: path.join(HERE, 'fixtures', 'fake-af') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const got = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) got.push(JSON.parse(l)); } });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const tool = (name) => got.find((m) => m.type === 'tool' && m.name === name);
  send({ type: 'start', model: 'm', base_url: 'http://127.0.0.1:1234/v1', team: DEFAULT_TEAM, tools: TOOL_DEFINITIONS });
  send({ type: 'message', text: 'one' });
  await until(() => tool('LS'), 'the LS call of the first run', 15000);
  send({ type: 'message', text: 'two' }); // the first run still waits for its tool
  send({ type: 'tool_result', id: tool('LS').id, text: 'a.txt' });
  await until(() => tool('Bash'), 'the Bash call', 15000);
  send({ type: 'tool_result', id: tool('Bash').id, text: 'checked' });
  await until(() => got.filter((m) => m.type === 'turn_end').length === 2, 'two runs', 15000);
  const last = got.filter((m) => m.type === 'event' && m.event === 'output').pop();
  assert.match(last.contents[0].text, /^Done\. You said: two\./, 'the kept message ran as the next run');
  assert.deepEqual(got.filter((m) => m.type === 'turn_end'), [{ type: 'turn_end' }, { type: 'turn_end' }]);
  send({ type: 'close' });
  await until(() => child.exitCode !== null, 'the runner exit', 10000);
});

// #164: the team's model server gives the window (providers/local.mjs windowOf); the used tokens are the last response's
// prompt plus completion. A server that does not know the window leaves the Context bar unknown.
for (const [name, windowOf, want] of [['a known window', () => 32768, [240, 32768]], ['an unknown window', () => null, null]]) {
  test(`the Context bar of a team: ${name}`, async () => {
    const o = rig({ rules: INSIDE, servers: [{ ...LMSTUDIO, windowOf }, OLLAMA_DOWN] });
    const s = o.session();
    o.provider.open(s, { model: 'lmstudio:qwen/qwen3-8b' });
    const child = o.child();
    o.say(s, 'Fix a.txt');
    await until(() => child.lines().some((m) => m.type === 'message'), 'the message on stdin');
    const playing = play(child, RECORDED);
    await until(() => s.pending.length === 1, 'the approval');
    o.release(s.pending[0].id, { allow: true });
    await playing;
    await until(() => s.status === 'idle', 'the end of the turn');
    if (want) assert.deepEqual([s.ctxTokens, s.ctxWindow], want);
    else assert.equal(s.ctxWindow, null);
    o.done();
  });
}
