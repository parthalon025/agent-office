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
import { decide, cleanRules } from '../security.mjs';
import '../public/vocab.js';

// A fake OpenClaw config: path -> value. A path that is not there is unset.
const configOf = (o) => async (p) => (p in o ? { state: 'set', value: o[p] } : { state: 'unset' });
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

// The Security room rules the rig's office applies before a hold (#70, security.mjs decide), as server.mjs does. DEFAULTS: what a
// new office has (every call row is Ask, also reads and edits inside the worktree: nothing is answered unless the user set a cell). ASK_ALL: every call row of every agent kind
// is Ask, so each request waits for the user: the tests of the hold itself run with it.
const SEC = globalThis.OfficeVocab.security;
const DEFAULTS = cleanRules(null);
// The user set Allow on reads and edits inside the worktree, for the ACP agents.
const ALLOW_INSIDE = cleanRules({ office: Object.fromEntries(['hermes', 'dsh', 'openclaw'].flatMap((c) => ['read-inside', 'edit-inside'].map((row) => [`${row}|${c}`, 'allow']))) });
const ASK_ALL = cleanRules({ office: Object.fromEntries(SEC.columns.flatMap((c) => Object.keys(SEC.rows)
  .filter((row) => !SEC.rows[row].office && SEC.applies(row, c.id) && SEC.options(row).includes('ask')).map((row) => [SEC.key(row, c.id), 'ask']))) });

// One office with one ACP provider and a fake agent. fake: the fixture's environment (FAKE_ACP_*).
// OpenClaw gets the opt-in switch on and a version that relays shell approvals, unless a test says otherwise.
function rig({ kind = 'hermes', fake = {}, rules = ASK_ALL, ...over } = {}) {
  if (kind === 'openclaw') fake = { FAKE_ACP_VERSION: '2026.10.10', ...fake };
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-acp-')));
  const root = path.join(base, 'work'), outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  const logFile = path.join(base, 'agent-log.jsonl');
  const r = { base, root, outside, logFile, holds: new Map(), spawned: [], timers: [], t: 1_000_000 };
  r.rules = rules;
  // The session runs in a worktree the office made (an ACP agent's room), so the inside rows apply.
  const screen = (s, p, opts) => decide(r.rules, { building: null, kind: s.provider, tool: p.tool_name, input: p.full_input || p.tool_input, root: r.tracker.rootOf(s), worktree: true, provider: opts.provider === true, firm: opts.firm === true });
  r.tracker = createTracker({ now: () => r.t, locate: async () => null, releaseHold: (id, d) => r.release(id, d), setTimer: (fn) => { fn(); return 0; }, screen });
  r.release = (id, d) => {
    const h = r.holds.get(id);
    if (!h) return false;
    r.holds.delete(id); r.tracker.settle(h.uid, id); h.reply(d || {});
    return true;
  };
  r.events = providerEvents({
    tracker: r.tracker,
    // A request the rules decided (q.auto) is answered on a later tick, as server.mjs holdRequest does; nothing waits.
    hold: (q) => (q.auto ? setImmediate(() => r.p.answer(q.s, { id: q.id, suggestions: [] }, q.auto)) : r.holds.set(q.id, { uid: q.s.uid, reply: (d) => r.p.answer(q.s, { id: q.id, suggestions: q.suggestions }, d) })),
    release: (id) => r.release(id, {}),
    fresh: (s) => r.freshened.push(s.uid),
  });
  // What each held card showed the user: the tool and its input at the moment of the hold.
  r.shown = [];
  r.freshened = [];
  const permission = r.events.permission;
  r.events.permission = (s, p, opts) => { r.shown.push({ tool: p.tool_name, input: { ...p.tool_input } }); return permission(s, p, opts); };
  r.p = createAcp({
    events: r.events, kind,
    exe: (name) => `C:/bin/${name}.exe`,
    ...(kind === 'openclaw' ? { gatewayUp: async () => true, readConfig: configOf({ 'tools.fs.workspaceOnly': true, 'tools.exec.ask': 'always' }) } : {}),
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
    // Review M1 (acp_adapter/edit_approval.py, tools/approval.py DANGEROUS_PATTERNS, read 2026-11-05): every edit asks in its
    // default mode, and a command asks only when it matches a danger pattern; the office holds every such request.
    assert.deepEqual([r.p.gated, isGated(r.p), supervisionOf(r.p)], [false, false, 'Partly supervised: file edits and risky commands ask']);
    assert.match(r.p.partly.shell, /rates dangerous come to the office/, 'the shell row is partly enforced, not "Not enforced"');
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

test('fs: a read and a write inside the worktree run at once when the user set Allow; the text comes back raw', async () => {
  const r = rig({ rules: ALLOW_INSIDE });
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ read: { path: path.join(r.root, 'a.txt') } }, { read: { path: path.join(r.root, 'a.txt'), line: 2, limit: 1 } }, { write: { path: path.join(r.root, 'new', 'b.txt'), content: 'bee' } }]);
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['read: one\ntwo\n', 'read: two', 'write: ok']);
    assert.equal(fs.readFileSync(path.join(r.root, 'new', 'b.txt'), 'utf8'), 'bee');
    assert.equal(r.holds.size, 0);
  } finally { await r.done(s); }
});

test('fs: with the default cells a read inside the worktree waits for the user (nothing is answered unless the user set a cell)', async () => {
  const r = rig({ rules: DEFAULTS });
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ read: { path: path.join(r.root, 'a.txt') } }]);
    await until(() => s.pending.length === 1, 'the read to wait');
    assert.equal(s.pending[0].tool, 'Read');
    r.release(s.pending[0].id, { allow: true });
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['read: one\ntwo\n']);
  } finally { await r.done(s); }
});

// Every call the office serves for the agent goes to the Security room first (#70), like a local agent's: no second copy of
// the rules in the provider. A Deny refuses with the reason; a tightened row holds what the default lets run.
test('fs: the Security room decides each served call: Deny on reads refuses with the reason, Ask on edits holds a write', async () => {
  const deny = cleanRules({ office: { 'read-inside|hermes': 'deny', 'edit-inside|hermes': 'ask' } });
  const r = rig({ rules: deny });
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ read: { path: path.join(r.root, 'a.txt') } }, { write: { path: path.join(r.root, 'a.txt'), content: 'x' } }]);
    await until(() => s.pending.length === 1, 'the write to wait');
    assert.equal(s.pending[0].tool, 'Write');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['read error: Denied by the Security room: Read inside the worktree.', 'write error: Declined from Agent Office.']);
    assert.equal(fs.readFileSync(path.join(r.root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  } finally { await r.done(s); }
});

test('a request the agent raises is answered by an Allow rule at once (allow once), and a Deny rule rejects it', async () => {
  const r = rig({ rules: cleanRules({ office: { 'shell|hermes': 'deny', 'edit-inside|hermes': 'allow' } }) });
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ ask: { toolCall: EDIT_CALL(r.root), options: OPTIONS } },
      { ask: { toolCall: { toolCallId: 'tc9', title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } }, options: OPTIONS } }]);
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['asked: selected once', 'asked: selected no'], 'the user set the edit inside to Allow; the command is denied');
    assert.equal(r.holds.size, 0, 'nothing waited');
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
    // The next turn starts fresh: the decline was for that edit in that turn. The write goes to the office like any other
    // (every row is Ask here), and no refusal comes first.
    r.steps(s, [{ write: { path: file, content: 'next turn' } }]);
    await until(() => s.pending.length === 1, 'the next write to ask');
    r.release(s.pending[0].id, { allow: true });
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

test('fs: after a declined edit that names no file, every write in that turn asks first, also where the rules allow edits', async () => {
  const r = rig({ rules: DEFAULTS });
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
    assert.deepEqual(r.p.features, ['resume', 'skills', 'memory']);
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
    assert.deepEqual(r.p.features, ['skills', 'memory']);
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
    // resolveExe's code and file, whatever its message says (git.mjs).
    const shim = rig({ kind: 'dsh', exe: () => { throw Object.assign(new Error('reworded'), { code: 'SCRIPT_INSTALL', file: 'C:\\npm\\dsh.cmd' }); } });
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

// ---------- adapter features (#72) ----------
test('reason: an agent kind that declares it shows the reason the agent gives with its request; one that does not, does not', async () => {
  const r = rig({ kind: 'dsh' });
  const s = await started(r, r.session({ provider: 'dsh' }));
  try {
    assert.ok(r.p.features.includes('reason'));
    const ask = { toolCall: EDIT_CALL(r.root), options: OPTIONS };
    r.steps(s, [{ ask: { ...ask, _meta: { reason: 'The test failed. I need to fix a.txt.' } } }, { ask: { ...ask, toolCall: EDIT_CALL(r.root, 'b.txt', 'tc2') } }]);
    await until(() => s.pending.length === 1, 'the first request');
    assert.equal(s.pending[0].reason, 'The test failed. I need to fix a.txt.');
    r.release(s.pending[0].id, { allow: true });
    await until(() => s.pending.length === 1 && r.replies(s).length === 1, 'the second request');
    assert.equal(s.pending[0].reason, null, 'no reason given: none shown');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
  } finally { await r.done(s); }
  // Hermes does not declare reasons: whatever it puts there is not shown as the agent's reason.
  const h = rig();
  const t = await started(h, h.session());
  try {
    assert.ok(!h.p.features.includes('reason'));
    h.steps(t, [{ ask: { toolCall: EDIT_CALL(h.root), options: OPTIONS, _meta: { reason: 'x' } } }]);
    await until(() => t.pending.length === 1, 'the request');
    assert.equal(t.pending[0].reason, null);
    h.release(t.pending[0].id, { allow: false });
    await h.idle(t);
  } finally { await h.done(t); }
});

test('tokens: the usage an agent reports at the end of a turn is counted once per turn; an agent that reports none shows none', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ say: 'ok' }, { usage: { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 800 } }]);
    await r.idle(s);
    assert.deepEqual(s.usage, { tokens: 1500, cached: 800, input: 1200 });
    r.steps(s, [{ say: 'again' }, { usage: { inputTokens: 100, outputTokens: 50 } }]);
    await until(() => s.turns === 2 && s.status === 'idle', 'the second turn');
    assert.equal(s.usage.tokens, 1650, 'turns add up');
    r.say(s, 'no usage here');
    await until(() => s.turns === 3 && s.status === 'idle', 'the third turn');
    assert.equal(s.usage.tokens, 1650);
    assert.equal(s.cost, null, 'the cost stays unknown');
  } finally { await r.done(s); }
});

test('tokens: an agent that reports only a total counts it as input', async () => {
  const r = rig();
  const s = await started(r, r.session());
  try {
    r.steps(s, [{ usage: { totalTokens: 900 } }]);
    await r.idle(s);
    assert.equal(s.usage.tokens, 900);
  } finally { await r.done(s); }
});

test('fork: an agent with fork opens a copy of a past session in the new folder; the replay is not shown again', async () => {
  const r = rig({ fake: { FAKE_ACP_FORK: '1' } });
  const s = r.session();
  try {
    await r.p.learn();
    assert.ok(r.p.features.includes('fork'));
    await started(r, s, { fork: 'old-sess' });
    assert.deepEqual(r.sent('session/fork').map((m) => m.params), [{ sessionId: 'old-sess', cwd: r.root, mcpServers: [] }]);
    assert.equal(r.sent('session/new').length + r.sent('session/load').length, 0);
    assert.deepEqual([s.sid, r.replies(s)], ['fake-fork-1', []]);
    r.say(s, 'and now?');
    await r.idle(s);
    assert.deepEqual(r.sent('session/prompt').map((m) => m.params.sessionId), ['fake-fork-1']);
  } finally { await r.done(s); }
});

test('fork: dsh lists no fork, so it declares none; an agent that says fork at its handshake gets it', async () => {
  assert.ok(!rig({ kind: 'dsh' }).p.features.includes('fork'));
  const r = rig({ kind: 'dsh', fake: { FAKE_ACP_FORK: '1' } });
  try {
    await r.p.learn();
    assert.ok(r.p.features.includes('fork'));
    assert.equal(r.p.features.filter((f) => f === 'fork').length, 1);
  } finally { await r.done(); }
});

test('skills: Hermes keeps its skills in HERMES_HOME/skills, else in ~/.hermes/skills; dsh has none the office shows', () => {
  const home = path.join(os.tmpdir(), 'ao-home');
  const a = rig({ env: { HERMES_HOME: path.join(os.tmpdir(), 'hh') }, homedir: () => home });
  const b = rig({ env: {}, homedir: () => home });
  const d = rig({ kind: 'dsh' });
  try {
    assert.equal(a.p.skillsDir(), path.join(os.tmpdir(), 'hh', 'skills'));
    assert.equal(b.p.skillsDir(), path.join(home, '.hermes', 'skills'));
    assert.equal(d.p.skillsDir(), null);
  } finally { fs.rmSync(a.base, { recursive: true, force: true }); fs.rmSync(b.base, { recursive: true, force: true }); fs.rmSync(d.base, { recursive: true, force: true }); }
});

test('fork: Hermes declares fork only when its handshake says session/fork, so a build without it never shows Fork', async () => {
  const none = rig();
  try {
    assert.ok(!none.p.features.includes('fork'), 'before the handshake');
    await none.p.learn();
    assert.ok(!none.p.features.includes('fork'), 'a build without session/fork');
  } finally { await none.done(); }
  const some = rig({ fake: { FAKE_ACP_FORK: '1' } });
  try {
    await some.p.learn();
    assert.deepEqual(some.p.features, ['skills', 'memory', 'fork']);
  } finally { await some.done(); }
});

// ---------- OpenClaw (#73): an OpenClaw-shaped fake agent behind a Gateway the office never starts ----------
// OpenClaw's `openclaw acp` is a bridge to a Gateway on loopback. It relays shell approvals as session/request_permission and
// reports file edits only after the fact. The Gateway check and the config reader are injected; the agent is the same fake.

const EXEC = (id = 'e1', command = 'git status') => ({ toolCallId: id, title: command, kind: 'execute', rawInput: { command } });
const LABEL = 'Partly supervised: commands ask, file edits do not';

test('openclaw: an ungated kind with its label, its own program, and the one Security row its config takes', () => {
  const r = rig({ kind: 'openclaw' });
  try {
    assert.doesNotThrow(() => checkProvider(r.p));
    assert.deepEqual([r.p.kind, r.p.label, r.p.gated, isGated(r.p), supervisionOf(r.p), isPaid(r.p), r.p.cost], ['openclaw', 'OpenClaw', false, false, LABEL, true, 'unknown']);
    assert.deepEqual([AGENTS.openclaw.program, AGENTS.openclaw.args], ['openclaw', ['acp']]);
    assert.deepEqual(r.p.enforces, ['shell'], 'exec approval is the one row whose Ask, Allow and Deny config carries');
  } finally { fs.rmSync(r.base, { recursive: true, force: true }); }
});

test('openclaw readiness: no Gateway is "Not ready: start the OpenClaw Gateway", and the office starts nothing', async () => {
  const asked = [];
  const r = rig({ kind: 'openclaw', gatewayUp: async (port) => { asked.push(port); return false; } });
  try {
    const ready = await r.p.readiness();
    assert.equal(ready.ready, false);
    assert.equal(ready.needs[0], 'Not ready: start the OpenClaw Gateway. It should listen on 127.0.0.1:18789. The office never starts or stops it.');
    assert.deepEqual(asked, [18789]);
    assert.equal(r.spawned.length, 0, 'not even the bridge starts without a Gateway');
  } finally { fs.rmSync(r.base, { recursive: true, force: true }); }
});

test('openclaw readiness: a Gateway on another loopback port (OFFICE_OPENCLAW_PORT) is checked there and the bridge gets that URL', async () => {
  const asked = [];
  const r = rig({ kind: 'openclaw', env: { ...process.env, OFFICE_OPENCLAW_PORT: '19001' }, fake: { FAKE_ACP_VERSION: '2026.10.10' }, gatewayUp: async (port) => { asked.push(port); return true; } });
  const s = r.session();
  try {
    assert.equal((await r.p.readiness()).ready, true);
    assert.ok(asked.length >= 1 && asked.every((p) => p === 19001), String(asked));
    assert.deepEqual(r.spawned[0].args, ['acp', '--url', 'ws://127.0.0.1:19001']);
    await started(r, s);
    assert.deepEqual(r.spawned.at(-1).args, ['acp', '--url', 'ws://127.0.0.1:19001']);
  } finally { await r.done(s); }
});

test('openclaw readiness: ready on 2026.10.10 with the config on; an older or unnamed version is not ready (no shell approvals)', async () => {
  const good = rig({ kind: 'openclaw' });
  const old = rig({ kind: 'openclaw', fake: { FAKE_ACP_VERSION: '2026.9.30' } });
  const unnamed = rig({ kind: 'openclaw', fake: { FAKE_ACP_VERSION: 'dev' } });
  try {
    assert.deepEqual(await good.p.readiness(), { ready: true, version: '2026.10.10', needs: [] });
    const o = await old.p.readiness();
    assert.deepEqual([o.ready, o.version], [false, '2026.9.30']);
    assert.match(o.needs[0], /OpenClaw 2026\.9\.30 is older than 2026\.10\.10, or does not say its version\. Before 2026\.10\.10 it does not send shell approvals to the office, so commands would run without asking\./);
    const u = await unnamed.p.readiness();
    assert.deepEqual([u.ready, u.version], [false, 'dev']);
    assert.match(u.needs[0], /OpenClaw dev is older than/);
  } finally { for (const x of [good, old, unnamed]) fs.rmSync(x.base, { recursive: true, force: true }); }
});

// Owner decision 3, default B (review): exec approval that is off or unreadable is not ready either. A session never runs
// with commands that skip the office, so the label "commands ask" is always true.
const EXEC_OFF = 'tools.exec.ask is "off", so shell commands run without asking the office. Run: openclaw config set tools.exec.ask always The office does not change the OpenClaw config. Fix it, then open the session again.';
test('openclaw readiness: workspace-only or exec approval off or unreadable is not ready, with the command that turns it on', async () => {
  const noWs = rig({ kind: 'openclaw', readConfig: configOf({}) });
  const lost = rig({ kind: 'openclaw', readConfig: async () => ({ state: 'unreadable', why: 'it stopped' }) });
  const noExec = rig({ kind: 'openclaw', readConfig: configOf({ 'tools.fs.workspaceOnly': true }) });
  try {
    const f = await noWs.p.readiness();
    assert.equal(f.ready, false, 'file tools that reach outside the worktree: the office does not open it');
    assert.ok(f.needs.some((n) => /tools\.fs\.workspaceOnly is unset/.test(n) && /openclaw config set tools\.fs\.workspaceOnly true/.test(n)), f.needs.join('\n'));
    assert.ok(f.needs.some((n) => /tools\.exec\.ask is unset/.test(n) && /openclaw config set tools\.exec\.ask always/.test(n)));
    const l = await lost.p.readiness();
    assert.equal(l.ready, false, 'a setting the office cannot read is never a pass');
    assert.ok(l.needs.some((n) => /could not read tools\.fs\.workspaceOnly, so it cannot confirm it/.test(n)), l.needs.join('\n'));
    const e = await noExec.p.readiness();
    assert.equal(e.ready, false, 'commands that run without asking: the office does not open it');
    assert.ok(e.needs.some((n) => /tools\.exec\.ask is unset/.test(n) && /openclaw config set tools\.exec\.ask always/.test(n)), e.needs.join('\n'));
    assert.ok(!e.needs.some((n) => /Unsupervised/.test(n)), 'no session opens as Unsupervised');
  } finally { for (const x of [noWs, lost, noExec]) fs.rmSync(x.base, { recursive: true, force: true }); }
});

// The server asks preflight() before the cost question (it names the label "commands ask"), so the question never comes
// for a session that would not start: null when it may start, else why not.
test('openclaw preflight: the gate check before the cost question; null when the config carries workspace-only and exec approval', async () => {
  const ok = rig({ kind: 'openclaw' });
  const off = rig({ kind: 'openclaw', readConfig: configOf({ 'tools.fs.workspaceOnly': true, 'tools.exec.ask': 'off' }) });
  const ws = rig({ kind: 'openclaw', readConfig: configOf({ 'tools.exec.ask': 'always' }) });
  const h = rig();
  try {
    assert.equal(await ok.p.preflight(), null);
    assert.equal(await off.p.preflight(), EXEC_OFF);
    assert.match(await ws.p.preflight(), /^tools\.fs\.workspaceOnly is unset/);
    assert.equal(await h.p.preflight(), null, 'Hermes has no Gateway config to check');
  } finally { for (const x of [ok, off, ws, h]) fs.rmSync(x.base, { recursive: true, force: true }); }
});

// The office's Security room says whether an agent kind may run now (security.mjs openRefusal: the Agents screen switch of an
// ungated kind, a no-cost Deny); the server gives the provider that answer as deps.blocked. There is no switch of its own.
test('openclaw is off until the user turns it on in the Security room: then it is not ready, reads no config, and no session starts', async () => {
  let off = 'OpenClaw runs tool calls without asking the office. Turn on OpenClaw on the Agents screen of the Security room first.';
  const reads = [];
  const r = rig({ kind: 'openclaw', env: { ...process.env, OFFICE_ENABLE_OPENCLAW: '1' }, blocked: () => off, readConfig: async (p) => { reads.push(p); return { state: 'unset' }; } });
  const s = r.session();
  try {
    const ready = await r.p.readiness();
    assert.equal(ready.ready, false);
    assert.deepEqual(ready.needs, [off], 'the old environment switch turns nothing on');
    assert.equal(await r.p.policy(), null, 'no config check while it is off');
    assert.deepEqual([r.spawned.length, reads.length], [0, 0], 'not even a probe or a config read');
    r.p.open(s, {});
    await until(() => s.status === 'ended', 'the session to end');
    assert.match(r.replies(s)[0], /^OpenClaw could not start a session: OpenClaw runs tool calls without asking the office\. Turn on OpenClaw/);
    assert.equal(r.sent('initialize').length, 0);
    off = null;
    assert.notEqual(await r.p.policy(), null, 'on: the config is checked');
  } finally { await r.done(); }
});

test('openclaw: the shell command it relays is held with its text; approve sends allow once, decline sends reject once', async () => {
  const r = rig({ kind: 'openclaw' });
  const s = await started(r, r.session({ supervision: LABEL }));
  try {
    r.steps(s, [{ ask: { toolCall: EXEC('e1', 'npm test'), options: OPTIONS } }, { ask: { toolCall: EXEC('e2', 'rm -rf build'), options: OPTIONS } }]);
    await until(() => s.pending.length === 1, 'the first command');
    assert.equal(s.status, 'waiting');
    assert.deepEqual([s.pending[0].tool, s.pending[0].detail, s.pending[0].always], ['Bash', 'npm test', ''], 'no Always allow for an ACP agent');
    r.release(s.pending[0].id, { allow: true, always: true });
    await until(() => s.pending.length === 1 && r.replies(s).length === 1, 'the second command');
    r.release(s.pending[0].id, { allow: false });
    await r.idle(s);
    assert.deepEqual(r.replies(s), ['asked: selected once', 'asked: selected no']);
    assert.equal(s.supervision, LABEL);
  } finally { await r.done(s); }
});

test('openclaw: a file edit and a write arrive after the fact; the office cannot hold them and the feed says so', async () => {
  const r = rig({ kind: 'openclaw' });
  const s = await started(r, r.session({ supervision: LABEL }));
  try {
    r.steps(s, [{ tool: EDIT_CALL(r.root, 'a.txt', 'w1') }, { update: { toolCallId: 'w1', status: 'completed' } },
      { tool: { toolCallId: 'w2', title: 'Write notes.md', kind: 'edit', locations: [{ path: path.join(r.root, 'notes.md') }] } }, { update: { toolCallId: 'w2', status: 'completed' } }]);
    await r.idle(s);
    assert.equal(s.pending.length, 0, 'no request was ever made');
    assert.deepEqual(s.calls.map((c) => [c.id, c.name, c.ok]), [['w1', 'Edit', true], ['w2', 'Edit', true]]);
    const lines = r.tracker.feed.map((f) => f.text);
    assert.ok(lines.includes('OpenClaw changed a.txt without asking the office.'), lines.join('\n'));
    assert.ok(lines.includes('OpenClaw changed notes.md without asking the office.'));
  } finally { await r.done(s); }
});

test('openclaw: usage_update token totals go to the session stats; the cost stays unknown', async () => {
  const r = rig({ kind: 'openclaw' });
  const s = await started(r, r.session({ costUnknown: true }));
  try {
    r.steps(s, [{ usageUpdate: { used: 4200, size: 128000 } }, { say: 'ok' }, { usageUpdate: { used: 6100, size: 128000, cost: { amount: 0.02, currency: 'USD' } } }]);
    await r.idle(s);
    assert.deepEqual([s.usage.tokens, s.ctxTokens, s.ctxWindow], [6100, null, null], 'a session total is not the context in use');
    assert.deepEqual([s.cost, s.costUnknown], [null, true], 'a cost the agent sends is not trusted into a figure: the office shows unknown');
  } finally { await r.done(s); }
});

test('openclaw: with no Gateway a session says so and ends; nothing runs', async () => {
  const r = rig({ kind: 'openclaw', gatewayUp: async () => false });
  const s = r.session();
  try {
    r.p.open(s, {});
    await until(() => s.status === 'ended', 'the session to end');
    assert.match(r.replies(s)[0], /^OpenClaw could not start a session: Not ready: start the OpenClaw Gateway\./);
    assert.equal(r.sent('initialize').length, 0, 'the bridge never got a handshake');
  } finally { await r.done(); }
});

test('openclaw: a session start checks the config before the session exists; a good one is one start line', async () => {
  const good = rig({ kind: 'openclaw' });
  const sg = await started(good, good.session({ supervision: LABEL }));
  try {
    assert.ok(good.tracker.feed.some((f) => f.text === 'OpenClaw config: workspace-only is on and commands ask.'));
    assert.equal(sg.supervision, LABEL);
  } finally { await good.done(sg); }
});

test('openclaw: the config is read before the first prompt goes out; a late config holds the session back (no fail-open race)', async () => {
  let release;
  const late = new Promise((r) => { release = r; });
  const read = async (p) => { await late; return p === 'tools.fs.workspaceOnly' ? { state: 'set', value: true } : p === 'tools.exec.ask' ? { state: 'set', value: 'always' } : { state: 'unset' }; };
  const r = rig({ kind: 'openclaw', readConfig: read });
  const s = r.session({ supervision: LABEL });
  try {
    r.p.open(s, {});
    r.say(s, 'run the tests');
    await new Promise((x) => setTimeout(x, 400)); // time enough for the handshake and, were it not held back, the first prompt
    assert.equal(s.sid, null, 'no session while the config is unread');
    assert.deepEqual([r.sent('session/new').length, r.sent('session/prompt').length], [0, 0]);
    release();
    await r.idle(s);
    assert.equal(r.sent('session/prompt').length, 1, 'the queued prompt went out after the config was read');
    assert.equal(s.supervision, LABEL);
  } finally { release(); await r.done(s); }
});

test('openclaw: workspace-only unset ends the session with the command that turns it on; no session, no prompt', async () => {
  const r = rig({ kind: 'openclaw', readConfig: configOf({ 'tools.exec.ask': 'always' }) });
  const s = r.session({ supervision: LABEL });
  try {
    r.p.open(s, {});
    r.say(s, 'edit everything');
    await until(() => s.status === 'ended', 'the session to end');
    assert.equal(r.replies(s)[0], 'OpenClaw could not start a session: tools.fs.workspaceOnly is unset, so its file tools can reach outside the worktree. Run: openclaw config set tools.fs.workspaceOnly true The office does not change the OpenClaw config. Fix it, then open the session again.');
    assert.deepEqual([r.sent('session/new').length, r.sent('session/prompt').length], [0, 0]);
  } finally { await r.done(); }
});

test('openclaw: a config the office cannot read ends the session: workspace-only cannot be confirmed', async () => {
  const r = rig({ kind: 'openclaw', readConfig: async () => ({ state: 'unreadable', why: 'openclaw.exe stopped' }) });
  const s = r.session({ supervision: LABEL });
  try {
    r.p.open(s, {});
    await until(() => s.status === 'ended', 'the session to end');
    assert.match(r.replies(s)[0], /^OpenClaw could not start a session: the office could not read tools\.fs\.workspaceOnly, so it cannot confirm it\./);
    assert.equal(r.sent('session/new').length, 0);
  } finally { await r.done(); }
});

test('openclaw: an old or unnamed version ends the session before it starts: its commands would not ask', async () => {
  const r = rig({ kind: 'openclaw', fake: { FAKE_ACP_VERSION: '2026.9.30' } });
  const s = r.session({ supervision: LABEL });
  try {
    r.p.open(s, {});
    await until(() => s.status === 'ended', 'the session to end');
    assert.match(r.replies(s)[0], /^OpenClaw could not start a session: OpenClaw 2026\.9\.30 is older than 2026\.10\.10, or does not say its version\./);
    assert.equal(r.sent('session/new').length, 0);
  } finally { await r.done(); }
});

test('openclaw: exec approval off ends the session with the command that turns it on; no session, no prompt (decision 3 B)', async () => {
  const r = rig({ kind: 'openclaw', readConfig: configOf({ 'tools.fs.workspaceOnly': true, 'tools.exec.ask': 'off' }) });
  const s = r.session({ supervision: LABEL });
  try {
    r.p.open(s, {});
    r.say(s, 'run everything');
    await until(() => s.status === 'ended', 'the session to end');
    assert.equal(r.replies(s)[0], 'OpenClaw could not start a session: ' + EXEC_OFF);
    assert.deepEqual([r.sent('session/new').length, r.sent('session/prompt').length], [0, 0]);
    assert.equal(s.supervision, LABEL, 'the label is never changed: no session ran');
  } finally { await r.done(); }
});

test('openclaw: exec approval the office cannot read is not "commands ask": the session does not start, and says why', async () => {
  const read = async (p) => (p === 'tools.fs.workspaceOnly' ? { state: 'set', value: true } : { state: 'unreadable', why: 'it stopped' });
  const r = rig({ kind: 'openclaw', readConfig: read });
  const s = r.session({ supervision: LABEL });
  try {
    r.p.open(s, {});
    await until(() => s.status === 'ended', 'the session to end');
    assert.match(r.replies(s)[0], /^OpenClaw could not start a session: the office could not read whether commands ask \(tools\.exec\.ask and tools\.exec\.mode\), so it cannot confirm that they do\. To turn it on, run: openclaw config set tools\.exec\.ask always/);
    assert.equal(r.sent('session/new').length, 0);
  } finally { await r.done(); }
});

test('openclaw policy: the rules its config carries are checked; the cells it cannot carry are listed as gaps', async () => {
  const r = rig({ kind: 'openclaw', cells: () => ({ shell: 'ask', web: 'deny', mcp: 'ask', secrets: 'ask' }) });
  try {
    const p = await r.p.policy();
    assert.deepEqual(p.config.settings.map((x) => [x.path, x.ok]), [['tools.fs.workspaceOnly', true], ['tools.exec.ask', true], ['tools.deny', false]]);
    assert.deepEqual(p.config.fix, [`openclaw config set tools.deny "['group:web']" --strict-json`]);
    assert.deepEqual(p.gaps.map((g) => `${g.row}=${g.value}`), ['mcp=ask', 'secrets=ask']);
  } finally { fs.rmSync(r.base, { recursive: true, force: true }); }
});
