// Microsoft Agent Framework provider tests (#23). The team runner is a fake child process that plays recorded runner lines
// (test/fixtures/agent-framework.jsonl), with a real tracker and the real tool gate. One test runs the real Python runner
// against a stand-in framework package (test/fixtures/fake-af), when Python is on this machine. No model, no network, no cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createTracker } from '../tracker.mjs';
import { providerEvents, checkProvider, createRegistry, describe as describeKind } from '../providers/index.mjs';
import { createAgentFramework, readTeam, teamOf, runnerEnv, DEFAULT_TEAM, TEAM_FILE, TOOL_NAMES, RUNNER, SETUP } from '../providers/agent-framework.mjs';
import { createLocal } from '../providers/local.mjs';
import { resolveExe } from '../git.mjs';

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

// The office side: a tracker, the events, the holds without sockets (as server.mjs holds them), and the provider.
function rig({ env = {}, servers = [LMSTUDIO, OLLAMA_DOWN], execFile, exe, officeTools, tools } = {}) {
  const o = { holds: new Map(), ids: {}, spawned: [], killed: [], ran: [] };
  o.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-af-'));
  o.tracker = createTracker({
    now: Date.now, makeId: (k) => `${k[0]}${(o.ids[k] = (o.ids[k] || 0) + 1)}`, locate: async () => null,
    setTimer: () => 0, releaseHold: (id, d) => o.release(id, d),
  });
  o.events = providerEvents({ tracker: o.tracker, hold: (r) => o.holds.set(r.id, { s: r.s, suggestions: r.suggestions }) });
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
  o.session = () => o.tracker.newSession({ uid: 'o1', officeId: 'o1', name: 'team', cwd: o.cwd, headless: true, status: 'starting', provider: 'agent-framework' });
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

test('the provider has the seam shape: free, a model to pick, no resume, a team', () => {
  const o = rig();
  const p = checkProvider(o.provider);
  assert.equal(p.kind, 'agent-framework');
  assert.equal(p.label, 'Agent Framework');
  assert.deepEqual(describeKind(p), { kind: 'agent-framework', label: 'Agent Framework', paid: false, terminal: false, modes: [], needsModel: true, control: false, team: true });
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
  assert.deepEqual(teamOf(dir).agents.map((a) => a.name), ['lead', 'coder', 'reviewer']);
  fs.writeFileSync(path.join(dir, TEAM_FILE), JSON.stringify({ agents: [{ name: 'solo', instructions: 'Do it.' }] }));
  assert.deepEqual(teamOf(dir).agents.map((a) => a.name), ['solo']);
  assert.throws(() => teamOf(dir, () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; }), (e) => e.status === 400 && /cannot read it \(EACCES\)/.test(e.message));
  fs.rmSync(dir, { recursive: true, force: true });
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
  assert.equal(calls[0].file, 'C:\\py\\python.exe', 'Python by its full path');
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
  assert.equal(sp.file, 'C:\\py\\python.exe');
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
  const o = rig();
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
async function realRig(t) {
  const fake = path.join(HERE, 'fixtures', 'fake-af');
  const o = rig();
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
