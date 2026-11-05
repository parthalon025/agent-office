// The ACP provider (providers/acp.mjs) against a fake ACP agent: a real Node process that speaks newline-delimited JSON-RPC
// on stdio (test/fixtures/fake-acp.mjs). The provider gets the agent's absolute program path from an injected resolver and a
// spawn that runs the fixture instead, so no Hermes, no dsh, no model and no paid call. The office side is in memory: a
// tracker, the shared provider events and holds without sockets, as server.mjs holds them.
// Run: node --test test/acp-provider.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTracker } from '../tracker.mjs';
import { providerEvents, createRegistry, checkProvider, spendLimitFor, isPaid, isGated, supervisionOf } from '../providers/index.mjs';
import { createAcp, AGENTS, commandLine } from '../providers/acp.mjs';
import { createLocalTools } from '../providers/local-tools.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp.mjs');

async function until(fn, what, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// One office with one ACP provider and a fake agent. fake: the fixture's environment (FAKE_ACP_*).
function rig({ kind = 'hermes', fake = {}, ...over } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-acp-')));
  const root = path.join(base, 'work'), outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  const logFile = path.join(base, 'agent-log.jsonl');
  const r = { base, root, outside, logFile, holds: new Map(), spawned: [], timers: [], t: 1_000_000 };
  r.tracker = createTracker({ now: () => r.t, locate: async () => null, releaseHold: (id, d) => r.release(id, d), setTimer: (fn) => { fn(); return 0; } });
  r.release = (id, d) => {
    const h = r.holds.get(id);
    if (!h) return false;
    r.holds.delete(id); r.tracker.settle(h.uid, id); h.reply(d || {});
    return true;
  };
  r.events = providerEvents({
    tracker: r.tracker,
    hold: (q) => r.holds.set(q.id, { uid: q.s.uid, reply: (d) => r.p.answer(q.s, { id: q.id, suggestions: q.suggestions }, d) }),
    release: (id) => r.release(id, {}),
    fresh: (s) => r.freshened.push(s.uid),
  });
  // What each held card showed the user: the tool and its input at the moment of the hold.
  r.shown = [];
  r.freshened = [];
  const permission = r.events.permission;
  r.events.permission = (s, p) => { r.shown.push({ tool: p.tool_name, input: { ...p.tool_input } }); return permission(s, p); };
  r.p = createAcp({
    events: r.events, kind,
    exe: (name) => `C:/bin/${name}.exe`,
    spawn: (file, args, opts) => {
      r.spawned.push({ file, args, opts });
      return realSpawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...opts.env, ...fake, FAKE_ACP_LOG: logFile } });
    },
    setTimer: (fn, ms) => { r.timers.push({ fn, ms }); return r.timers.length; },
    clearTimer: () => {},
    ...over,
  });
  r.session = (fields = {}) => r.tracker.newSession({ uid: 'o1', officeId: 'o1', provider: kind, name: 'bot', cwd: root, startDir: root, headless: true, status: 'starting', ...fields });
  // What the agent got from the office, one message per line.
  r.log = () => { try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  r.sent = (method) => r.log().filter((m) => m.method === method);
  // What server.mjs sendMessage does for an office session at rest.
  r.say = (s, text) => { r.p.message(s, { text }); r.tracker.userMessage(s); r.tracker.startTurn(s, text); };
  r.steps = (s, steps) => r.say(s, JSON.stringify(steps));
  r.replies = (s) => s.replies.map((x) => x.text);
  r.idle = (s) => until(() => s.status === 'idle' && s.turns > 0, 'the turn to end');
  r.done = async (s) => { if (s) await r.p.close(s); fs.rmSync(base, { recursive: true, force: true }); };
  return r;
}
async function started(r, s, opts = {}) {
  r.p.open(s, opts);
  await until(() => s.sid, 'the session to start');
  return s;
}

test('open: the agent by its absolute path, the handshake offers files and terminals, then a new session in the folder', async () => {
  const r = rig();
  const s = r.session();
  try {
    assert.equal(checkProvider(r.p), r.p);
    assert.deepEqual([r.p.kind, r.p.label, isPaid(r.p), r.p.cost, r.p.canResume], ['hermes', 'Hermes Agent', true, 'unknown', false]);
    r.p.open(s, {});
    assert.equal(s.sid, null, 'nothing is reported inside open (seam timing rule 1)');
    await until(() => s.sid, 'the session id');
    assert.deepEqual([r.spawned[0].file, r.spawned[0].args], ['C:/bin/hermes.exe', ['acp']]);
    assert.deepEqual([r.spawned[0].opts.cwd, r.spawned[0].opts.env.OFFICE_ID], [r.root, 'o1']);
    const [init] = r.sent('initialize');
    assert.equal(init.params.protocolVersion, 1);
    assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    assert.equal(init.params.clientInfo.name, 'agent-office');
    assert.deepEqual(r.sent('session/new').map((m) => m.params), [{ cwd: r.root, mcpServers: [] }]);
    assert.deepEqual([s.sid, s.status, s.mode], ['fake-sess-1', 'idle', 'default']);
    assert.equal(AGENTS.dsh.program, 'dsh');
    assert.deepEqual(AGENTS.dsh.args, ['--profile', 'acp']);
  } finally { await r.done(s); }
});

test('gating is per agent (ADR 0001): Hermes runs commands itself, so it is partly supervised; dsh asks for its calls', () => {
  const r = rig(), d = rig({ kind: 'dsh' });
  try {
    // Hermes Agent's ACP server never uses the client's fs or terminal, and asks for a command only when it matches its own
    // danger patterns (acp_adapter/server.py; upstream issue #139074). Its edits ask in its default mode.
    assert.deepEqual([r.p.gated, isGated(r.p), supervisionOf(r.p)], [false, false, 'Partly supervised: file edits ask, commands do not']);
    assert.deepEqual([AGENTS.hermes.gated, AGENTS.dsh.gated], [false, true]);
    assert.deepEqual([d.p.gated, supervisionOf(d.p)], [true, null]);
    assert.doesNotThrow(() => checkProvider(r.p));
    assert.doesNotThrow(() => checkProvider(d.p));
  } finally { fs.rmSync(r.base, { recursive: true, force: true }); fs.rmSync(d.base, { recursive: true, force: true }); }
});

test('a text turn: live text, the reply, at rest after; the cost stays unknown, never $0.00', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.say(s, 'hi there');
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['echo: hi there']);
    assert.deepEqual([s.status, s.error, s.cost, s.turns], ['idle', null, null, 1]);
    assert.deepEqual(r.sent('session/prompt').map((m) => m.params), [{ sessionId: 'fake-sess-1', prompt: [{ type: 'text', text: 'hi there' }] }]);
    assert.equal(spendLimitFor({ paid: isPaid(r.p), cost: r.p.cost, requested: undefined }), null, 'no spend limit the office could not keep');
  } finally { await r.done(s); }
});

const EDIT_CALL = (root, file = 'a.txt', id = 'tc1') => ({ toolCallId: id, title: 'Edit ' + file, kind: 'edit', status: 'pending', locations: [{ path: path.join(root, file) }] });
const OPTIONS = [
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  { optionId: 'never', name: 'Never', kind: 'reject_always' },
];

test('a permission request is held; approve sends allow once, also when the user asked for always; decline sends reject once', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ tool: EDIT_CALL(r.root) }, { ask: { toolCall: EDIT_CALL(r.root), options: OPTIONS } }, { ask: { toolCall: EDIT_CALL(r.root, 'b.txt', 'tc2'), options: OPTIONS } }]);
    await until(() => s.pending.length === 1, 'the first request');
    assert.equal(s.status, 'waiting');
    assert.deepEqual([s.pending[0].tool, s.pending[0].detail, s.pending[0].risk, s.pending[0].always], ['Edit', 'a.txt', 'low', '']);
    assert.deepEqual(s.calls.map((c) => [c.id, c.name, c.ok]), [['tc1', 'Edit', null]], 'the tool call shows while it waits');
    r.release(s.pending[0].id, { allow: true, always: true });
    await until(() => s.pending.length === 1 && r.replies(s).length === 1, 'the second request');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['asked: selected once', 'asked: selected no']);
  } finally { await r.done(s); }
});

test('an agent that offers only Always allow is never given it: Approve declines, and the feed says why', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ ask: { toolCall: EDIT_CALL(r.root), options: [OPTIONS[0], OPTIONS[2]] } }]);
    await until(() => s.pending.length === 1, 'the request');
    r.release(s.pending[0].id, { allow: true, always: true });
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['asked: selected no']);
    assert.ok(r.tracker.feed.some((f) => /offers only Always allow/.test(f.text)), r.tracker.feed.map((f) => f.text).join('\n'));
  } finally { await r.done(s); }
});

// ---------- the office serves files (fs) ----------

test('fs: a read and a write inside the worktree run at once; the text comes back raw', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ read: { path: path.join(r.root, 'a.txt') } }, { read: { path: path.join(r.root, 'a.txt'), line: 2, limit: 1 } }, { write: { path: path.join(r.root, 'new', 'b.txt'), content: 'bee' } }]);
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['read: one\ntwo\n', 'read: two', 'write: ok']);
    assert.equal(fs.readFileSync(path.join(r.root, 'new', 'b.txt'), 'utf8'), 'bee');
    assert.equal(r.holds.size, 0);
  } finally { await r.done(s); }
});

test('fs: a write outside the worktree is refused before anyone is asked, and nothing is written', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    const target = path.join(r.outside, 'x.txt');
    r.steps(s, [{ write: { path: target, content: 'x' } }, { read: { path: path.join(r.outside, '..', 'outside', 'x.txt') } }]);
    await r.idle(s);
    assert.match(r.replies(s)[0], /^write error: .*outside the working folder/);
    assert.match(r.replies(s)[1], /^read error: /);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual([r.holds.size, s.pending.length], [0, 0], 'no question about a write the office would refuse');
    assert.ok(r.tracker.feed.some((f) => /refused a write outside the worktree/.test(f.text)));
  } finally { await r.done(s); }
});

test('fs: a write to settings that run code is held; decline refuses it, approve writes it', async () => {
  const r = rig();
  const s = await started(r, r.session());
  const settings = path.join(r.root, '.claude', 'settings.json');
  try {
    r.steps(s, [{ write: { path: settings, content: '{"hooks":1}' } }, { write: { path: settings, content: '{"hooks":2}' } }]);
    await until(() => s.pending.length === 1, 'the first write to wait');
    assert.deepEqual([s.pending[0].tool, s.pending[0].risk], ['Write', 'high']);
    r.release(s.pending[0].id, { allow: false });
    await until(() => s.pending.length === 1 && r.replies(s).length === 1, 'the second write to wait');
    r.release(s.pending[0].id, { allow: true });
    await r.idle(s);
    assert.match(r.replies(s)[0], /^write error: Declined from Agent Office/);
    assert.equal(r.replies(s)[1], 'write: ok');
    assert.equal(fs.readFileSync(settings, 'utf8'), '{"hooks":2}');
  } finally { await r.done(s); }
});

test('fs: an edit the user declined cannot come back through fs/write_text_file in the same turn (Hermes #31682)', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    const file = path.join(r.root, 'a.txt');
    r.steps(s, [{ ask: { toolCall: EDIT_CALL(r.root), options: OPTIONS } }, { write: { path: file, content: 'changed anyway' } }]);
    await until(() => s.pending.length === 1, 'the edit request');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.equal(r.replies(s)[0], 'asked: selected no');
    assert.match(r.replies(s)[1], /^write error: .*declined/i);
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\n', 'the file is unchanged, though a write inside the root is low risk');
    assert.equal(r.holds.size, 0, 'refused at once, not asked again');
    // The next turn starts fresh: the decline was for that edit in that turn.
    r.steps(s, [{ write: { path: file, content: 'next turn' } }]);
    await until(() => r.replies(s).length === 3, 'the next turn');
    assert.equal(r.replies(s)[2], 'write: ok');
  } finally { await r.done(s); }
});

test('fs: the declined file is refused under another spelling of its path too', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    fs.mkdirSync(path.join(r.root, 'sub'));
    const spellings = [path.join(r.root, 'sub', '..', 'a.txt')];
    // Windows reads these as the same file: a trailing dot, the default data stream, another case.
    if (process.platform === 'win32') spellings.push(path.join(r.root, 'a.txt.'), path.join(r.root, 'a.txt::$DATA'), path.join(r.root, 'A.TXT'));
    r.steps(s, [{ ask: { toolCall: EDIT_CALL(r.root), options: OPTIONS } }, ...spellings.map((p) => ({ write: { path: p, content: 'sneaked in' } }))]);
    await until(() => s.pending.length === 1, 'the edit request');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.equal(r.replies(s).length, 1 + spellings.length);
    r.replies(s).slice(1).forEach((x, i) => assert.match(x, /^write error: .*declined/i, spellings[i]));
    assert.equal(fs.readFileSync(path.join(r.root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  } finally { await r.done(s); }
});

test('fs: after a declined edit that names no file, every write in that turn asks first', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    const vague = { toolCallId: 'v1', title: 'Apply the patch', kind: 'edit' };
    r.steps(s, [{ ask: { toolCall: vague, options: OPTIONS } }, { write: { path: path.join(r.root, 'a.txt'), content: 'patched' } }]);
    await until(() => s.pending.length === 1, 'the edit request');
    r.release(s.pending[0].id, { allow: false });
    await until(() => s.pending.length === 1 && r.replies(s).length === 1, 'the write to wait, though it is low risk');
    assert.deepEqual([s.pending[0].tool, s.pending[0].risk], ['Write', 'low']);
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.equal(fs.readFileSync(path.join(r.root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  } finally { await r.done(s); }
});

test('fs: an approved edit is written once without a second question', async () => {
  const r = rig();
  const s = await started(r, r.session());
  const settings = path.join(r.root, '.claude', 'settings.json');
  try {
    const call = { ...EDIT_CALL(r.root, path.join('.claude', 'settings.json')) };
    r.steps(s, [{ ask: { toolCall: call, options: OPTIONS } }, { write: { path: settings, content: '{"a":1}' } }, { write: { path: settings, content: '{"a":2}' } }]);
    await until(() => s.pending.length === 1, 'the edit request');
    assert.equal(s.pending[0].risk, 'high');
    r.release(s.pending[0].id, { allow: true });
    await until(() => s.pending.length === 1 && r.replies(s).length === 2, 'the second write to wait: the approval was for one write');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.deepEqual(r.replies(s).slice(0, 2), ['asked: selected once', 'write: ok']);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{"a":1}');
  } finally { await r.done(s); }
});

// ---------- the office serves terminals ----------
const PRINT = (js) => `node -e "${js}"`;

test('terminal: every command is held with the line that will run; approve runs it in the worktree, decline refuses it', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ term: { command: PRINT('console.log(process.cwd())') } }, { term: { command: PRINT('console.log(1)') } }]);
    await until(() => s.pending.length === 1, 'the first command to wait');
    assert.deepEqual([s.pending[0].tool, s.pending[0].detail, s.pending[0].risk], ['Bash', PRINT('console.log(process.cwd())'), 'medium']);
    r.release(s.pending[0].id, { allow: true });
    await until(() => s.pending.length === 1 && r.replies(s).length === 1, 'the second command to wait');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.equal(r.replies(s)[0].toLowerCase(), `term: exit 0: ${r.root}`.toLowerCase());
    assert.match(r.replies(s)[1], /^term error: Declined from Agent Office/);
  } finally { await r.done(s); }
});

test('terminal: args and variables are part of the line the user sees; a folder outside the worktree is refused unasked', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [
      { term: { command: 'node', args: ['-e', "console.log(process.env.GREETING + ' there')"], env: [{ name: 'GREETING', value: 'hi' }] } },
      { term: { command: PRINT('1'), cwd: r.outside } },
      { term: { command: PRINT('1'), env: [{ name: 'BAD NAME', value: 'x' }] } },
    ]);
    await until(() => s.pending.length === 1, 'the command to wait');
    const line = s.pending[0].preview;
    assert.match(line, /GREETING/);
    assert.match(line, /hi/);
    assert.match(line, /console\.log/);
    r.release(s.pending[0].id, { allow: true });
    await r.idle(s);
    assert.equal(r.replies(s)[0], 'term: exit 0: hi there');
    assert.match(r.replies(s)[1], /^term error: .*outside the working folder/);
    assert.match(r.replies(s)[2], /^term error: .*BAD NAME/);
    assert.equal(r.holds.size, 0);
  } finally { await r.done(s); }
});

test('commandLine: an argument the shell would read as more than text is refused, so the approved line is the line that runs', async () => {
  const payload = { command: 'echo', args: ['x" & echo INJECTED & "'] }; // review of #71: cmd.exe ignores \" when it tracks quotes
  if (process.platform === 'win32') {
    assert.throws(() => commandLine(payload), (e) => e.code === -32602 && /cannot pass/.test(e.message));
    // %NAME% and !NAME! expand inside quotes too, and a line break ends the command.
    for (const a of ['100%', '%PATH%', 'wow!', 'a\nb', 'a\rb']) assert.throws(() => commandLine({ command: 'echo', args: [a] }), /cannot pass/, JSON.stringify(a));
    assert.throws(() => commandLine({ command: 'echo', env: [{ name: 'A', value: '%PATH%' }] }), /variable A/);
  } else {
    assert.equal(commandLine(payload), `echo 'x" & echo INJECTED & "'`);
  }
  // The args that can be quoted arrive as one argument each, through the shell the office really runs.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-acp-q-')));
  try {
    const args = ['a b', 'x&y|z', '(c)', 'C:\\dir\\', 'it\'s'];
    const line = commandLine({ command: 'node', args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args] });
    const h = createLocalTools(base).start(line, { timeoutMs: 20_000 });
    const r = await h.done;
    assert.equal(r.exitCode, 0, h.output());
    assert.deepEqual(JSON.parse(h.output().trim()), args);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('terminal: a command the user approved in a request runs once without a second question', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    const cmd = PRINT('console.log(7)');
    const call = { toolCallId: 'tx', title: 'Run a command', kind: 'execute', rawInput: { command: cmd } };
    r.steps(s, [{ tool: call }, { ask: { toolCall: call, options: OPTIONS } }, { term: { command: cmd } },
      { update: { toolCallId: 'tx', status: 'completed', content: [{ type: 'terminal', terminalId: 'term_x' }] } }]);
    await until(() => s.pending.length === 1, 'the request');
    assert.deepEqual([s.pending[0].tool, s.pending[0].detail], ['Bash', cmd]);
    r.release(s.pending[0].id, { allow: true });
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['asked: selected once', 'term: exit 0: 7']);
    assert.deepEqual(s.calls.map((c) => [c.id, c.ok]), [['tx', true]]);
    assert.ok(!r.tracker.feed.some((f) => /without asking/.test(f.text)), 'it asked');
  } finally { await r.done(s); }
});

// ---------- an agent that changes a call after the user saw it ----------
// The answer is for what the card showed. An agent that changes the call while it waits gets reject once, the hold goes,
// and nothing the user approved moves to the new input.

test('a command the agent changes while its request waits is declined at once; the new line still asks', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    const call = { toolCallId: 'sw', title: 'Run a command', kind: 'execute', rawInput: { command: 'echo SAFE' } };
    r.steps(s, [{ ask: { toolCall: call, options: OPTIONS }, while: [{ update: { toolCallId: 'sw', rawInput: { command: 'echo SWAPPED' } } }] },
      { term: { command: 'echo SWAPPED' } }]);
    await until(() => r.replies(s).length === 1, 'the request to be declined');
    assert.deepEqual(r.shown[0], { tool: 'Bash', input: { command: 'echo SAFE' } }, 'the card showed the first command');
    assert.equal(r.replies(s)[0], 'asked: selected no');
    assert.ok(r.tracker.feed.some((f) => f.text === 'Hermes Agent changed the call while it waited for your answer, so the office declined it: echo SWAPPED'),
      r.tracker.feed.map((f) => f.text).join('\n'));
    await until(() => s.pending.length === 1, 'the swapped command to wait');
    assert.deepEqual([s.pending[0].tool, s.pending[0].detail], ['Bash', 'echo SWAPPED'], 'no approval moved to the new line');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.match(r.replies(s)[1], /^term error: Declined from Agent Office/);
  } finally { await r.done(s); }
});

test('an edit whose file the agent changes while its request waits is declined; the new file still asks', async () => {
  const r = rig();
  const s = await started(r, r.session());
  const settings = path.join(r.root, '.claude', 'settings.json');
  try {
    r.steps(s, [{ ask: { toolCall: EDIT_CALL(r.root), options: OPTIONS }, while: [{ update: { toolCallId: 'tc1', locations: [{ path: settings }] } }] },
      { write: { path: settings, content: '{"hooks":1}' } }]);
    await until(() => r.replies(s).length === 1, 'the request to be declined');
    assert.deepEqual(r.shown[0], { tool: 'Edit', input: { file_path: path.join(r.root, 'a.txt') } });
    assert.equal(r.replies(s)[0], 'asked: selected no');
    await until(() => s.pending.length === 1, 'the write to the new file to wait');
    assert.deepEqual([s.pending[0].tool, s.pending[0].risk], ['Write', 'high']);
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{}');
  } finally { await r.done(s); }
});

test('a call the agent changes after the user approved it: the grant stays with what the user saw, and the feed says so', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    const call = { toolCallId: 'ap', title: 'Run a command', kind: 'execute', rawInput: { command: 'echo SAFE' } };
    r.steps(s, [{ ask: { toolCall: call, options: OPTIONS } }, { update: { toolCallId: 'ap', rawInput: { command: 'echo SWAPPED' } } },
      { term: { command: 'echo SWAPPED' } }]);
    await until(() => s.pending.length === 1, 'the request');
    r.release(s.pending[0].id, { allow: true });
    await until(() => s.pending.length === 1 && r.replies(s).length === 1, 'the swapped command to wait');
    assert.equal(s.pending[0].detail, 'echo SWAPPED');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.ok(r.tracker.feed.some((f) => f.text === 'Hermes Agent changed the call after you approved it: echo SWAPPED'), r.tracker.feed.map((f) => f.text).join('\n'));
  } finally { await r.done(s); }
});

test('an approval ends with its call: a command the agent ran with its own tool asks again when it comes back as a terminal', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    const cmd = PRINT('console.log(8)');
    const call = { toolCallId: 'own', title: 'Run a command', kind: 'execute', rawInput: { command: cmd } };
    r.steps(s, [{ ask: { toolCall: call, options: OPTIONS } }, { update: { toolCallId: 'own', status: 'completed' } }, { term: { command: cmd } }]);
    await until(() => s.pending.length === 1, 'the request');
    r.release(s.pending[0].id, { allow: true });
    await until(() => s.pending.length === 1 && r.replies(s).length === 1, 'the second run to wait');
    assert.deepEqual([s.pending[0].tool, s.pending[0].detail], ['Bash', cmd]);
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.match(r.replies(s)[1], /^term error: Declined from Agent Office/);
  } finally { await r.done(s); }
});

test('Hermes #31682 through the agent\'s own tools: the office cannot stop them, so the feed says when a declined file changed', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ ask: { toolCall: EDIT_CALL(r.root), options: OPTIONS } }, { tool: EDIT_CALL(r.root, 'a.txt', 'again') }, { update: { toolCallId: 'again', status: 'completed' } }]);
    await until(() => s.pending.length === 1, 'the edit request');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    const lines = r.tracker.feed.map((f) => f.text);
    assert.ok(lines.includes('Hermes Agent changed a.txt after you declined that edit.'), lines.join('\n'));
    assert.ok(!lines.some((l) => /without asking/.test(l)), 'one line, not two');
  } finally { await r.done(s); }
});

test('the feed says when the agent ran a command or changed a file without asking the office', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [
      { tool: { toolCallId: 'x1', title: 'git status', kind: 'execute', rawInput: { command: 'git status' } } },
      { update: { toolCallId: 'x1', status: 'completed' } },
      { tool: EDIT_CALL(r.root, 'a.txt', 'x2') }, { update: { toolCallId: 'x2', status: 'completed' } },
      { tool: { toolCallId: 'x3', title: 'Read a.txt', kind: 'read', locations: [{ path: path.join(r.root, 'a.txt') }] } }, { update: { toolCallId: 'x3', status: 'completed' } },
    ]);
    await r.idle(s);
    const lines = r.tracker.feed.map((f) => f.text);
    assert.ok(lines.includes('Hermes Agent ran a command without asking the office: git status'), lines.join('\n'));
    assert.ok(lines.includes('Hermes Agent changed a.txt without asking the office.'));
    assert.equal(lines.filter((l) => /without asking/.test(l)).length, 2, 'a read is not news');
    assert.deepEqual(s.calls.map((c) => [c.id, c.name, c.ok]), [['x1', 'Bash', true], ['x2', 'Edit', true], ['x3', 'Read', true]]);
  } finally { await r.done(s); }
});

// ---------- cancel, the agent's own time limit, resume ----------

test('interrupt sends session/cancel, answers the waiting request cancelled, and the turn reads Stopped, not an error', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ ask: { toolCall: EDIT_CALL(r.root), options: OPTIONS } }, { say: 'never said' }]);
    await until(() => s.pending.length === 1, 'the request');
    r.p.interrupt(s); r.tracker.interrupt(s); // server.mjs doControl order
    await until(() => s.status === 'idle', 'the turn to stop');
    assert.deepEqual(r.sent('session/cancel').map((m) => m.params), [{ sessionId: 'fake-sess-1' }]);
    const answer = r.log().find((m) => m.id !== undefined && m.result?.outcome);
    assert.deepEqual(answer.result, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual([s.error, s.pending.length, r.holds.size], [null, 0, 0]);
    assert.ok(!r.replies(s).includes('never said'));
    assert.equal(s.calls[0].err, 'Stopped');
    // A turn that hangs in the agent ends on the cancel too.
    r.steps(s, [{ hang: true }]);
    await until(() => s.status === 'working' && r.sent('session/prompt').length === 2, 'the hanging turn');
    r.p.interrupt(s); r.tracker.interrupt(s);
    await until(() => s.status === 'idle', 'the hanging turn to stop');
    assert.equal(s.error, null);
  } finally { await r.done(s); }
});

test('the agent gave up first: a tool result for a request that still waits frees it, and the feed says so', async () => {
  const r = rig({ kind: 'dsh' });
  const s = await started(r, r.session({ provider: 'dsh' }));
  try {
    r.steps(s, [{ giveUp: { toolCall: EDIT_CALL(r.root), options: OPTIONS, ms: 300 } }]);
    await until(() => s.pending.length === 1, 'the request');
    await r.idle(s);
    assert.deepEqual([s.pending.length, r.holds.size], [0, 0]);
    assert.ok(r.tracker.feed.some((f) => f.text === 'DeepSeek Harness moved on without your answer.'), r.tracker.feed.map((f) => f.text).join('\n'));
    assert.deepEqual(r.spawned[0].args, ['--profile', 'acp']);
  } finally { await r.done(s); }
});

test('Hermes stops waiting for an edit after 60 s: the office frees the hold then, says so, answers reject once, and that file asks first', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    const cmd = { toolCallId: 'c60', title: 'rm -rf build', kind: 'execute', rawInput: { command: 'rm -rf build' } };
    r.steps(s, [{ ask: { toolCall: cmd, options: OPTIONS } }, { ask: { toolCall: EDIT_CALL(r.root), options: OPTIONS } },
      { write: { path: path.join(r.root, 'a.txt'), content: 'after the time ran out' } }]);
    await until(() => s.pending.length === 1, 'the command request');
    assert.equal(r.timers.filter((x) => x.ms === 60_000).length, 0, 'a command approval follows Hermes\'s own setting: no fixed limit');
    r.release(s.pending[0].id, { allow: false });
    await until(() => s.pending.length === 1 && r.replies(s).length === 1, 'the edit request');
    const t = r.timers.find((x) => x.ms === 60_000);
    assert.ok(t, 'a timer for the agent\'s own limit on edits');
    t.fn();
    await until(() => s.pending.length === 1 && r.replies(s).length === 2, 'the write of that file to wait, though it is low risk');
    assert.deepEqual([s.pending[0].tool, s.pending[0].risk], ['Write', 'low']);
    assert.ok(r.tracker.feed.some((f) => f.text === 'Hermes Agent waits 60 s for an answer to an edit. It moved on without yours.'), r.tracker.feed.map((f) => f.text).join('\n'));
    assert.equal(r.replies(s)[1], 'asked: selected no', 'reject once: cancelled would say the turn was cancelled');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.equal(fs.readFileSync(path.join(r.root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  } finally { await r.done(s); }
});

test('resume: an agent with loadSession can resume, Reopen loads the past session, and its replay is not shown twice', async () => {
  const r = rig({ fake: { FAKE_ACP_LOAD: '1', FAKE_ACP_VERSION: '0.21.5' } });
  const s = r.session();
  try {
    assert.equal(r.p.canResume, false, 'unknown before the agent said it');
    await r.p.learn();
    assert.equal(r.p.canResume, true);
    assert.deepEqual(r.p.features, ['resume', 'skills', 'memory', 'fork']);
    assert.deepEqual(await r.p.readiness(), { ready: true, version: '0.21.5', needs: [] });
    const plan = createRegistry([r.p]).reopenPlan({ uid: 'old', sid: 'old-sess', provider: 'hermes', name: 'bot', cwd: r.root, replies: [] });
    assert.deepEqual([plan.fresh, plan.opts.resume], [false, 'old-sess']);
    await started(r, s, { resume: 'old-sess' });
    assert.deepEqual(r.sent('session/load').map((m) => m.params), [{ sessionId: 'old-sess', cwd: r.root, mcpServers: [] }]);
    assert.equal(r.sent('session/new').length, 0);
    assert.deepEqual([s.sid, r.replies(s)], ['old-sess', []], 'the replay is the past the office already has');
    r.say(s, 'and now?');
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['echo: and now?']);
  } finally { await r.done(s); }
});

test('resume: an agent that said loadSession at the probe but not at the session starts fresh, and the office is told before the sid', async () => {
  const fake = { FAKE_ACP_LOAD: '1' };
  const r = rig({ fake });
  const s = r.session();
  try {
    await r.p.learn();
    assert.equal(r.p.canResume, true);
    fake.FAKE_ACP_LOAD = '0'; // the agent changed between the probe and the session (an update, another config)
    await started(r, s, { resume: 'old-sess' });
    assert.deepEqual([r.sent('session/load').length, r.sent('session/new').length], [0, 1]);
    assert.deepEqual([r.freshened, s.sid], [['o1'], 'fake-sess-1']);
    assert.ok(r.tracker.feed.some((f) => f.text === 'Hermes Agent cannot load a past session now. A new session started.'));
  } finally { await r.done(s); }
});

test('learn: two at once start the agent once, and what it said is kept for a while', async () => {
  const r = rig();
  try {
    await Promise.all([r.p.learn(), r.p.learn(), r.p.readiness()]);
    await r.p.learn();
    assert.equal(r.spawned.length, 1);
    assert.equal(r.spawned[0].opts.cwd, os.tmpdir(), 'the probe runs in the temp folder, not in a session folder');
  } finally { await r.done(); }
});

test('resume: an agent without loadSession cannot resume, so Reopen starts a fresh session', async () => {
  const r = rig();
  try {
    await r.p.learn();
    assert.equal(r.p.canResume, false);
    assert.deepEqual(r.p.features, ['skills', 'memory', 'fork']);
    const plan = createRegistry([r.p]).reopenPlan({ uid: 'old', sid: 'old-sess', provider: 'hermes', name: 'bot', cwd: r.root, replies: [] });
    assert.equal(plan.fresh, true);
  } finally { await r.done(); }
});

// ---------- the process, readiness and the rest of a turn ----------

test('an agent that stops before it starts: its stderr shows, and the session ends', async () => {
  const r = rig({ fake: { FAKE_ACP_EXIT: '1' } });
  const s = r.session();
  try {
    r.p.open(s, {});
    await until(() => s.status === 'ended', 'the session to end');
    assert.deepEqual(r.replies(s), ['Hermes Agent stopped before it started: fake-acp: no config found']);
    assert.equal(r.tracker.feed.at(-1).text, 'exited (2)');
    assert.throws(() => r.p.message(s, { text: 'x' }), (e) => e.status === 409);
    const ready = await r.p.readiness();
    assert.equal(ready.ready, false);
    assert.match(ready.needs[0], /^Hermes Agent did not answer the ACP handshake: fake-acp: no config found/);
  } finally { await r.done(); }
});

test('no program: check is 409 before any worktree, open says why and ends, readiness says what to install; a script install is named', async () => {
  const r = rig({ exe: (name) => { throw new Error(`${name} was not found on PATH.`); } });
  const s = r.session();
  try {
    assert.throws(() => r.p.check({}), (e) => e.status === 409 && e.message === 'The office cannot find Hermes Agent: hermes.exe is not on the PATH. Install it, then try again.');
    r.p.open(s, {});
    assert.equal(r.spawned.length, 0, 'no bare name is ever started');
    await until(() => s.status === 'ended', 'the session to end');
    assert.match(r.replies(s)[0], /^Could not start Hermes Agent: The office cannot find Hermes Agent/);
    const ready = await r.p.readiness();
    assert.deepEqual([ready.ready, ready.needs.length], [false, 2]);
    assert.match(ready.needs[1], /hermes acp --check/);
    const shim = rig({ kind: 'dsh', exe: () => { throw new Error('dsh is installed as a script (C:\\npm\\dsh.cmd). The office needs dsh.exe.'); } });
    assert.throws(() => shim.p.check({}), (e) => e.status === 409 && /needs dsh\.exe\. It found only C:\\npm\\dsh\.cmd/.test(e.message));
    await shim.done();
  } finally { await r.done(); }
});

test('a spawn that throws: the session says why and ends, no ghost at the desk', async () => {
  const r = rig({ spawn: () => { throw new Error('spawn EINVAL'); } });
  const s = r.session();
  try {
    r.p.open(s, {});
    await until(() => s.status === 'ended', 'the session to end');
    assert.deepEqual(r.replies(s), ['Could not start Hermes Agent: spawn EINVAL']);
  } finally { await r.done(); }
});

test('check: the agent picks its own model, and runs with the office approvals only', () => {
  const r = rig();
  try {
    r.p.check({}); r.p.check({ permissionMode: 'default' });
    assert.throws(() => r.p.check({ model: 'opus' }), (e) => e.status === 400 && /own settings/.test(e.message));
    assert.throws(() => r.p.check({ permissionMode: 'acceptEdits' }), (e) => e.status === 400);
  } finally { fs.rmSync(r.base, { recursive: true, force: true }); }
});

test('close: the agent stops, nothing is reported after, and a message is refused', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ hang: true }]);
    await until(() => s.status === 'working', 'the turn');
    const feed = r.tracker.feed.length;
    await r.p.close(s);
    await new Promise((x) => setTimeout(x, 200));
    assert.equal(r.tracker.feed.length, feed, 'no report after close (seam timing rule 2)');
    assert.notEqual(s.status, 'ended', 'the office ends the session, not the exit');
    assert.throws(() => r.p.message(s, { text: 'x' }), (e) => e.status === 409);
  } finally { await r.done(); }
});

test('a refusal ends the turn as an error with the reason; a plan is the session to-do list', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ plan: [{ content: 'Read the code', priority: 'high', status: 'completed' }, { content: 'Fix it', priority: 'high', status: 'in_progress' }] }, { stop: 'refusal' }]);
    await r.idle(s);
    assert.deepEqual(s.todos, [{ text: 'Read the code', status: 'completed' }, { text: 'Fix it', status: 'in_progress' }]);
    assert.equal(s.error.text, 'The agent refused to go on.');
  } finally { await r.done(s); }
});

test('a message sent during a turn waits and goes to the agent in the same turn, as the next prompt', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ tool: { toolCallId: 'r1', title: 'Read a.txt', kind: 'read', locations: [{ path: path.join(r.root, 'a.txt') }] } }, { wait: 400 },
      { update: { toolCallId: 'r1', status: 'completed' } }, { say: 'read it' }]);
    await until(() => s.calls.length === 1, 'the tool call');
    s.inbox.push({ t: 1, text: 'also check b.txt' }); // what server.mjs sendMessage queues while a session works
    await until(() => r.sent('session/prompt').length === 2, 'the queued message as the next prompt');
    assert.match(r.sent('session/prompt')[1].params.prompt[0].text, /Message from the user in Agent Office:\n- also check b\.txt/);
    await r.idle(s);
    assert.equal(s.turns, 1, 'one turn: the message joined it');
    assert.deepEqual(s.inbox, []);
    assert.deepEqual(r.replies(s)[0], 'read it');
    assert.match(r.replies(s)[1], /^echo: Message from the user in Agent Office/);
  } finally { await r.done(s); }
});

test('a queued message that a stopped turn could not deliver goes with the next prompt, never lost', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ tool: { toolCallId: 'r1', title: 'Read a.txt', kind: 'read' } }, { wait: 300 }, { update: { toolCallId: 'r1', status: 'completed' } }, { hang: true }]);
    await until(() => s.calls.length === 1, 'the tool call');
    s.inbox.push({ t: 1, text: 'use tabs' });
    await until(() => s.calls[0].ok === true, 'the tool result that takes the message');
    r.p.interrupt(s); r.tracker.interrupt(s);
    await until(() => s.status === 'idle', 'the stop');
    assert.equal(r.sent('session/prompt').length, 1, 'a stopped turn does not go on by itself');
    r.say(s, 'go on');
    await r.idle(s);
    const texts = r.sent('session/prompt')[1].params.prompt.map((b) => b.text);
    assert.equal(texts[0], 'go on');
    assert.match(texts[1], /use tabs/);
  } finally { await r.done(s); }
});
