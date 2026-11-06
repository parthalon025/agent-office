// GitHub Copilot CLI (#22): the copilot entry of providers/acp.mjs and its extras in providers/copilot.mjs, against a fake
// Copilot (test/fixtures/fake-copilot.mjs: a real Node process that speaks ACP with the handshake recorded from Copilot CLI
// 1.0.105 and the request bodies of its SDK schema). No Copilot, no sign-in, no model, no paid call. The office side is in
// memory, as in test/acp-provider.test.mjs: a tracker, the shared provider events and holds without sockets.
// Run: node --test test/copilot.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTracker } from '../src/tracker.mjs';
import { providerEvents, checkProvider, spendLimitFor, describe, traitsOf } from '../src/providers/index.mjs';
import { createAcp, AGENTS } from '../src/providers/acp.mjs';
import { requestCall, argsCall, SESSION_ARGS, SELF_APPROVE } from '../src/providers/copilot.mjs';
import { cleanRules, decide, openRefusal, costAsk, enforcement } from '../src/security.mjs';
import '../src/vocab.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-copilot.mjs');
const SEC = globalThis.OfficeVocab.security;
// Every call cell Ask, so each request waits for the user.
const ASK_ALL = cleanRules({ office: Object.fromEntries(Object.keys(SEC.rows).filter((row) => !SEC.rows[row].office && SEC.applies(row, 'copilot') && SEC.options(row).includes('ask')).map((row) => [SEC.key(row, 'copilot'), 'ask'])) });

async function until(fn, what, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Every folder a rig makes is removed at the end of the file, so a test that fails before its finally block leaves nothing
// in %TEMP% (#124). The test's own finally removes its folder first.
const made = new Set();
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

// One office with the Copilot provider and a fake Copilot. fake: its environment (FAKE_COPILOT*). env: the office's.
function rig({ fake = {}, env = {}, rules = ASK_ALL, ...over } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-copilot-')));
  made.add(base);
  const root = path.join(base, 'work'), probeDir = path.join(base, 'probe');
  fs.mkdirSync(root); fs.mkdirSync(probeDir);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  const logFile = path.join(base, 'copilot-log.jsonl');
  const r = { base, root, probeDir, logFile, holds: new Map(), spawned: [], rules, feed: [] };
  const screen = (s, p, opts) => decide(r.rules, { building: null, kind: s.provider, tool: p.tool_name, input: p.full_input || p.tool_input, root: r.tracker.rootOf(s), worktree: true, provider: opts.provider === true, firm: opts.firm === true });
  r.tracker = createTracker({ now: () => Date.now(), locate: async () => null, releaseHold: (id, d) => r.release(id, d), setTimer: (fn) => { fn(); return 0; }, screen });
  r.release = (id, d) => {
    const h = r.holds.get(id);
    if (!h) return false;
    r.holds.delete(id); r.tracker.settle(h.uid, id); h.reply(d || {});
    return true;
  };
  r.events = providerEvents({
    tracker: r.tracker,
    hold: (q) => (q.auto ? setImmediate(() => r.p.answer(q.s, { id: q.id, suggestions: [] }, q.auto)) : r.holds.set(q.id, { uid: q.s.uid, reply: (d) => r.p.answer(q.s, { id: q.id, suggestions: q.suggestions }, d) })),
    release: (id) => r.release(id, {}),
    fresh: () => {},
  });
  r.shown = [];
  const permission = r.events.permission, feed = r.events.feed;
  r.events.permission = (s, p, opts) => { r.shown.push({ tool: p.tool_name, input: { ...p.tool_input } }); return permission(s, p, opts); };
  r.events.feed = (s, kind, text) => { r.feed.push(text); return feed(s, kind, text); };
  r.p = createAcp({
    events: r.events, kind: 'copilot', probeDir,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    exe: (name) => `C:/bin/${name}.exe`,
    spawn: (file, args, opts) => {
      const child = realSpawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...opts.env, ...fake, FAKE_COPILOT_LOG: logFile } });
      r.spawned.push({ file, args, opts, child });
      return child;
    },
    ...over,
  });
  r.session = (fields = {}) => r.tracker.newSession({ uid: 'c1', officeId: 'c1', provider: 'copilot', name: 'bot', cwd: root, startDir: root, headless: true, status: 'starting', ...fields });
  r.log = () => { try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  r.starts = () => r.log().filter((m) => m.start);
  r.answers = () => r.log().filter((m) => m.in && m.in.method === undefined && m.in.result && m.in.result.outcome).map((m) => m.in.result.outcome);
  r.say = (s, text) => { r.p.message(s, { text }); r.tracker.userMessage(s); r.tracker.startTurn(s, text); };
  r.idle = (s) => until(() => s.status === 'idle' && s.turns > 0, 'the turn to end');
  r.held = () => until(() => r.holds.size > 0 && [...r.holds.keys()].pop(), 'a held request');
  r.answer = (id, d) => r.release(id, d);
  // Every fake Copilot has stopped before the folders go (Windows keeps the folder of a running process busy).
  r.done = async (s) => {
    if (s) await r.p.close(s);
    await until(() => r.spawned.every((x) => x.child.exitCode !== null || x.child.signalCode !== null), 'the fake Copilots to stop');
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return r;
}
async function started(r, s, opts = {}) {
  r.p.open(s, opts);
  await until(() => s.sid, 'the session to start');
  return s;
}

test('the entry: one AGENTS entry of the ACP provider, paid with an unknown cost, ungated with its label, no spend limit', () => {
  const r = rig();
  try {
    assert.ok(AGENTS.copilot, 'a new agent is a new entry, not a second ACP client');
    assert.equal(checkProvider(r.p), r.p);
    assert.deepEqual([r.p.kind, r.p.label, traitsOf(r.p).paid, traitsOf(r.p).cost, traitsOf(r.p).gated], ['copilot', 'Copilot CLI', true, 'unknown', false]);
    assert.equal(traitsOf(r.p).supervision, 'Partly supervised: edits and most commands ask, reads do not');
    // Owner decision Q22: a kind without cost reports has no spend limit field (nothing could stop it), so no --max-ai-credits.
    assert.equal(spendLimitFor({ paid: true, cost: r.p.cost, requested: 5 }), null);
    assert.ok(!SESSION_ARGS.some((a) => /credit|^--allow|yolo|autopilot/i.test(a)), 'no switch that approves calls or sets a limit');
    assert.deepEqual(describe(r.p).label, 'Copilot CLI');
    assert.equal(SEC.columnOf('copilot'), 'copilot', 'its own Security room column');
  } finally { r.done(); }
});

test('Security room: off until the user turns it on, asks about cost once per session, a Deny refuses it', () => {
  const r = rig();
  try {
    const none = cleanRules(null);
    assert.match(openRefusal(none, r.p), /Copilot CLI runs tool calls without asking the office\. Turn on Copilot on the Agents screen/);
    const on = cleanRules({ office: { 'ungated|copilot': 'on' } });
    assert.equal(openRefusal(on, r.p), null);
    assert.equal(costAsk(on, r.p), true, 'the no-cost cell is Ask by default');
    assert.equal(costAsk(cleanRules({ office: { 'ungated|copilot': 'on', 'no-cost|copilot': 'allow' } }), r.p), false);
    assert.match(openRefusal(cleanRules({ office: { 'ungated|copilot': 'on', 'no-cost|copilot': 'deny' } }), r.p), /does not report cost/);
  } finally { r.done(); }
});

test('Security room: the column says which cells Copilot carries, which it carries partly, and which not', () => {
  const r = rig();
  try {
    const e = enforcement([r.p]).copilot;
    assert.equal(e.reason, '');
    // Reads in its folder ask nothing, a secret file there neither: Not enforced, in Hermes's words (one line on the wall).
    assert.deepEqual([e.rows['read-inside'], e.rows.secrets], [AGENTS.hermes.unenforced['read-inside'], AGENTS.hermes.unenforced.secrets]);
    assert.match(e.partly.shell, /read-only.*Hooks/s);
    assert.match(e.partly.web, /allowedUrls/);
    assert.match(e.partly['files-outside'], /trustedFolders/);
    assert.match(e.partly.mcp, /read-only/);
    assert.equal(e.partly.settings, 'Writes ask. Reads in its folder do not.', 'Settings is Partly enforced: a read of a settings file in its folder asks nothing');
    // Every call row is Not enforced, Partly enforced, or carried (a write asks): none is left out.
    const carried = ['read-inside', 'edit-inside', 'files-outside', 'shell', 'web', 'mcp', 'settings', 'secrets'].filter((row) => !(row in e.rows) && !(row in e.partly));
    assert.deepEqual(carried, ['edit-inside']);
  } finally { r.done(); }
});

test('readiness: one handshake and one session in a temp folder, the version from agentInfo, the models; no --version run, the log in its own temp folder', async () => {
  const r = rig();
  try {
    const st = await r.p.readiness();
    assert.deepEqual([st.ready, st.version, st.needs], [true, '1.0.105', []]);
    assert.equal(r.spawned.length, 1);
    const args = r.spawned[0].args;
    assert.ok(!args.includes('--version'));
    assert.deepEqual(args.slice(0, 3), ['--acp', '--no-auto-update', '--disable-builtin-mcps']);
    const logDir = args[args.indexOf('--log-dir') + 1];
    assert.ok(logDir && logDir.startsWith(r.probeDir) && logDir !== r.probeDir, 'a log folder of its own under the temp folder');
    assert.equal(r.spawned[0].opts.cwd, r.probeDir);
    assert.deepEqual((await r.p.models()).map((m) => m.id), ['gpt-5.4', 'claude-sonnet-4.6']);
    await until(() => !fs.existsSync(logDir), 'the log folder to go');
    const sent = r.log().filter((m) => m.in && m.in.method).map((m) => m.in.method);
    assert.deepEqual(sent.filter((m) => m !== 'session/close'), ['initialize', 'session/new'], 'no prompt');
    assert.equal(r.p.canResume, true, 'the handshake says loadSession');
    await r.p.readiness();
    assert.equal(r.spawned.length, 1, 'a ready answer is kept');
  } finally { await r.done(); }
});

test('readiness: the signed-in recording (1.0.105): ready, one entry per model id, the check ends with session/close', async () => {
  const r = rig({ fake: { FAKE_COPILOT: 'recorded' } });
  try {
    const st = await r.p.readiness();
    assert.deepEqual([st.ready, st.version, st.needs], [true, '1.0.105', []]);
    // The recording lists the model "auto" twice (a plain entry and one with copilotUsage): the office shows it once.
    assert.deepEqual(await r.p.models(), [{ id: 'auto', label: 'Auto' }]);
    await until(() => r.log().some((m) => m.in && m.in.method === 'session/close'), 'session/close');
    const sent = r.log().filter((m) => m.in && m.in.method).map((m) => m.in.method);
    assert.deepEqual(sent, ['initialize', 'session/new', 'session/close'], 'no prompt, no session/list');
  } finally { await r.done(); }
});

test('readiness: a ready answer is kept for an hour (each check leaves an empty session folder in ~/.copilot), a failed one for 10 s', () => {
  // Copilot has no way to delete the session of a check (test/fixtures/copilot-acp-signed-in.json, leftBehind), so a ready
  // answer is asked again rarely. A later sign-out shows at the next session start, which reports the sign-in step.
  assert.equal(AGENTS.copilot.readyTtlMs, 60 * 60_000);
  assert.equal(AGENTS.copilot.notReadyTtlMs, 10_000);
});

test('readiness: signed out is the Sign in step, with the version; a -32000 that is not about sign-in is not', async () => {
  const r = rig({ fake: { FAKE_COPILOT: 'signed-out' } });
  try {
    const st = await r.p.readiness();
    assert.equal(st.ready, false);
    assert.equal(st.version, '1.0.105');
    assert.deepEqual(st.needs, ['Sign in to GitHub Copilot: run copilot login in a terminal, then check again.']);
  } finally { await r.done(); }
  const r2 = rig({ fake: { FAKE_COPILOT: 'server-error' } });
  try {
    const st = await r2.p.readiness();
    assert.equal(st.ready, false);
    assert.ok(!st.needs.some((n) => /Sign in/.test(n)), 'a quota error is not a sign-in');
    assert.match(st.needs[0], /did not open a session: Server error: the quota service did not answer/);
  } finally { await r2.done(); }
});

test('readiness: a slow start says still starting and goes on; the next answer waits for the same check (one process)', async () => {
  const r = rig({ fake: { FAKE_COPILOT_DELAY: '700' }, readyWaitMs: 150 });
  try {
    const first = await r.p.readiness();
    assert.equal(first.ready, false);
    assert.match(first.needs[0], /Copilot CLI is still starting/);
    const later = await until(async () => { const x = await r.p.readiness(); return x.ready && x; }, 'the same check to finish');
    assert.equal(later.version, '1.0.105');
    assert.equal(r.starts().length, 1, 'one Copilot started');
  } finally { await r.done(); }
});

test('readiness: a check that never answers stops at its limit and says so', async () => {
  const r = rig({ fake: { FAKE_COPILOT_DELAY: '60000' }, probeMs: 300, readyWaitMs: 5000 });
  try {
    const st = await r.p.readiness();
    assert.equal(st.ready, false);
    assert.match(st.needs[0], /did not answer the ACP handshake: no answer in time/);
  } finally { await r.done(); }
});

test('open: the session switches, the model it picked, and no switch that approves calls by itself in its environment', async () => {
  const r = rig({ env: { COPILOT_ALLOW_ALL: 'true', copilot_allow_all: '1', Copilot_Assisted_Approval: '1', KEEP_ME: 'x' } });
  const s = r.session();
  try {
    assert.throws(() => r.p.check({ model: 'bad model; rm' }), /Unknown model/);
    assert.doesNotThrow(() => r.p.check({ model: 'gpt-5.4' }));
    await started(r, s, { model: 'gpt-5.4' });
    const sp = r.spawned.at(-1);
    assert.deepEqual(sp.args, [...SESSION_ARGS, '--model', 'gpt-5.4']);
    assert.equal(sp.opts.cwd, r.root);
    const keys = Object.keys(sp.opts.env).map((k) => k.toUpperCase());
    for (const k of SELF_APPROVE) assert.ok(!keys.includes(k), k + ' is taken out');
    assert.equal(sp.opts.env.KEEP_ME, 'x');
    assert.equal(sp.opts.env.OFFICE_ID, 'c1');
    const seen = r.starts().at(-1).env;
    assert.deepEqual([seen.COPILOT_ALLOW_ALL, seen.COPILOT_ASSISTED_APPROVAL], [null, null], 'the agent saw none of them');
  } finally { await r.done(s); }
});

// A Reopen takes the model of the past record, and open() is not behind check() there: a model that is not a model id (a
// Copilot switch such as --allow-all) never reaches its command line.
test('open: a model that is not a model id is not passed, so it cannot be a switch', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s, { model: '--allow-all' });
    assert.deepEqual(r.spawned.at(-1).args, SESSION_ARGS);
  } finally { await r.done(s); }
});

test('open: signed out ends the session with the sign-in step', async () => {
  const r = rig({ fake: { FAKE_COPILOT: 'signed-out' } });
  const s = r.session();
  try {
    r.p.open(s, {});
    await until(() => s.replies.length, 'a reply');
    assert.match(s.replies[0].text, /Copilot CLI could not start a session: it is not signed in\. Sign in to GitHub Copilot: run copilot login/);
  } finally { await r.done(s); }
});

test('a shell request: the card shows the command from its request body, rated high; approve sends allow once', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'shell');
    const id = await r.held();
    assert.deepEqual(r.shown.at(-1), { tool: 'Bash', input: { command: 'git push --force' } }, 'not the title "Push the branch"');
    assert.equal(s.pending.at(-1).risk, 'high');
    r.answer(id, { allow: true });
    await r.idle(s);
    assert.deepEqual(r.answers().at(-1), { outcome: 'selected', optionId: 'allow-once' });
  } finally { await r.done(s); }
});

test('an edit request: the card names the file; Decline sends reject once; an unanswered hold (the office timeout) declines', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'edit');
    let id = await r.held();
    assert.deepEqual(r.shown.at(-1), { tool: 'Edit', input: { file_path: path.join(r.root, 'a.txt') } });
    r.answer(id, { allow: false });
    await r.idle(s);
    assert.deepEqual(r.answers().at(-1), { outcome: 'selected', optionId: 'reject-once' });
    const turns = s.turns;
    r.say(s, 'edit');
    id = await r.held();
    r.answer(id, {}); // what server.mjs does when the hold times out: no decision
    await until(() => s.status === 'idle' && s.turns > turns, 'the second turn to end');
    assert.deepEqual(r.answers().at(-1), { outcome: 'selected', optionId: 'reject-once' });
  } finally { await r.done(s); }
});

test('a request that offers only always answers: the office never sends one, so Approve declines', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'always');
    const id = await r.held();
    assert.ok(r.feed.some((l) => /offers only Always allow/.test(l)));
    r.answer(id, { allow: true });
    await r.idle(s);
    const o = r.answers().at(-1);
    assert.notEqual(o.optionId, 'aa', 'never allow_always');
    assert.notEqual(o.optionId, 'ra', 'never reject_always');
  } finally { await r.done(s); }
});

// The MCP half: once approved, the fake sends the same arguments with the keys in another order at both depths (#125). The
// shell half (later) sends them in another shape.
test('an MCP request is the MCP row; an update with the tool arguments keeps the card the user approved', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'mcp');
    let id = await r.held();
    assert.deepEqual(r.shown.at(-1), { tool: 'mcp__github__list_issues', input: { owner: 'o', repo: 'r', filter: { state: 'open', sort: 'new' } } });
    r.answer(id, { allow: true });
    await r.idle(s);
    const turns = s.turns;
    r.say(s, 'later');
    id = await r.held();
    assert.deepEqual(r.shown.at(-1), { tool: 'Bash', input: { command: 'npm test' } });
    r.answer(id, { allow: true });
    await until(() => s.status === 'idle' && s.turns > turns, 'the turn to end');
    assert.ok(!r.feed.some((l) => /changed the call/.test(l)), 'the same call in another shape is not a change: ' + r.feed.join(' | '));
    assert.deepEqual(r.answers().at(-1), { outcome: 'selected', optionId: 'allow-once' });
  } finally { await r.done(s); }
});

// #125: the card keeps the request body, but a later update with the call's own arguments is what the call does now.
test('a call whose own arguments change after the user approved it: the feed says so, with the new command', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'swap');
    const id = await r.held();
    assert.deepEqual(r.shown.at(-1), { tool: 'Bash', input: { command: 'npm test' } });
    r.answer(id, { allow: true });
    await r.idle(s);
    assert.deepEqual(r.answers().at(-1), { outcome: 'selected', optionId: 'allow-once' });
    assert.deepEqual(r.feed.filter((l) => /changed the call/.test(l)), ['Copilot CLI changed the call after you approved it: npm publish']);
  } finally { await r.done(s); }
});

test('a call whose own arguments change while its request waits: the office declines the request at once', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'swapwait');
    await r.idle(s);
    assert.deepEqual(r.shown.at(-1), { tool: 'Bash', input: { command: 'npm test' } });
    assert.deepEqual(r.answers().at(-1), { outcome: 'selected', optionId: 'reject-once' });
    assert.equal(r.holds.size, 0, 'the hold is gone');
    // The office's own decline goes out as events.drop, so it is in the tracker feed, not in the events.feed spy.
    assert.deepEqual(r.tracker.feed.map((f) => f.text).filter((t) => /changed the call/.test(t)), ['Copilot CLI changed the call while it waited for your answer, so the office declined it: npm publish']);
  } finally { await r.done(s); }
});

test('an approved edit whose own arguments name the same file another way is no change; another file is', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'swapfile');
    const id = await r.held();
    assert.deepEqual(r.shown.at(-1), { tool: 'Edit', input: { file_path: path.join(r.root, 'a.txt') } });
    r.answer(id, { allow: true });
    await r.idle(s);
    assert.deepEqual(r.feed.filter((l) => /changed the call/.test(l)), ['Copilot CLI changed the call after you approved it: b.txt']);
  } finally { await r.done(s); }
});

test('an MCP call whose arguments come back in another key order or in a wrapper while its request waits: no decline, no feed line', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'mcpwait');
    const id = await r.held();
    // The fake sends its plan after the reordered and the wrapped arguments, so these were read while the request waited.
    await until(() => s.todos.length, 'the plan after the updates');
    assert.ok(r.holds.has(id), 'the request still waits');
    r.answer(id, { allow: true });
    await r.idle(s);
    assert.deepEqual(r.answers().at(-1), { outcome: 'selected', optionId: 'allow-once' });
    const lines = [...r.feed, ...r.tracker.feed.map((f) => f.text)].filter((t) => /changed the call/.test(t));
    assert.deepEqual(lines, []);
  } finally { await r.done(s); }
});

test('an MCP call whose own arguments change after the user approved it: the feed names the tool and the changed argument', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'mcpswap');
    const id = await r.held();
    r.answer(id, { allow: true });
    await r.idle(s);
    assert.deepEqual(r.feed.filter((l) => /changed the call/.test(l)), ['Copilot CLI changed the call after you approved it: mcp__github__list_issues (owner: "x")']);
  } finally { await r.done(s); }
});

test('an MCP call whose own arguments change while its request waits: the office declines it and names the change', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'mcpswapwait');
    await r.idle(s);
    assert.deepEqual(r.answers().at(-1), { outcome: 'selected', optionId: 'reject-once' });
    assert.equal(r.holds.size, 0, 'the hold is gone');
    assert.deepEqual(r.tracker.feed.map((f) => f.text).filter((t) => /changed the call/.test(t)), ['Copilot CLI changed the call while it waited for your answer, so the office declined it: mcp__github__list_issues (owner: "x")']);
  } finally { await r.done(s); }
});

test('an approved edit whose own arguments move it to a file the user declined in the turn: the feed names that file', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'deniedswap');
    let id = await r.held();
    assert.deepEqual(r.shown.at(-1), { tool: 'Edit', input: { file_path: path.join(r.root, 'a.txt') } });
    r.answer(id, { allow: false });
    id = await until(() => r.holds.size > 0 && r.shown.length === 2 && [...r.holds.keys()].pop(), 'the second request');
    assert.deepEqual(r.shown.at(-1), { tool: 'Edit', input: { file_path: path.join(r.root, 'c.txt') } });
    r.answer(id, { allow: true });
    await r.idle(s);
    assert.deepEqual(r.feed.filter((l) => /changed/.test(l)), ['Copilot CLI changed the call after you approved it: a.txt', 'Copilot CLI changed a.txt after you declined that edit.']);
  } finally { await r.done(s); }
});

test('argsCall: a call\'s own arguments in the shape of its request card; null when they do not say', () => {
  const sh = requestCall({ kind: 'shell', fullCommandText: 'npm test' });
  assert.deepEqual(argsCall(sh, { command: 'npm publish', description: 'x' }), { tool_name: 'Bash', tool_input: { command: 'npm publish' } });
  assert.deepEqual(argsCall(sh, { command: ['npm', 'test'] }), { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(argsCall(sh, { description: 'Run the tests' }), null, 'no command: it does not say');
  const ed = requestCall({ kind: 'write', fileName: 'C:/w/a.txt' });
  assert.deepEqual(argsCall(ed, { path: 'C:/w/b.txt', old_str: 'a' }), { tool_name: 'Edit', tool_input: { file_path: 'C:/w/b.txt' } });
  assert.deepEqual(argsCall(ed, {}, 'C:/w/c.txt'), { tool_name: 'Edit', tool_input: { file_path: 'C:/w/c.txt' } }, 'the location of the update');
  assert.deepEqual(argsCall(requestCall({ kind: 'url', url: 'https://a.test' }), { url: 'https://b.test' }), { tool_name: 'WebFetch', tool_input: { url: 'https://b.test' } });
  const mcp = requestCall({ kind: 'mcp', serverName: 'github', toolName: 'list_issues', args: { owner: 'o' } });
  assert.deepEqual(argsCall(mcp, { owner: 'x' }), { tool_name: 'mcp__github__list_issues', tool_input: { owner: 'x' } });
  // Only the plain arguments object: a wrapper that names the server or the tool is a shape no signed-in run recorded yet.
  assert.equal(argsCall(mcp, { serverName: 'github', toolName: 'list_issues', arguments: { owner: 'x' } }), null, 'a wrapper does not say');
  assert.equal(argsCall(mcp, { toolName: 'list_issues', args: { owner: 'x' } }), null, 'a wrapper without the server does not say');
  assert.equal(argsCall(requestCall({ kind: 'mcp', serverName: 'github', toolName: 'list_issues' }), { owner: 'x' }), null, 'a card that showed no arguments');
  assert.equal(argsCall(requestCall({ kind: 'memory', intention: 'Remember' }), { fact: 'x' }), null, 'a card the arguments cannot be read against');
  for (const raw of [null, [], 'npm publish', { kind: 'shell', fullCommandText: 'rm -rf /' }]) assert.equal(argsCall(sh, raw), null, JSON.stringify(raw));
  assert.equal(argsCall(null, { command: 'x' }), null);
});

test('a read Copilot runs without asking: the feed names it when it is not low risk', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'secret');
    await r.idle(s);
    assert.ok(r.feed.some((l) => /Copilot CLI read \.env without asking the office \(risk medium\)/.test(l)), r.feed.join(' | '));
  } finally { await r.done(s); }
});

test('a failed turn: a sign-in error says so; a -32000 rate limit and "author" are not about sign-in', async () => {
  const r = rig();
  const s = r.session();
  try {
    await started(r, s);
    for (const [word, re] of [['busy', /^Copilot CLI: Rate limit exceeded/], ['author', /^Copilot CLI: The commit author is not set/]]) {
      const turns = s.turns;
      r.say(s, word);
      await until(() => s.turns > turns && s.status !== 'working', 'the turn to end');
      assert.match(s.error?.text || s.replies.at(-1)?.text || '', re, word);
      assert.doesNotMatch(s.error?.text || '', /not signed in/, word);
    }
  } finally { await r.done(s); }
});

test('requestCall: Copilot request bodies as the tool the office rates; anything else is not a request body', () => {
  assert.deepEqual(requestCall({ kind: 'url', url: 'https://x.test' }), { kind: 'fetch', tool_name: 'WebFetch', tool_input: { url: 'https://x.test' } });
  assert.deepEqual(requestCall({ kind: 'read', path: 'C:/x/.env' }), { kind: 'read', tool_name: 'Read', tool_input: { file_path: 'C:/x/.env' } });
  assert.equal(requestCall({ kind: 'memory', intention: 'Remember the build' }).tool_name, 'Copilot memory');
  assert.equal(requestCall({ kind: 'mcp', serverName: 'a b', toolName: '../x' }).tool_name, 'mcp__a_b__.._x');
  for (const raw of [null, [], { command: 'ls' }, { kind: 'toString' }, { kind: '__proto__' }]) assert.equal(requestCall(raw), null);
});

// The prompt round trip recorded from Copilot CLI 1.0.105, signed in, 2026-11-06 (test/fixtures/copilot-acp-prompt.json): the
// prompt "Reply with the word ok." with no tools. FAKE_COPILOT=recorded replays it for any prompt.
test('a recorded turn: the reply "ok" reaches the tracker and the turn ends clean on end_turn; no cost, no error', async () => {
  const r = rig({ fake: { FAKE_COPILOT: 'recorded' } });
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'Reply with the word ok.');
    await r.idle(s);
    assert.deepEqual(s.replies.map((x) => x.text), ['ok']);
    assert.equal(s.error, null, 'end_turn is a clean end');
    assert.equal(s.status, 'idle');
    assert.equal(s.cost, null, "the recording carries no cost field: the cost stays unknown");
    const sent = r.log().filter((m) => m.in && m.in.method).map((m) => m.in.method);
    assert.deepEqual(sent.filter((m) => m === 'session/prompt'), ['session/prompt'], 'one prompt');
  } finally { await r.done(s); }
});

test('a recorded turn: the token usage of the answer counts once, usage_update is the total used and its window', async () => {
  const r = rig({ fake: { FAKE_COPILOT: 'recorded' } });
  const s = r.session();
  const lines = [];
  const stream = r.events.stream;
  r.events.stream = (x, m) => { lines.push(m); return stream(x, m); };
  try {
    await started(r, s);
    r.say(s, 'Reply with the word ok.');
    await r.idle(s);
    assert.deepEqual(lines.filter((m) => m.type === 'usage'), [{ type: 'usage', used: 15259, ctx: { used: 15259, size: 128000 } }]);
    const turns = lines.filter((m) => m.type === 'assistant' && m.message.usage);
    assert.equal(turns.length, 1, 'one usage line for one turn');
    assert.deepEqual(turns[0].message.usage, { input_tokens: 14182, output_tokens: 5, cache_read_input_tokens: 0 });
    assert.equal(s.usage.tokens, 15259, 'the total from usage_update, not added to again by the turn usage');
    assert.equal(s.usage.input, 14182, 'the turn counted once');
    assert.deepEqual([s.ctxTokens, s.ctxWindow], [15259, 128000], 'Copilot usage_update is the tokens in context (#164)');
  } finally { await r.done(s); }
});

test('a recorded turn: session_info_update and config_option_update are ignored without an error or a feed line', async () => {
  const r = rig({ fake: { FAKE_COPILOT: 'recorded' } });
  const s = r.session();
  try {
    await started(r, s);
    r.say(s, 'Reply with the word ok.');
    await r.idle(s);
    assert.equal(s.error, null);
    assert.equal(s.replies.length, 1, 'neither update becomes a reply');
    assert.ok(!r.feed.some((t) => /session_info|config_option|title|Reply with the word/i.test(t)), 'nothing in the feed: ' + JSON.stringify(r.feed));
  } finally { await r.done(s); }
});
