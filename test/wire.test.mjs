// The /events wire format (public/wire.js): the lean snapshot (only what the page reads, with caps), the patch from
// one broadcast to the next, and the sender that numbers them. Sessions come from the real tracker fed with fake hook
// payloads. No server, no timers, no paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as auth from '../auth.mjs';
import { officeFiles } from '../files.mjs';
import { createTracker, MAX_CALLS } from '../tracker.mjs';
import { slimPayload } from '../payload.mjs';
import { placeOfSession } from '../place.mjs';
import '../public/vocab.js';
import '../public/wire.js';

const W = globalThis.OfficeWire, V = globalThis.OfficeVocab;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const wire = (v) => JSON.parse(JSON.stringify(v));   // as over SSE

// A tracker with n sessions; each makes `calls` tool calls (a realistic id and a long command).
function office(n, calls) {
  let t = 1_700_000_000_000, id = 0;
  const tr = createTracker({ now: () => t++, makeId: (k) => `${k[0]}${++id}`, locate: async () => null, setTimer: () => 0 });
  const hook = (p) => tr.onHook(slimPayload(p, null));
  for (let i = 0; i < n; i++) {
    const cwd = `C:\\work\\project-${i}`, sid = `5f0c3a1e-0000-4000-8000-00000000000${i}`;
    hook({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd, prompt: 'Fix the failing parser tests and explain the change.' });
    for (let c = 0; c < calls; c++) {
      const tool_use_id = `toolu_01${String(i).padStart(2, '0')}${String(c).padStart(4, '0')}QxZk7bW3nR9mT2vLp`;
      const tool_input = { command: `npm test -- --grep "parser case ${c}" && node scripts/check.mjs --strict --verbose --reporter=spec` };
      hook({ hook_event_name: 'PreToolUse', session_id: sid, cwd, tool_name: 'Bash', tool_input, tool_use_id });
      hook({ hook_event_name: 'PostToolUse', session_id: sid, cwd, tool_name: 'Bash', tool_input, tool_use_id, duration_ms: 240 });
    }
  }
  const state = () => {
    const sessions = [...tr.sessions.values()].map((s) => ({ ...s, place: placeOfSession(null, s.cwd) }));
    const figures = {};
    for (const s of sessions) figures[s.place.noteKey] = V.figures([s]);
    return { sessions, feed: tr.feed.slice(-80), plan: null, figures, notes: {}, pins: {}, repos: [], now: t };
  };
  return { tr, hook, state, tick: () => t };
}

test('the lean snapshot of 10 sessions with 60 calls each stays small, and keeps every call the page reads', () => {
  const o = office(10, 60);
  const raw = o.state(), lean = W.lean(raw);
  const before = bytes(raw), after = bytes(lean);
  console.log(`snapshot of 10 sessions x 60 calls: ${before} bytes before, ${after} bytes lean`);
  // Long Bash commands (a 90-character label) on all 600 calls is the worst case; calls are nearly all of it.
  assert.ok(after <= 135_000, `lean snapshot is ${after} bytes`);
  assert.ok(after < before * 0.8, `lean ${after} vs full ${before}`);
  assert.equal(lean.sessions.length, 10);
  for (const s of lean.sessions) {
    assert.equal(s.calls.length, MAX_CALLS, 'the page counts and lists all calls the tracker keeps');
    for (const c of s.calls) { assert.equal(typeof c.ok, 'boolean'); assert.equal(c.ms, 240); assert.ok(c.detail && c.id && c.t); }
  }
  assert.equal(lean.feed, undefined, 'the page does not read the feed');
  assert.equal(lean.now, undefined, 'or the server time');
});

test('a session sends only the fields the page reads; server-only fields stay on the server', () => {
  const o = office(1, 2);
  const s = [...o.tr.sessions.values()][0];
  s.pending.push({ id: 'p1', key: 'secret-call-key', agent: null, tool: 'Bash', detail: 'rm x', risk: 'high', preview: 'rm x', always: '', t: 5 });
  s.inbox.push({ t: 7, text: 'a long user message that the page never shows' });
  s.git = { repo: 'C:\\r', root: 'C:\\r', branch: 'main' };
  const l = W.lean(o.state()).sessions[0];
  for (const f of ['sid', 'pid', 'officeId', 'startDir', 'gitCwd', 'gitAt', 'costBase', 'replySeq', 'lastUsageId', 'errorSeq', 'placed', 'launched', 'interrupted', 'budget', 'worktree']) {
    assert.equal(f in l, false, f);
  }
  for (const f of W.SESSION_FIELDS) assert.notEqual(l[f], undefined, `${f} is always set, so a patch can clear it`);
  assert.deepEqual(l.pending[0], { id: 'p1', agent: null, tool: 'Bash', detail: 'rm x', risk: 'high', preview: 'rm x', always: '', t: 5 }, 'no call key');
  assert.deepEqual(l.inbox, [{ t: 7 }], 'the page counts queued messages, it does not show them');
  assert.deepEqual(l.git, { branch: 'main' });
  const open = { id: 'x', name: 'Read', detail: 'a.js', file: null, agent: null, t: 1, ms: null, ok: null, err: null };
  assert.deepEqual(W.leanCall(open), { id: 'x', name: 'Read', detail: 'a.js', t: 1, ok: null }, 'an open call keeps ok: null');
  // The agent kind: every list and the bot card show it (#20). A session the tracker saw first in a hook is Claude Code.
  assert.equal(l.provider, 'claude-code');
});

test('the snapshot carries the agent kinds once, and a patch never repeats them', () => {
  const o = office(1, 1);
  const kinds = [{ kind: 'claude-code', label: 'Claude Code', paid: true, terminal: true, modes: ['default'], needsModel: false },
    { kind: 'ollama', label: 'Ollama', paid: false, terminal: false, modes: [], needsModel: true }];
  const a = W.lean({ ...o.state(), kinds });
  assert.deepEqual(a.kinds, kinds);
  assert.deepEqual(W.lean(o.state()).kinds, [], 'no kinds: an empty list, never undefined');
  o.hook({ hook_event_name: 'UserPromptSubmit', session_id: '5f0c3a1e-0000-4000-8000-000000000000', cwd: 'C:\\work\\project-0', prompt: 'Again.' });
  const p = W.diff(a, W.lean({ ...o.state(), kinds }));
  assert.ok(p, 'the session changed');
  assert.equal('kinds' in (p.set || {}), false, 'the kinds did not change: the patch leaves them out');
});

test('replies are capped per broadcast by characters, newest first, and the newest always goes', () => {
  const o = office(1, 0);
  const s = [...o.tr.sessions.values()][0];
  for (let i = 0; i < 40; i++) o.tr.pushReply(s, String(i % 10).repeat(8000));
  const l = W.lean(o.state()).sessions[0];
  const chars = l.replies.reduce((n, r) => n + r.text.length, 0);
  assert.ok(chars <= W.CAPS.replyChars, `${chars} characters`);
  assert.equal(l.replies.at(-1).id, s.replies.at(-1).id, 'the newest reply');
  assert.deepEqual(l.replies.map((r) => r.id), s.replies.slice(-l.replies.length).map((r) => r.id), 'the newest ones, in order');
  assert.equal(l.replies[0].text.length, 8000, 'reply text is not cut');
  o.tr.pushReply(s, 'x'.repeat(8000));
  s.replies = [{ id: 1, text: 'y'.repeat(W.CAPS.replyChars + 10), t: 1 }];
  assert.equal(W.lean(o.state()).sessions[0].replies.length, 1, 'one reply longer than the cap still goes');
  const few = office(1, 0), f = [...few.tr.sessions.values()][0];
  for (let i = 0; i < 40; i++) few.tr.pushReply(f, 'Short answer ' + i);
  assert.equal(W.lean(few.state()).sessions[0].replies.length, 40, 'short replies all go');
});

test('diff and apply: one new call is a small patch, and apply gives the same snapshot', () => {
  const o = office(10, 60);
  const a = W.lean(o.state());
  const sid = '5f0c3a1e-0000-4000-8000-000000000003';
  o.hook({ hook_event_name: 'PreToolUse', session_id: sid, cwd: 'C:\\work\\project-3', tool_name: 'Read', tool_input: { file_path: 'C:\\work\\project-3\\src\\parse.mjs' }, tool_use_id: 'toolu_new' });
  const b = W.lean(o.state());
  const p = W.diff(a, b);
  console.log(`one new call: patch ${bytes(p)} bytes, full ${bytes(b)} bytes`);
  assert.ok(bytes(p) < 1500, `patch is ${bytes(p)} bytes`);
  assert.deepEqual(W.apply(wire(a), wire(p)), wire(b));
  assert.equal(W.diff(b, W.lean(o.state())), null, 'nothing changed: no patch');
});

test('apply shares what did not change and never changes the snapshot it starts from', () => {
  const o = office(3, 5);
  const a = wire(W.lean(o.state()));
  const frozen = JSON.stringify(a);
  o.hook({ hook_event_name: 'Stop', session_id: '5f0c3a1e-0000-4000-8000-000000000001', cwd: 'C:\\work\\project-1' });
  const p = wire(W.diff(a, W.lean(o.state())));
  const b = W.apply(a, p);
  assert.equal(JSON.stringify(a), frozen, 'the old snapshot is unchanged');
  assert.equal(b.sessions[0], a.sessions[0], 'an unchanged session is the same object');
  assert.notEqual(b.sessions[1], a.sessions[1]);
  assert.equal(b.sessions[1].calls, a.sessions[1].calls, 'an unchanged list is shared');
});

test('diff and apply round-trip: sessions come and go, calls close and drop, replies roll, maps change, order changes', () => {
  const base = {
    sessions: [
      { uid: 'a', status: 'working', calls: [{ id: 'c1', ok: null, t: 1 }, { id: 'c2', ok: null, t: 2 }], replies: [{ id: 1, text: 'hi', t: 1 }], error: null },
      { uid: 'b', status: 'idle', calls: [], replies: [], error: null },
      { uid: 'c', status: 'idle', calls: [], replies: [], error: null },
    ],
    plan: null, figures: { k1: { sessions: 1 }, k2: { sessions: 2 } }, notes: { k1: { text: 'n', v: 1 } }, pins: {}, repos: [],
  };
  const steps = [
    (s) => { s.sessions[0].calls[0].ok = true; s.sessions[0].calls.push({ id: 'c3', ok: null, t: 3 }); },
    (s) => { s.sessions[0].calls.shift(); s.sessions[0].replies.push({ id: 2, text: 'more', t: 4 }); s.sessions[0].replies.shift(); },
    (s) => { s.sessions.splice(1, 1); s.sessions.push({ uid: 'd', status: 'starting', calls: [], replies: [], error: null }); },
    (s) => { s.sessions[0].error = { id: 1, text: 'Failed' }; s.figures.k3 = { sessions: 1 }; delete s.figures.k1; s.notes.k1.text = 'changed'; },
    (s) => { s.sessions.reverse(); s.plan = { week: { percent: 40 } }; },
    (s) => { s.sessions[0].calls = [{ id: 'z', ok: true }, { id: 'z', ok: false }]; },   // a duplicate key: the whole list goes
    (s) => { s.sessions[1].error = null; s.repos = [{ key: 'r', worktrees: [] }]; s.pins.k2 = { text: 'Pin' }; },
  ];
  let prev = wire(base), cur = wire(base);
  for (const [i, step] of steps.entries()) {
    step(cur);
    const p = W.diff(prev, cur);
    assert.ok(p, `step ${i} changes something`);
    assert.deepEqual(W.apply(wire(prev), wire(p)), wire(cur), `step ${i}`);
    prev = wire(cur);
  }
});

test('the sender numbers patches; a client checks that a patch starts from what it has', () => {
  const tx = W.sender();
  assert.equal(tx.next({ sessions: [], plan: null }), null, 'the first state is the base; there is nothing to patch');
  assert.deepEqual(tx.full(), { seq: 1, sessions: [], plan: null });
  assert.equal(tx.next({ sessions: [], plan: null }), null, 'no change: no patch');
  const p = tx.next({ sessions: [], plan: { week: null } });
  assert.equal(p.patch, 1); assert.equal(p.base, 1); assert.equal(p.seq, 2);
  const client = W.apply(tx.full() && { seq: 1, sessions: [], plan: null }, p);
  assert.equal(client.seq, 2);
  assert.deepEqual(client, tx.full());
  assert.equal(W.fits({ seq: 1 }, p), true);
  assert.equal(W.fits({ seq: 2 }, p), false, 'a patch for another base does not fit');
  assert.equal(W.fits(null, p), false);
  // the tracker changes objects in place (usage grows, a subagent is done): the base must not change with them
  const o = office(1, 1), s = [...o.tr.sessions.values()][0];
  const tx2 = W.sender();
  tx2.next(W.lean(o.state()));
  s.usage.tokens += 500;
  const up = tx2.next(W.lean(o.state()));
  assert.ok(up, 'a change made in place is still a change');
  assert.deepEqual(up.sub.sessions.edit[0].p.set.usage, { tokens: 500, cached: 0, input: 0 });
  tx.reset();
  assert.equal(tx.next({ sessions: [] }), null, 'after a reset the next state is a new base');
  assert.equal(tx.full().seq, 3, 'the number keeps going up, so an old patch never fits a new base');
});

// ---------- the real server ----------
// A copy of the office in a temp folder on a free port, with its own LOCALAPPDATA (as test/auth.test.mjs does). No claude
// on PATH, no browser, no paid call: fake hooks only.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// An /events reader: every message, and the snapshot it adds up to (the way the page's store does it).
function listen(port, token) {
  const r = { msgs: [], snap: null, misfits: 0, req: null };
  r.req = http.request({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}`, 'x-office-token': token } }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const line = buf.slice(0, i);
        if (!line.startsWith('data: ')) continue;
        const m = JSON.parse(line.slice(6));
        r.msgs.push({ t: Date.now(), bytes: Buffer.byteLength(line), m });
        if (!m.patch) r.snap = m; else if (W.fits(r.snap, m)) r.snap = W.apply(r.snap, m); else r.misfits++;
      }
    });
  });
  r.req.end();
  r.close = () => r.req.destroy();
  return r;
}

test('the server: a whole snapshot on connect, then patches that add up to it; pages that join late agree; full data on request', { timeout: 90000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-wire-')));
  const dir = path.join(tmp, 'office'), lad = path.join(tmp, 'local');
  fs.mkdirSync(dir); fs.mkdirSync(lad);
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.mjs') || f === 'package.json') fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['providers', 'public']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [])].join(path.delimiter),
    OFFICE_PORT: String(port), OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(tmp, 'roaming'), OFFICE_RATE_FILE: path.join(tmp, 'no-rate.json'),
  });
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const readers = [];
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the office did not start in time:\n' + out)), 30000);
      const onData = (d) => { out += d; if (/is open: /.test(out)) { clearTimeout(t); resolve(); } };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('exit', (code) => { clearTimeout(t); reject(new Error(`the office stopped (${code}):\n${out}`)); });
    });
    const agent = JSON.parse(fs.readFileSync(officeFiles(dir, port).token, 'utf8')).token;
    const page = JSON.parse(fs.readFileSync(auth.pageFile(env, port), 'utf8')).token;
    const hook = (body) => new Promise((res, rej) => {
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hook', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'x-office-token': agent } }, (x) => { x.resume(); x.on('end', res); });
      q.on('error', rej); q.end(JSON.stringify(body));
    });
    const settle = () => new Promise((r) => setTimeout(r, 400));
    const early = listen(port, page); readers.push(early);
    await settle();
    const N = 4, CALLS = 30, cwds = [];
    for (let i = 0; i < N; i++) { cwds.push(path.join(tmp, 'work', 'p' + i)); fs.mkdirSync(cwds[i], { recursive: true }); }
    for (let i = 0; i < N; i++) await hook({ hook_event_name: 'UserPromptSubmit', session_id: 's' + i, cwd: cwds[i], prompt: 'Go.' });
    const t0 = Date.now();
    let late = null;
    for (let c = 0; c < CALLS; c++) {
      if (c === CALLS / 2) { late = listen(port, page); readers.push(late); }   // joins in the middle of the burst
      for (let i = 0; i < N; i++) {
        const p = { session_id: 's' + i, cwd: cwds[i], tool_name: 'Bash', tool_input: { command: 'npm test ' + c }, tool_use_id: `toolu_${i}_${c}` };
        await hook({ hook_event_name: 'PreToolUse', ...p });
        await hook({ hook_event_name: 'PostToolUse', ...p, duration_ms: 5 });
      }
      await new Promise((r) => setTimeout(r, 25));   // a working pace: several broadcasts in the burst
    }
    const t1 = Date.now();
    await settle();
    const fresh = listen(port, page); readers.push(fresh);
    await settle();

    assert.equal(early.msgs[0].m.patch, undefined, 'the first message is the whole snapshot');
    assert.ok(early.msgs.slice(1).every((x) => x.m.patch === 1), 'the rest are patches');
    for (const r of [early, late]) {
      assert.equal(r.misfits, 0, 'every patch fits');
      assert.deepEqual(r.snap, fresh.snap, 'the patches add up to what a page gets when it connects now');
    }
    assert.equal(fresh.snap.sessions.length, N);
    assert.ok(fresh.snap.sessions.every((s) => s.calls.length === CALLS && s.calls.every((c) => c.ok === true)));
    assert.equal('sid' in fresh.snap.sessions[0], false, 'the snapshot is lean');
    assert.ok(fresh.snap.sessions.every((s) => s.provider === 'claude-code'), 'each session says its agent kind');
    assert.deepEqual(fresh.snap.kinds.map((k) => [k.kind, k.label]), [['claude-code', 'Claude Code'], ['ollama', 'Ollama'], ['lmstudio', 'LM Studio']], 'the server sends its agent kinds');
    // one message per broadcast window at most (100 ms), however many hooks come in
    const during = early.msgs.filter((x) => x.t >= t0 && x.t <= t1 + 150).length;
    assert.ok(during <= Math.ceil((t1 - t0) / 100) + 2, `${during} messages in ${t1 - t0} ms for ${N * CALLS * 2} hooks`);
    const full = fresh.msgs[0].bytes, patches = early.msgs.slice(1);
    const mean = patches.reduce((n, x) => n + x.bytes, 0) / patches.length;
    console.log(`server: ${N * CALLS * 2} hooks in ${t1 - t0} ms, ${patches.length} patches, mean ${Math.round(mean)} bytes; whole snapshot ${full} bytes`);
    assert.ok(mean < full / 2, 'a patch is smaller than the whole snapshot');

    // full data on request: one session with the fields the snapshot leaves out
    const uid = fresh.snap.sessions[0].uid;
    const one = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: `/api/session?uid=${uid}`, headers: { host: `127.0.0.1:${port}`, 'x-office-token': page } }, (x) => { let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => res({ status: x.statusCode, j: JSON.parse(b) })); }));
    assert.equal(one.status, 200);
    assert.equal(one.j.session.uid, uid);
    assert.equal(one.j.session.sid, 's0');
    assert.ok('startDir' in one.j.session && one.j.session.place);
    const none = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/api/session?uid=nope', headers: { host: `127.0.0.1:${port}`, 'x-office-token': page } }, (x) => { x.resume(); res(x.statusCode); }));
    assert.equal(none, 404);
    const noToken = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: `/api/session?uid=${uid}`, headers: { host: `127.0.0.1:${port}` } }, (x) => { x.resume(); res(x.statusCode); }));
    assert.equal(noToken, 401, 'the page token is needed');
  } finally {
    readers.forEach((r) => r.close());
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
