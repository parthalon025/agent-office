// Provider seam tests: the interface contract, the registry, a fake provider through the shared events, and the Claude Code
// provider with a fake runner (no claude process, no paid call). The recorded fixtures go through the provider path and give
// the same sessions as the direct tracker path. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTracker } from '../tracker.mjs';
import { slimPayload } from '../payload.mjs';
import { createRegistry, providerEvents, checkProvider, providerError, DEFAULT_PROVIDER, PROVIDER_METHODS, DEFAULT_SPEND_LIMIT, isPaid, isGated, supervisionOf, spendLimitFor, featuresOf } from '../providers/index.mjs';
import { createLocal } from '../providers/local.mjs';
import { createClaudeCode, claudeVersion, programPath, MODEL_RE } from '../providers/claude-code.mjs';
import { resolveExe } from '../git.mjs';

const load = (f) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8'));
const HOOKS = load('hooks.json'), STREAM = load('stream.json');
const REPO = 'C:\\work\\repo';
const tick = () => new Promise((r) => setImmediate(r));
const later = (fn) => setImmediate(fn);

// The office side of the seam in memory: a tracker, the events, and holds without sockets (as server.mjs holds them).
function office() {
  const o = { t: 1_000_000, changes: 0, holds: new Map(), ids: {}, timers: [], registry: null };
  o.tracker = createTracker({
    now: () => o.t,
    makeId: (kind) => `${kind[0]}${(o.ids[kind] = (o.ids[kind] || 0) + 1)}`,
    locate: async () => null,
    onChange: () => { o.changes++; },
    releaseHold: (id, d) => o.release(id, d),
    setTimer: (fn, ms) => { o.timers.push({ fn, ms }); return o.timers.length; },
  });
  o.release = (id, d) => {
    const h = o.holds.get(id);
    if (!h) return false;
    o.holds.delete(id); o.tracker.settle(h.uid, id); h.reply(d || {});
    return true;
  };
  o.events = providerEvents({
    tracker: o.tracker, onChange: () => { o.changes++; },
    hold: (r) => o.holds.set(r.id, { uid: r.s.uid, reply: (d) => o.registry.of(r.s).answer(r.s, { id: r.id, suggestions: r.suggestions }, d) }),
  });
  o.session = (fields = {}) => o.tracker.newSession({ uid: 'o1', officeId: 'o1', name: 'bot', cwd: REPO, headless: true, status: 'starting', ...fields });
  return o;
}
// A session as the snapshot sends it, without the process id (only the provider path has a process).
const view = (s) => { const v = JSON.parse(JSON.stringify(s)); delete v.pid; return v; };

// ---------- a fake provider: an in-office agent with one scripted turn ----------
// It reports on a later tick, as the contract asks: the office marks the turn (startTurn, interrupt) after a call returns.
function createFake(events) {
  const waiting = new Map(); // request id -> session
  const BASH = { command: 'git push origin main' };
  return {
    kind: 'fake', label: 'Fake agent', canResume: false, opened: [],
    async readiness() { return { ready: true, version: '1.0', needs: [] }; },
    async models() { return [{ id: 'fake-1', label: 'Fake 1' }]; },
    open(s, opts) {
      this.opened.push(opts);
      later(() => {
        events.hook(s, { hook_event_name: 'SessionStart', source: 'startup' });
        events.stream(s, { type: 'system', subtype: 'init', model: 'fake-1', permissionMode: 'default' });
      });
    },
    message(s, { text }) {
      later(() => {
        events.hook(s, { hook_event_name: 'UserPromptSubmit', prompt: text });
        events.hook(s, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tb' + s.turns, tool_input: BASH });
        waiting.set(events.permission(s, { tool_name: 'Bash', tool_input: BASH }), s);
      });
    },
    answer(s, request, d) {
      if (!waiting.delete(request.id)) return;
      const id = 'tb' + s.turns;
      later(() => {
        if (d.allow === true) events.hook(s, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: BASH, duration_ms: 12 });
        else { events.hook(s, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: id, tool_input: BASH, is_interrupt: true }); return; }
        events.stream(s, { type: 'assistant', message: { id: 'm' + s.turns, content: [{ type: 'text', text: 'Pushed.' }], usage: { input_tokens: 30, output_tokens: 4 } } });
        events.hook(s, { hook_event_name: 'Stop' });
        events.stream(s, { type: 'result', subtype: 'success', total_cost_usd: 0 });
      });
    },
    interrupt(s) { later(() => events.stream(s, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] })); },
    close(s) { events.end(s, 'closed by the fake'); return Promise.resolve(); },
  };
}

// ---------- the contract ----------
test('the interface: seven methods, a kind and a label; check is optional', () => {
  assert.deepEqual(PROVIDER_METHODS, ['readiness', 'models', 'open', 'message', 'answer', 'interrupt', 'close']);
  const o = office();
  const claude = createClaudeCode({ events: o.events, files: () => ({}) });
  assert.equal(checkProvider(claude), claude);
  assert.equal(checkProvider(createFake(o.events)).kind, 'fake');
  assert.throws(() => checkProvider({ kind: 'x', open() {} }), /The provider x lacks: label, readiness\(\), models\(\), message\(\), answer\(\), interrupt\(\), close\(\)\./);
  assert.throws(() => checkProvider({ ...createFake(o.events), kind: 'Bad Kind' }), /lower-case/);
  assert.throws(() => checkProvider({ ...createFake(o.events), check: 'no' }), /check\(\)/);
  assert.throws(() => checkProvider(null), /object/);
});

test('the registry: one provider per kind, Claude Code by default, a session finds its provider', () => {
  const o = office();
  const claude = createClaudeCode({ events: o.events, files: () => ({}) });
  const fake = createFake(o.events);
  const reg = createRegistry([claude, fake]);
  assert.equal(DEFAULT_PROVIDER, 'claude-code');
  assert.equal(reg.get(), claude);
  assert.equal(reg.get(''), claude);
  assert.equal(reg.get('fake'), fake);
  assert.deepEqual(reg.list().map((p) => p.kind), ['claude-code', 'fake']);
  assert.throws(() => reg.get('nope'), (e) => e.status === 400 && e.message === 'Unknown agent kind.');
  o.tracker.onHook(slimPayload(HOOKS.turnWithEdit[0]));
  const fromHook = [...o.tracker.sessions.values()][0];
  assert.equal(reg.of(fromHook), claude, 'a session seen first in a hook is Claude Code');
  assert.equal(reg.of({ provider: 'fake' }), fake);
  assert.throws(() => createRegistry([claude, claude]), /Two providers have the kind claude-code/);
  assert.equal(providerError(418, 'x').status, 418);
});

test('status: readiness and models of each provider; a failing or silent one is not ready, with the reason', async () => {
  const o = office();
  const fake = createFake(o.events);
  let asked = 0;
  const broken = { ...createFake(o.events), kind: 'broken', label: 'Broken', readiness: async () => { throw new Error('boom'); }, models: async () => { asked++; return []; } };
  const silent = { ...createFake(o.events), kind: 'silent', label: 'Silent', readiness: () => new Promise(() => {}) };
  const off = { ...createFake(o.events), kind: 'off', label: 'Off', readiness: async () => ({ ready: false, version: null, needs: ['Start the server.'] }), models: async () => { asked++; return [{ id: 'x' }]; } };
  const out = await createRegistry([fake, broken, silent, off]).status({ timeoutMs: 30 });
  // Each entry starts with what kinds() says of the provider (the Open dialog's options), then its readiness, then what
  // a provider says after readiness (canResume, features: an ACP agent learns them at its handshake).
  const plain = { paid: true, terminal: false, modes: [], needsModel: false, control: false, gated: true, supervision: null, cost: 'reported', team: false };
  // configured comes with readiness: false only for a kind the user has not set up yet (a cloud kind, #24).
  const after = { configured: true, canResume: false, features: [] };
  assert.deepEqual(out, [
    { kind: 'fake', label: 'Fake agent', ...plain, ready: true, version: '1.0', needs: [], models: [{ id: 'fake-1', label: 'Fake 1' }], ...after },
    { kind: 'broken', label: 'Broken', ...plain, ready: false, version: null, needs: ['The office could not check Broken: boom'], models: [], ...after },
    { kind: 'silent', label: 'Silent', ...plain, ready: false, version: null, needs: ['The office could not check Silent: No answer in time.'], models: [], ...after },
    { kind: 'off', label: 'Off', ...plain, ready: false, version: null, needs: ['Start the server.'], models: [], ...after },
  ]);
  assert.equal(asked, 0, 'models are asked only of a ready provider');
});

// The page shows the options of each agent kind from these facts, so it keeps no copy of a provider's rules (#20).
test('kinds: each provider\'s options for the Open dialog, from the provider itself, with no readiness call', () => {
  const o = office();
  let calls = 0;
  const count = (p) => ({ ...p, readiness: async () => { calls++; return { ready: true }; }, models: async () => { calls++; return []; } });
  const claude = count(createClaudeCode({ events: o.events, files: () => ({}) }));
  const ollama = count(createLocal({ events: o.events, kind: 'ollama' }));
  const lmstudio = count(createLocal({ events: o.events, kind: 'lmstudio' }));
  const reg = createRegistry([claude, ollama, lmstudio, createFake(o.events)]);
  assert.deepEqual(reg.kinds(), [
    // Claude Code: paid (a spend limit), a terminal window, permission modes, a default model, and live changes (control)
    { kind: 'claude-code', label: 'Claude Code', paid: true, terminal: true, modes: ['default', 'acceptEdits', 'plan'], needsModel: false, control: true, gated: true, supervision: null, cost: 'reported', team: false },
    // a local model: free, in the office only, no permission modes, a model to pick, no live changes
    { kind: 'ollama', label: 'Ollama', paid: false, terminal: false, modes: [], needsModel: true, control: false, gated: true, supervision: null, cost: 'reported', team: false },
    { kind: 'lmstudio', label: 'LM Studio', paid: false, terminal: false, modes: [], needsModel: true, control: false, gated: true, supervision: null, cost: 'reported', team: false },
    // a provider that says nothing is paid, has no window, no modes, needs no model and takes no control request
    { kind: 'fake', label: 'Fake agent', paid: true, terminal: false, modes: [], needsModel: false, control: false, gated: true, supervision: null, cost: 'reported', team: false },
  ]);
  assert.equal(calls, 0, 'kinds() asks no provider anything: the snapshot sends it');
  const k = reg.kinds();
  k[0].modes.push('x');
  assert.deepEqual(reg.kinds()[0].modes, ['default', 'acceptEdits', 'plan'], 'a copy: a caller cannot change a provider');
  assert.throws(() => checkProvider({ ...createFake(o.events), modes: 'plan' }), /modes \(optional, but then a list of mode names\)/);
  assert.throws(() => checkProvider({ ...createFake(o.events), modes: [1] }), /modes/);
  assert.throws(() => checkProvider({ ...createFake(o.events), needsModel: 'yes' }), /needsModel \(optional, but then true or false\)/);
  assert.throws(() => checkProvider({ ...createFake(o.events), control: true }), /control\(\) \(optional, but then a function\)/);
  assert.throws(() => checkProvider({ ...createFake(o.events), openWindow: 'yes' }), /openWindow\(\)/);
});

// ---------- a provider other than Claude Code drives every tracker input ----------
test('a fake provider: open, message, a request the office holds, answer, reply, usage, interrupt, close', async () => {
  const o = office();
  const fake = createFake(o.events);
  o.registry = createRegistry([createClaudeCode({ events: o.events, files: () => ({}) }), fake]);
  // what server.mjs openHeadless does
  const s = o.session({ provider: 'fake' });
  fake.open(s, { model: 'fake-1' });
  await tick();
  assert.deepEqual([s.status, s.model, s.mode, s.sid], ['idle', 'fake-1', 'default', 'o1'], 'a provider session gets its id from the office');
  assert.deepEqual(fake.opened, [{ model: 'fake-1' }]);
  // what server.mjs sendMessage does for an office session at rest
  fake.message(s, { text: 'Push it' });
  o.tracker.userMessage(s); o.tracker.startTurn(s, 'Push it');
  assert.equal(s.status, 'working');
  await tick();
  assert.equal(s.turns, 1);
  assert.deepEqual(s.tool, { name: 'Bash', detail: 'git push origin main' });
  assert.equal(s.status, 'waiting');
  assert.equal(s.pending.length, 1);
  assert.deepEqual([s.pending[0].risk, s.pending[0].tool], ['high', 'Bash'], 'the shared risk rule rates it');
  const [id] = [...o.holds.keys()];
  assert.equal(id, s.pending[0].id, 'the office holds the request the provider raised');
  // the user approves: the hold ends, the provider gets the decision
  o.release(id, { allow: true, always: false });
  assert.equal(s.status, 'working');
  await tick();
  assert.deepEqual([s.calls[0].ok, s.calls[0].ms], [true, 12]);
  assert.deepEqual(s.replies.map((r) => r.text), ['Pushed.']);
  assert.deepEqual(s.usage, { tokens: 34, cached: 0, input: 30 });
  assert.deepEqual([s.status, s.cost, s.error], ['idle', 0, null], 'zero cost is a cost');
  // a second turn, stopped while it waits: no error, the call reads Stopped
  fake.message(s, { text: 'Again' });
  o.tracker.userMessage(s); o.tracker.startTurn(s, 'Again');
  await tick();
  assert.equal(s.status, 'waiting');
  fake.interrupt(s); o.tracker.interrupt(s); // server.mjs doControl order
  assert.equal(o.holds.size, 0, 'the interrupt freed the held request');
  await tick();
  assert.deepEqual([s.status, s.error], ['idle', null]);
  assert.deepEqual([s.calls[1].ok, s.calls[1].err], [false, 'Stopped']);
  // close
  await fake.close(s);
  assert.equal(s.status, 'ended');
  assert.equal(o.tracker.feed.at(-1).text, 'closed by the fake');
  assert.ok(o.changes > 10);
});

test('hook fixtures through events.hook and events.permission give the same sessions as the HTTP hook route', () => {
  const lists = [HOOKS.turnWithEdit, HOOKS.subagent, [HOOKS.turnWithEdit[1], HOOKS.todoWrite, HOOKS.failedTool, HOOKS.interruptedTool]];
  for (const list of lists) {
    const route = office(), seam = office();
    const a = route.session(), b = seam.session();
    for (const raw of list) {
      route.tracker.onHook(slimPayload(raw, 'o1')); // server.mjs /hook/http with x-office-id o1
      seam.events.hook(b, raw);
    }
    assert.deepEqual(view(b), view(a));
    assert.deepEqual(seam.tracker.feed, route.tracker.feed);
  }
  // a permission request, then the tool result that settles it
  const route = office(), seam = office();
  seam.registry = createRegistry([createClaudeCode({ events: seam.events, files: () => ({}) })]);
  const a = route.session(), b = seam.session();
  route.tracker.onHook(slimPayload(HOOKS.turnWithEdit[1], 'o1')); seam.events.hook(b, HOOKS.turnWithEdit[1]);
  const ra = route.tracker.permissionRequest(slimPayload(HOOKS.permission, 'o1'));
  const { hook_event_name: _ev, ...req } = HOOKS.permission;
  const idb = seam.events.permission(b, req);
  assert.equal(idb, ra.id);
  assert.deepEqual(view(b), view(a));
  assert.equal(b.pending[0].always, 'Bash(git push:*)');
  const done = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_02', tool_input: { ...HOOKS.permission.tool_input } };
  route.tracker.onHook(slimPayload({ ...done, session_id: 'sid-1', cwd: REPO }, 'o1')); seam.events.hook(b, { ...done, session_id: 'sid-1' });
  assert.deepEqual(view(b), view(a));
  assert.deepEqual(b.pending, []);
});

test('events trim a provider event like the hook route: the request key keeps no file content, and the result settles it', () => {
  const o = office();
  o.registry = createRegistry([createClaudeCode({ events: o.events, files: () => ({}) })]);
  const s = o.session();
  const input = { file_path: 'C:/work/repo/a.txt', content: 'SECRET-CONTENT' };
  o.events.hook(s, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: input });
  o.events.permission(s, { tool_name: 'Write', tool_input: input });
  assert.equal(s.calls[0].detail, 'a.txt');
  assert.ok(!s.pending[0].key.includes('SECRET'), 'the call key is built from the trimmed input');
  assert.match(s.pending[0].preview, /SECRET-CONTENT/, 'the Approve card still shows the change');
  o.events.hook(s, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: input });
  assert.deepEqual(s.pending, [], 'the tool result settles its own request');
  assert.equal(o.holds.size, 0);
});

test('events.reply, events.feed and events.end report a change', () => {
  const o = office();
  const s = o.session();
  const c0 = o.changes;
  o.events.reply(s, 'Could not start.');
  o.events.feed(s, 'end', 'could not start: x');
  o.events.end(s, 'could not start');
  assert.deepEqual(s.replies.map((r) => r.text), ['Could not start.']);
  assert.deepEqual(o.tracker.feed.slice(-2).map((f) => f.text), ['could not start: x', 'could not start']);
  assert.equal(s.status, 'ended');
  assert.ok(o.changes >= c0 + 3);
});

// ---------- the Claude Code provider with a fake runner ----------
function fakeChild(pid = 4242) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.sent = [];
  c.stdin = { writable: true, write(line) { c.sent.push(JSON.parse(line)); return true; }, on() {} };
  c.unref = () => { c.unrefed = true; };
  return c;
}
const FILES = { settings: 'C:/office/office-hooks-http.json', mcp: 'C:/office/office-mcp.json', launcher: 'C:/office/launch.ps1' };
function claudeRig(over = {}) {
  const o = office();
  const r = { o, spawned: [], execs: [], n: 0 };
  r.p = createClaudeCode({
    events: o.events,
    files: () => FILES,
    spawn: (file, args, opts) => { const child = fakeChild(); r.spawned.push({ file, args, opts, child }); return child; },
    execFile: (file, args, opts, cb) => { r.execs.push({ file, args, opts }); (over.exec || ((_f, _a, done) => done(null, '', '')))(file, args, cb); },
    // resolveExe's contract: an absolute path, or it throws
    exe: over.exe || ((name) => { if ((over.missing || []).includes(name)) throw new Error(`${name} was not found on PATH.`); return `C:/bin/${name}`; }),
    env: { PATH: 'C:/bin', ...(over.env || {}) },
    makeId: () => 'c' + (++r.n),
  });
  o.registry = createRegistry([r.p]);
  r.child = () => r.spawned.at(-1).child;
  r.out = async (text, size = 0) => {
    const b = Buffer.from(text);
    if (!size) r.child().stdout.write(b);
    else for (let i = 0; i < b.length; i += size) r.child().stdout.write(b.subarray(i, i + size));
    await tick();
  };
  return r;
}

test('claude-code open: the stream-json command with the office hooks, MCP server, model, mode, resume and budget', () => {
  const r = claudeRig();
  const s = r.o.session();
  r.p.open(s, { model: 'haiku', permissionMode: 'default', resume: 'sid-0', budget: 1 });
  const { file, args, opts } = r.spawned[0];
  assert.equal(file, 'C:/bin/claude', 'an absolute path, never a bare name');
  assert.deepEqual(args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--settings', FILES.settings, '--mcp-config', FILES.mcp, '--model', 'haiku', '--permission-mode', 'default', '--resume', 'sid-0', '--max-budget-usd', '1']);
  assert.deepEqual([opts.cwd, opts.windowsHide, opts.stdio, opts.env.OFFICE_ID, opts.env.PATH], [REPO, true, ['pipe', 'pipe', 'pipe'], 'o1', 'C:/bin']);
  assert.equal(s.pid, 4242);
  const r2 = claudeRig();
  r2.p.open(r2.o.session(), {});
  assert.deepEqual(r2.spawned[0].args.slice(7), ['--settings', FILES.settings, '--mcp-config', FILES.mcp]);
});

test('claude-code: every stream fixture through stdout, in odd chunks, gives the same session as the direct tracker path', async () => {
  const order = ['init', 'messageStart', 'delta1', 'delta2', 'deltaSub', 'assistantA', 'assistantADup', 'assistantSub', 'assistantB',
    'resultOk', 'resultError', 'resultBudget', 'resultExecError', 'resultAfterInterrupt'];
  assert.deepEqual([...order, 'controlResponse'].sort(), Object.keys(STREAM).sort(), 'every fixture is used');
  const direct = office();
  const a = direct.session({ status: 'working', budget: 1 });
  const r = claudeRig();
  const b = r.o.session({ status: 'working', budget: 1 });
  r.p.open(b, {});
  const lines = order.map((k) => JSON.stringify(STREAM[k]));
  lines.splice(3, 0, '', 'not json'); // a blank line and a bad line on the way
  for (const l of lines) direct.tracker.onStream(a, l);
  await r.out(lines.join('\n') + '\n', 7);
  assert.deepEqual(view(b), view(a));
  assert.deepEqual(r.o.tracker.feed, direct.tracker.feed);
  assert.deepEqual(r.o.timers.map((t) => t.ms), direct.timers.map((t) => t.ms));
  assert.ok(b.replies.length >= 3 && b.error, 'the fixtures did reach the tracker');
});

test('claude-code: a character split across two stdout chunks stays one character', async () => {
  const r = claudeRig();
  const s = r.o.session();
  r.p.open(s, {});
  const line = JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'Grüße ✓' }] } }) + '\n';
  const b = Buffer.from(line), cut = b.indexOf(Buffer.from('ü')) + 1; // inside the two bytes of ü
  r.child().stdout.write(b.subarray(0, cut));
  r.child().stdout.write(b.subarray(cut));
  await tick();
  assert.deepEqual(s.replies.map((x) => x.text), ['Grüße ✓']);
});

test('claude-code control: the request goes on stdin; its response calls back once, and an unknown id is dropped', async () => {
  const r = claudeRig();
  const s = r.o.session();
  r.p.open(s, {});
  const got = [];
  r.p.control(s, { subtype: 'set_permission_mode', mode: 'plan' }, (x) => got.push(x));
  assert.deepEqual(r.child().sent, [{ type: 'control_request', request_id: 'c1', request: { subtype: 'set_permission_mode', mode: 'plan' } }]);
  const feed0 = r.o.tracker.feed.length;
  const resp = { ...STREAM.controlResponse, response: { ...STREAM.controlResponse.response, request_id: 'c1' } };
  await r.out(JSON.stringify(resp) + '\n' + JSON.stringify(resp) + '\n' + JSON.stringify(STREAM.controlResponse) + '\n');
  assert.deepEqual(got, [resp.response], 'once, and an unknown id is dropped');
  assert.equal(r.o.tracker.feed.length, feed0);
  assert.equal(s.replies.length, 0);
  r.p.interrupt(s);
  assert.deepEqual(r.child().sent.at(-1), { type: 'control_request', request_id: 'c2', request: { subtype: 'interrupt' } });
});

test('claude-code message: text, images and text files as blocks; other files, too much, or no process are refused', () => {
  const r = claudeRig();
  const s = r.o.session();
  r.p.open(s, {});
  r.p.message(s, { text: 'hi' });
  assert.deepEqual(r.child().sent[0], { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  r.p.message(s, { text: 'look', attachments: [{ name: 'a.png', mime: 'image/png', data: 'AAAA' }, { name: 'n.md', mime: '', data: Buffer.from('# x').toString('base64') }] });
  assert.deepEqual(r.child().sent[1].message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'Attached file n.md:\n```\n# x\n```' },
    { type: 'text', text: 'look' },
  ]);
  assert.throws(() => r.p.message(s, { text: 'x', attachments: [{ name: 'a.exe', mime: 'application/octet-stream', data: 'AAAA' }] }), (e) => e.status === 415 && /Cannot attach a\.exe/.test(e.message));
  assert.throws(() => r.p.message(s, { text: 'x', attachments: [{ name: 'big.png', mime: 'image/png', data: 'A'.repeat(9_000_001) }] }), (e) => e.status === 413);
  assert.equal(r.child().sent.length, 2, 'a refused message sends nothing');
  r.child().emit('exit', 0);
  assert.throws(() => r.p.message(s, { text: 'late' }), (e) => e.status === 409 && e.message === 'That session is not running.');
  assert.throws(() => r.p.interrupt(s), (e) => e.status === 409);
  assert.throws(() => r.p.message(r.o.session({ uid: 'o2', officeId: 'o2' }), { text: 'x' }), (e) => e.status === 409);
});

test('claude-code process end: a failed start, an early exit with its stderr, a clean exit, an exit after close', async () => {
  let r = claudeRig(); let s = r.o.session();
  r.p.open(s, {});
  r.child().emit('error', new Error('spawn C:/bin/claude ENOENT'));
  assert.deepEqual(s.replies.map((x) => x.text), ['Could not start Claude Code: spawn C:/bin/claude ENOENT']);
  assert.deepEqual([s.status, r.o.tracker.feed.at(-1).text], ['ended', 'could not start']);

  r = claudeRig(); s = r.o.session();
  r.p.open(s, {});
  r.child().stderr.write('error: unknown option --bogus\n'); await tick();
  r.child().emit('exit', 1);
  assert.deepEqual(s.replies.map((x) => x.text), ['Claude Code stopped before it started: error: unknown option --bogus']);
  assert.deepEqual([s.status, r.o.tracker.feed.at(-1).text], ['ended', 'exited (1)']);

  r = claudeRig(); s = r.o.session();
  r.p.open(s, {});
  await r.out(JSON.stringify(STREAM.init) + '\n');
  r.child().emit('exit', 0);
  assert.deepEqual([s.replies.length, s.status, r.o.tracker.feed.at(-1).text], [0, 'ended', 'finished']);

  r = claudeRig(); s = r.o.session();
  r.p.open(s, {});
  r.o.tracker.endSession(s, 'closed from the office');
  r.child().emit('exit', 1);
  assert.deepEqual([s.replies.length, r.o.tracker.feed.filter((f) => f.kind === 'end').length], [0, 1], 'nothing more after the office closed it');

  r = claudeRig({ missing: ['claude'] }); s = r.o.session();
  r.p.open(s, {});
  assert.equal(r.spawned.length, 0, 'no bare name is ever started');
  await tick();
  assert.match(s.replies[0].text, /^Could not start Claude Code: .*claude\.exe is not on the PATH/);
  assert.equal(s.status, 'ended');
});

test('claude-code close: taskkill on the process tree by full path; not found counts as closed', async () => {
  const r = claudeRig();
  const s = r.o.session({ pid: 4242 });
  await r.p.close(s);
  assert.deepEqual([r.execs[0].file, r.execs[0].args], ['C:/bin/taskkill', ['/PID', '4242', '/T', '/F']]);
  const gone = claudeRig({ exec: (_f, _a, done) => done(new Error('x'), '', 'ERROR: The process "4242" not found.') });
  await gone.p.close(gone.o.session({ pid: 4242 }));
  const denied = claudeRig({ exec: (_f, _a, done) => done(new Error('x'), '', 'ERROR: Access is denied.') });
  await assert.rejects(denied.p.close(denied.o.session({ pid: 4242 })), (e) => e.status === 500 && e.message === 'Could not close it: ERROR: Access is denied.');
  assert.throws(() => r.p.close(r.o.session({ uid: 'o2', pid: null })), (e) => e.status === 409 && /no known process/.test(e.message));
  assert.throws(() => r.p.close(r.o.session({ uid: 'o3', pid: process.pid })), (e) => e.status === 409);
  const nokill = claudeRig({ missing: ['taskkill'] });
  assert.throws(() => nokill.p.close(nokill.o.session({ pid: 1 })), (e) => e.status === 409 && /taskkill/.test(e.message));
});

test('claude-code answer: the PermissionRequest hook body for allow, always allow, deny and no decision', () => {
  const p = claudeRig().p;
  const sug = [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }] }];
  const out = (decision) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
  assert.deepEqual(p.answer(null, { id: 'p1', suggestions: sug }, { allow: true, always: false }), out({ behavior: 'allow' }));
  assert.deepEqual(p.answer(null, { id: 'p1', suggestions: sug }, { allow: true, always: true }), out({ behavior: 'allow', updatedPermissions: sug }));
  assert.deepEqual(p.answer(null, { id: 'p1', suggestions: [] }, { allow: true, always: true }), out({ behavior: 'allow' }), 'always with no rule offered');
  assert.deepEqual(p.answer(null, { id: 'p1', suggestions: sug }, { allow: false, always: true }), out({ behavior: 'deny', message: 'Declined from Agent Office.' }));
  assert.deepEqual(p.answer(null, { id: 'p1' }, {}), {}, 'no decision: Claude Code decides');
  assert.deepEqual(p.answer(null, { id: 'p1' }), {});
  // the Security room refused: Claude hears why
  assert.deepEqual(p.answer(null, { id: 'p1', suggestions: [] }, { allow: false, message: 'Denied by the Security room: Shell commands.' }),
    out({ behavior: 'deny', message: 'Denied by the Security room: Shell commands.' }));
});

test('claude-code preToolAnswer: the PreToolUse hook body that refuses a call or makes Claude Code ask (#70)', () => {
  const p = claudeRig().p;
  assert.deepEqual(p.preToolAnswer({ decision: 'deny', reason: 'Denied by the Security room: Shell commands.' }),
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Denied by the Security room: Shell commands.' } });
  assert.deepEqual(p.preToolAnswer({ decision: 'ask', reason: 'x' }).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(p.preToolAnswer(null), null);
  assert.equal(p.preToolAnswer({ decision: 'allow', reason: 'x' }), null, 'the office never allows a call before Claude Code\'s own check');
});

test('claude-code check: unknown model or mode is 400; a missing program is 409, before any worktree', () => {
  const p = claudeRig().p;
  p.check({}); p.check({ model: 'haiku', permissionMode: 'plan' }); p.check({ model: 'claude-sonnet-4-5', permissionMode: 'acceptEdits', where: 'terminal' });
  assert.throws(() => p.check({ model: 'gpt-4' }), (e) => e.status === 400 && e.message === 'Unknown model.');
  assert.throws(() => p.check({ permissionMode: 'bypassPermissions' }), (e) => e.status === 400 && e.message === 'Unknown permission mode.');
  assert.throws(() => claudeRig({ missing: ['claude'] }).p.check({}), (e) => e.status === 409 && /claude\.exe is not on the PATH/.test(e.message));
  const noPs = claudeRig({ missing: ['powershell.exe'] }).p;
  noPs.check({});
  assert.throws(() => noPs.check({ where: 'terminal' }), (e) => e.status === 409 && /powershell\.exe/.test(e.message));
});

test('claude-code readiness: installed and signed in; not installed; signed out; an API key; an older CLI', async () => {
  const exec = (auth) => (_f, a, done) => (a[0] === '--version' ? done(null, '2.1.318 (Claude Code)\n', '') : auth(done));
  assert.deepEqual(await claudeRig({ exec: exec((d) => d(null, '{"loggedIn":true}', '')) }).p.readiness(), { ready: true, version: '2.1.318 (Claude Code)', needs: [] });
  const r = claudeRig({ exec: exec((d) => d(null, '{"loggedIn":true}', '')) });
  await r.p.readiness();
  assert.deepEqual(r.execs.map((x) => [x.file, x.args]), [['C:/bin/claude', ['--version']], ['C:/bin/claude', ['auth', 'status', '--json']]]);
  assert.deepEqual(await claudeRig({ missing: ['claude'] }).p.readiness(), { ready: false, version: null, needs: ['Install Claude Code. Then run claude in a terminal and sign in.'] });
  assert.equal((await claudeRig({ exec: (_f, _a, d) => d(new Error('broken')) }).p.readiness()).ready, false);
  const out = await claudeRig({ exec: exec((d) => d(null, '{"loggedIn":false}', '')) }).p.readiness();
  assert.deepEqual(out, { ready: false, version: '2.1.318 (Claude Code)', needs: ['Sign in to Claude Code: run claude auth login in a terminal.'] });
  assert.equal((await claudeRig({ env: { ANTHROPIC_API_KEY: 'k' }, exec: exec((d) => d(null, '{"loggedIn":false}', '')) }).p.readiness()).ready, true);
  assert.equal((await claudeRig({ exec: exec((d) => d(new Error('unknown command auth'))) }).p.readiness()).ready, true, 'no auth status: the office does not block');
  const models = await claudeRig().p.models();
  assert.ok(models.some((m) => m.id === 'haiku') && models.every((m) => MODEL_RE.test(m.id) && m.label));
});

test('claude-code readiness: Bedrock, Vertex, Foundry, a token or a third-party sign-in is a usable key source (#103)', async () => {
  const exec = (auth) => (_f, a, done) => (a[0] === '--version' ? done(null, '2.1.318 (Claude Code)\n', '') : auth(done));
  const SIGNED_OUT = '{"loggedIn":false,"authMethod":"none"}';
  const ready = { ready: true, version: '2.1.318 (Claude Code)', needs: [] };
  for (const env of [
    { CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: '1' }, { CLAUDE_CODE_USE_FOUNDRY: 'true' },
    { ANTHROPIC_AUTH_TOKEN: 't' }, { ANTHROPIC_API_KEY: 'k' },
  ]) {
    const r = claudeRig({ env, exec: exec((d) => d(null, SIGNED_OUT, '')) });
    assert.deepEqual(await r.p.readiness(), ready, JSON.stringify(Object.keys(env)));
    assert.deepEqual(r.execs.map((x) => x.args), [['--version'], ['auth', 'status', '--json']], 'the status command runs once, and it is no paid call');
  }
  // A switch that is not on (Claude Code accepts only 1, true, yes, on), or an empty key, is no key source.
  for (const env of [{ CLAUDE_CODE_USE_BEDROCK: '0' }, { CLAUDE_CODE_USE_VERTEX: 'false' }, { CLAUDE_CODE_USE_FOUNDRY: '' }, { CLAUDE_CODE_USE_BEDROCK: '2' }, { CLAUDE_CODE_USE_VERTEX: 'enabled' }, { ANTHROPIC_AUTH_TOKEN: '' }]) {
    const out = await claudeRig({ env, exec: exec((d) => d(null, SIGNED_OUT, '')) }).p.readiness();
    assert.equal(out.ready, false, JSON.stringify(env));
  }
  // The status itself says a third party signs in: Claude Code knows, so the office does not block.
  const third = '{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}';
  const r = claudeRig({ exec: exec((d) => d(null, third, '')) });
  assert.deepEqual(await r.p.readiness(), ready);
  assert.equal(r.execs.filter((x) => x.args[0] === 'auth').length, 1);
  // No key source and no sign-in: Not ready, with the sign-in message.
  assert.deepEqual(await claudeRig({ exec: exec((d) => d(null, SIGNED_OUT, '')) }).p.readiness(),
    { ready: false, version: '2.1.318 (Claude Code)', needs: ['Sign in to Claude Code: run claude auth login in a terminal.'] });
  // A shape the office does not know does not block.
  for (const raw of ['{}', '[]', 'null', 'not json', '{"loggedIn":"no"}']) {
    assert.equal((await claudeRig({ exec: exec((d) => d(null, raw, '')) }).p.readiness()).ready, true, raw);
  }
});

test('claude-code openWindow: cmd.exe and PowerShell by full path, the options in the environment, the window ends the session', () => {
  const r = claudeRig();
  const s = r.o.session({ name: 'my bot!', headless: false });
  r.p.openWindow(s, { model: 'opus', prompt: 'Fix it' });
  const { file, args, opts, child } = r.spawned[0];
  assert.equal(file, 'C:/bin/cmd.exe');
  assert.deepEqual(args, ['/d', '/s', '/c', 'start "Office" /wait "C:/bin/powershell.exe" -NoLogo -NoExit -ExecutionPolicy Bypass -File "C:/office/launch.ps1"']);
  assert.deepEqual([opts.windowsVerbatimArguments, opts.cwd, opts.stdio, opts.env.OFFICE_ID, opts.env.OFFICE_TITLE], [true, REPO, 'ignore', 'o1', 'Office - my bot']);
  assert.equal(opts.env.OFFICE_CLAUDE, 'C:/bin/claude', 'launch.ps1 runs claude from this full path');
  assert.deepEqual(JSON.parse(opts.env.OFFICE_ARGS), ['--settings', FILES.settings, '--mcp-config', FILES.mcp, '--model', 'opus', 'Fix it']);
  assert.equal(child.unrefed, true);
  assert.equal(s.pid, 4242);
  child.emit('exit', 0);
  assert.deepEqual([s.status, r.o.tracker.feed.at(-1).text], ['ended', 'window closed']);
  const r2 = claudeRig();
  const s2 = r2.o.session();
  r2.p.openWindow(s2, {});
  r2.child().emit('error', new Error('denied'));
  assert.deepEqual(r2.o.tracker.feed.slice(-2).map((f) => f.text), ['could not start: denied', 'could not start']);
});

test('claude-code cli: one claude job by full path; with no claude the callback gets the error', () => {
  const r = claudeRig({ exec: (_f, _a, done) => done(null, 'listed', '') });
  let got;
  r.p.cli(['plugin', 'list', '--json'], { cwd: REPO }, (err, out) => { got = [err, out]; });
  assert.deepEqual([r.execs[0].file, r.execs[0].args, r.execs[0].opts.cwd, got], ['C:/bin/claude', ['plugin', 'list', '--json'], REPO, [null, 'listed']]);
  claudeRig({ missing: ['claude'] }).p.cli(['mcp'], {}, (err) => { got = err; });
  assert.equal(got.status, 409);
});

test('claudeVersion: the trimmed version, or unknown', () => {
  assert.equal(claudeVersion(() => '2.1.318 (Claude Code)\n', () => 'C:/bin/claude.exe'), '2.1.318 (Claude Code)');
  assert.equal(claudeVersion(() => { throw new Error('x'); }, () => 'C:/bin/claude.exe'), 'unknown');
  assert.equal(claudeVersion(() => 'never', () => { throw new Error('claude was not found on PATH.'); }), 'unknown');
});

test('programPath: a missing claude says claude.exe; another program keeps the resolver message', () => {
  assert.equal(programPath('claude', () => 'C:/bin/claude.exe'), 'C:/bin/claude.exe');
  const none = () => { throw new Error('claude was not found on PATH.'); };
  assert.throws(() => programPath('claude', none), (e) => e.status === 409 && e.message === 'The office cannot find Claude Code: claude.exe is not on the PATH. Install it, then try again.');
  assert.throws(() => programPath('taskkill', () => { throw new Error('taskkill was not found in the Windows System32 folder.'); }), (e) => e.status === 409 && /System32/.test(e.message));
});

test('only claude.cmd on PATH (an npm install): the office says it needs claude.exe and names the file it found', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-npm-')));
  try {
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');
    const env = { Path: dir, SystemRoot: process.env.SystemRoot };
    const want = `The office needs claude.exe. It found only ${shim} (an npm install). Install the native Claude Code, then try again.`;
    assert.throws(() => programPath('claude', (n) => resolveExe(n, env)), (e) => e.status === 409 && e.message === want);
    const r = claudeRig({ exe: (n) => resolveExe(n, env) });
    assert.throws(() => r.p.check({}), (e) => e.status === 409 && e.message === want, 'check refuses before a worktree or a session');
    assert.deepEqual(await r.p.readiness(), { ready: false, version: null, needs: [want] });
    assert.equal(r.execs.length, 0, 'nothing ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('claude-code close: the process exit does not end the session; the office does, as closed from the office', async () => {
  // what server.mjs closeSession does once close resolves
  const closeLikeTheOffice = (r, s) => r.p.close(s).then(() => r.o.tracker.endSession(s, 'closed from the office'));
  const ends = (r) => r.o.tracker.feed.filter((f) => f.kind === 'end').map((f) => f.text);

  // taskkill answers first, the exit comes after
  let r = claudeRig(); let s = r.o.session();
  r.p.open(s, {});
  await closeLikeTheOffice(r, s);
  r.child().emit('exit', 1);
  assert.deepEqual([ends(r), s.replies.length], [['closed from the office'], 0]);

  // the exit comes while taskkill runs
  r = claudeRig({ exec: (_f, _a, done) => { r.child().emit('exit', 1); done(null, '', ''); } }); s = r.o.session();
  r.p.open(s, {});
  await closeLikeTheOffice(r, s);
  assert.deepEqual([ends(r), s.replies.length], [['closed from the office'], 0]);

  // taskkill fails: the process still runs, so its later exit is the session's end again
  r = claudeRig({ exec: (_f, _a, done) => done(new Error('x'), '', 'ERROR: Access is denied.') }); s = r.o.session();
  r.p.open(s, {});
  await assert.rejects(closeLikeTheOffice(r, s));
  r.child().emit('exit', 1);
  assert.deepEqual(ends(r), ['exited (1)']);

  // a terminal window too
  r = claudeRig(); s = r.o.session({ headless: false });
  r.p.openWindow(s, {});
  await closeLikeTheOffice(r, s);
  r.child().emit('exit', 0);
  assert.deepEqual(ends(r), ['closed from the office']);
});

test('claude-code: when the process ends, a control request that waits fails at once', async () => {
  const r = claudeRig();
  const s = r.o.session();
  r.p.open(s, {});
  const got = [];
  r.p.control(s, { subtype: 'mcp_status' }, (x) => got.push(x));
  r.p.control(s, { subtype: 'interrupt' }); // no callback: nothing to fail
  r.child().emit('exit', 0);
  assert.deepEqual(got, [{ subtype: 'error', error: 'The session ended.' }]);
  const r2 = claudeRig();
  const s2 = r2.o.session();
  r2.p.open(s2, {});
  const got2 = [];
  r2.p.control(s2, { subtype: 'mcp_status' }, (x) => got2.push(x));
  r2.child().emit('error', new Error('broken pipe'));
  assert.deepEqual(got2, [{ subtype: 'error', error: 'The session ended.' }]);
  assert.throws(() => r2.p.message(s2, { text: 'x' }), (e) => e.status === 409, 'a failed process takes no message');
});

test('reopen: Claude Code resumes; a provider that cannot resume opens a fresh session in the same folder with the same model', () => {
  const o = office();
  const claude = createClaudeCode({ events: o.events, files: () => ({}) });
  const fake = createFake(o.events);
  const reg = createRegistry([claude, fake]);
  assert.equal(claude.canResume, true);
  const rec = { uid: 'old', sid: 'sid-7', name: 'bot', cwd: REPO, model: 'haiku', budget: 2, worktree: { root: REPO, branch: 'office/x' }, replies: [{ id: 1, text: 'hi' }], cost: 0.5, turns: 3 };
  const a = reg.reopenPlan(rec); // a record from before providers: Claude Code
  assert.equal(a.provider, claude);
  assert.deepEqual([a.fresh, a.note, a.opts.resume, a.opts.prior, a.opts.model, a.opts.cwd], [false, null, 'sid-7', rec, 'haiku', REPO]);
  const b = reg.reopenPlan({ ...rec, provider: 'fake', model: 'fake-1' });
  assert.equal(b.provider, fake);
  assert.deepEqual([b.fresh, b.opts.resume, b.opts.prior, b.opts.model, b.opts.cwd, b.opts.budget, b.opts.worktree], [true, undefined, undefined, 'fake-1', REPO, 2, rec.worktree]);
  assert.equal(b.note, 'A new session started. This agent kind cannot resume a past session.');
  assert.throws(() => reg.reopenPlan({ ...rec, provider: 'gone' }), (e) => e.status === 400);
  assert.throws(() => checkProvider({ ...fake, canResume: 'yes' }), /canResume/);
  // the fresh session runs like any new one: open with the plan's options, no conversation carried over
  const s = o.session({ provider: 'fake', model: b.opts.model });
  fake.open(s, { model: b.opts.model, resume: b.opts.resume });
  assert.deepEqual(fake.opened, [{ model: 'fake-1', resume: undefined }]);
  assert.deepEqual(s.replies, []);
});

test('a provider session keeps its launch folder as startDir; a later cwd does not move it', () => {
  const o = office();
  const s = o.session({ startDir: REPO });
  o.events.hook(s, { hook_event_name: 'PreToolUse', cwd: REPO + '\\sub', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.js' } });
  assert.deepEqual([s.cwd, s.startDir], [REPO + '\\sub', REPO]);
});

// ---------- default spend limit (#33) ----------

test('spend limit: a new paid session gets the default of $2, a local one gets none', () => {
  const claude = createClaudeCode({ events: {}, files: () => ({}) });
  const ollama = createLocal({ events: {}, kind: 'ollama' });
  const lmstudio = createLocal({ events: {}, kind: 'lmstudio' });
  assert.equal(DEFAULT_SPEND_LIMIT, 2);
  assert.equal(isPaid(claude), true);
  assert.equal(isPaid(ollama), false);
  assert.equal(isPaid(lmstudio), false);
  assert.equal(spendLimitFor({ paid: isPaid(claude), requested: undefined }), 2);
  assert.equal(spendLimitFor({ paid: isPaid(ollama), requested: undefined }), null);
  assert.equal(spendLimitFor({ paid: isPaid(lmstudio), requested: 50 }), null, 'a local provider has no limit, even when one is asked for');
});

test('spend limit: the user can change it or clear it; a bad value falls back to the default', () => {
  const paid = (requested, fallback) => spendLimitFor({ paid: true, requested, fallback });
  assert.equal(paid(5), 5);
  assert.equal(paid('0.5'), 0.5);
  assert.equal(paid(0), null, '0 clears the limit');
  assert.equal(paid(-1), null);
  assert.equal(paid(5000), 1000, 'the top of the range');
  assert.equal(paid(null), 2);
  assert.equal(paid(''), 2);
  assert.equal(paid('abc'), 2, 'not a number: the default, never no limit');
  assert.equal(paid(undefined, 7), 7, 'the default the user set in settings');
  assert.equal(paid(undefined, 0), null, 'a cleared default means no limit');
  assert.equal(paid(3, 0), 3, 'a limit asked for still counts when the default is cleared');
});

// ---------- gated, cost and features (#71) ----------

test('gated: a provider holds every tool call unless it says gated: false; gated must be true or false', () => {
  const base = { kind: 'x', label: 'X', ...Object.fromEntries(PROVIDER_METHODS.map((m) => [m, () => {}])) };
  assert.equal(isGated(base), true, 'a provider that does not say is gated');
  assert.equal(isGated({ ...base, gated: true }), true);
  assert.equal(isGated({ ...base, gated: false }), false);
  assert.throws(() => checkProvider({ ...base, gated: 'yes' }), /gated/);
  assert.equal(createClaudeCode({ events: {}, files: () => ({}) }).gated, true);
  assert.equal(createLocal({ events: {}, kind: 'ollama' }).gated, true);
});

test('supervision: an ungated provider has a label (ADR 0001), "Unsupervised" when it gives none; a gated one has none', async () => {
  const base = { kind: 'x', label: 'X', ...Object.fromEntries(PROVIDER_METHODS.map((m) => [m, () => {}])), readiness: async () => ({ ready: false, needs: [] }) };
  const partly = { ...base, kind: 'partly', gated: false, supervision: 'Partly supervised: file edits ask, commands do not' };
  assert.equal(supervisionOf(partly), 'Partly supervised: file edits ask, commands do not');
  assert.equal(supervisionOf({ ...base, gated: false }), 'Unsupervised');
  assert.equal(supervisionOf(base), null);
  assert.throws(() => checkProvider({ ...base, supervision: 'Partly supervised' }), /supervision/, 'a gated provider has no label');
  assert.throws(() => checkProvider({ ...base, gated: false, supervision: 3 }), /supervision/);
  const rows = await createRegistry([base, partly]).status({ timeoutMs: 30 });
  assert.deepEqual(rows.map((r) => [r.kind, r.gated, r.supervision]), [['x', true, null], ['partly', false, 'Partly supervised: file edits ask, commands do not']]);
});

test('cost unknown: such a provider is paid, has no spend limit the office could enforce, and cannot say it is free', () => {
  const base = { kind: 'x', label: 'X', ...Object.fromEntries(PROVIDER_METHODS.map((m) => [m, () => {}])) };
  assert.doesNotThrow(() => checkProvider({ ...base, cost: 'unknown' }));
  assert.throws(() => checkProvider({ ...base, cost: 'free' }), /cost/);
  assert.throws(() => checkProvider({ ...base, cost: 'unknown', paid: false }), /cost/);
  assert.equal(isPaid({ ...base, cost: 'unknown' }), true);
  assert.equal(spendLimitFor({ paid: true, cost: 'unknown', requested: undefined }), null, 'no limit: nothing reports what it spent');
  assert.equal(spendLimitFor({ paid: true, cost: 'unknown', requested: 5 }), null);
  assert.equal(spendLimitFor({ paid: true, requested: undefined }), 2, 'a provider that reports cost keeps the default');
});

test('features: a list of names, also from a getter', () => {
  const base = { kind: 'x', label: 'X', ...Object.fromEntries(PROVIDER_METHODS.map((m) => [m, () => {}])) };
  assert.doesNotThrow(() => checkProvider({ ...base, features: ['fork', 'skills'] }));
  assert.doesNotThrow(() => checkProvider({ ...base, get features() { return ['resume']; } }));
  assert.throws(() => checkProvider({ ...base, features: 'fork' }), /features/);
  assert.throws(() => checkProvider({ ...base, features: ['Fork It'] }), /features/);
});

test('status: each kind also says whether it is gated, paid, its cost, whether it can resume, and its features', async () => {
  const o = office();
  const fake = { ...createFake(o.events), gated: true, cost: 'unknown', get canResume() { return this.learned; }, learned: false,
    get features() { return this.learned ? ['resume', 'fork'] : ['fork']; },
    async readiness() { this.learned = true; return { ready: true, version: '2', needs: [] }; } };
  const [row] = await createRegistry([fake]).status({ timeoutMs: 30 });
  assert.deepEqual([row.gated, row.paid, row.cost, row.canResume, row.features], [true, true, 'unknown', true, ['resume', 'fork']],
    'read after readiness: what the agent told it at the handshake counts');
  const [claude] = await createRegistry([createClaudeCode({ events: o.events, files: () => ({}), exe: () => { throw new Error('none'); } })]).status({ timeoutMs: 30 });
  assert.deepEqual([claude.gated, claude.paid, claude.cost, claude.canResume, claude.features], [true, true, 'reported', true, []]);
});

test('events.fresh: a provider that could not continue a past conversation says so, and the office learns it before the sid', () => {
  const freshened = [];
  const o = office();
  const events = providerEvents({ tracker: o.tracker, fresh: (s) => freshened.push(s.uid) });
  const s = o.session();
  events.fresh(s, 'Hermes Agent cannot load a past session now. A new session started.');
  assert.deepEqual(freshened, [s.uid]);
  assert.equal(o.tracker.feed.at(-1).text, 'Hermes Agent cannot load a past session now. A new session started.');
  assert.doesNotThrow(() => providerEvents({ tracker: o.tracker }).fresh(s, 'x'), 'without the callback it only writes the feed');
});

test('events.permission: the Security room check hears that a provider asks, and whether the request is firm (the user must answer)', () => {
  const seen = [];
  const tracker = createTracker({ now: () => 1, locate: async () => null, screen: (s, p, opts) => { seen.push(opts); return null; } });
  const events = providerEvents({ tracker, hold: () => {} });
  const s = tracker.newSession({ uid: 'o1', officeId: 'o1', provider: 'hermes', name: 'a', cwd: 'C:\\w', headless: true, status: 'working' });
  events.permission(s, { tool_name: 'Write', tool_input: { file_path: 'C:\\w\\a.txt' } });
  events.permission(s, { tool_name: 'Write', tool_input: { file_path: 'C:\\w\\b.txt' } }, { firm: true });
  assert.deepEqual(seen, [{ provider: true, firm: false }, { provider: true, firm: true }]);
});

test('events.drop: the provider frees a request its agent no longer waits for, and the feed says why', () => {
  const released = [];
  const o = office();
  const events = providerEvents({ tracker: o.tracker, hold: () => {}, release: (id) => released.push(id) });
  const s = o.session();
  const id = events.permission(s, { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  events.drop(s, id, 'Hermes Agent moved on without your answer.');
  assert.deepEqual(released, [id]);
  assert.equal(o.tracker.feed.at(-1).text, 'Hermes Agent moved on without your answer.');
});

test('spend limit: a provider that does not say it is free is paid; paid must be true or false', () => {
  const base = { kind: 'x', label: 'X', ...Object.fromEntries(PROVIDER_METHODS.map((m) => [m, () => {}])) };
  assert.equal(isPaid(base), true);
  assert.equal(isPaid({ ...base, paid: false }), false);
  assert.doesNotThrow(() => checkProvider({ ...base, paid: true }));
  assert.throws(() => checkProvider({ ...base, paid: 'no' }), /paid/);
});

// ---------- the subagent rule of the contract (#69): any provider that tags hooks with agent_id gets helpers ----------
test('contract: a provider other than Claude Code reports a subagent with agent_id, and it is a helper in the parent session', () => {
  const o = office();
  const fake = createFake(o.events);
  const s = o.session({ provider: fake.kind });
  const hook = (p) => o.events.hook(s, p);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 't1', tool_input: { description: 'Look around', subagent_type: 'Explore' } });
  const parentTask = JSON.stringify(s.tool);
  hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'Explore' });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', agent_id: 'sub-1', tool_input: { file_path: 'a.js' } });
  assert.equal(o.tracker.sessions.size, 1, 'a subagent never becomes a session (no room, no desk, no count)');
  assert.deepEqual(s.agents.map((a) => [a.type, a.id, a.done]), [['Explore', 'sub-1', false]]);
  assert.equal(s.calls.find((c) => c.id === 'r1').agent, 'sub-1', 'its call is on the helper');
  assert.equal(JSON.stringify(s.tool), parentTask, 'its call is not the parent task line');
  hook({ hook_event_name: 'SubagentStop', agent_id: 'sub-1' });
  assert.equal(s.agents[0].done, true);
});

test('featuresOf: a copy of what the provider declares, read when asked (a getter), [] when it declares none (#72)', () => {
  let learned = false;
  const p = { get features() { return learned ? ['resume', 'skills'] : ['skills']; } };
  assert.deepEqual(featuresOf(p), ['skills']);
  learned = true;
  const f = featuresOf(p);
  assert.deepEqual(f, ['resume', 'skills']);
  f.push('x');
  assert.deepEqual(featuresOf(p), ['resume', 'skills']);
  assert.deepEqual(featuresOf({}), []);
  assert.deepEqual(featuresOf(null), []);
});
