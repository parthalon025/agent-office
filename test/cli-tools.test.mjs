// The headless CLI tools (providers/cli-tools.mjs: Cursor CLI, Grok CLI, Pi) against a fake CLI (test/fixtures/fake-cli.mjs): a real
// Node process per turn that prints JSON lines. The provider gets an injected program resolver and a spawn that runs the fixture,
// so no real tool, no model and no paid call. The Codex entry of the ACP list is checked here too (its program and traits).
// Run: node --test test/cli-tools.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTracker } from '../src/tracker.mjs';
import { providerEvents, createRegistry, checkProvider, traitsOf, spendLimitFor } from '../src/providers/index.mjs';
import { createCliTool, TOOLS } from '../src/providers/cli-tools.mjs';
import { AGENTS } from '../src/providers/acp.mjs';
import '../src/vocab.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli.mjs');
const made = new Set();
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

async function until(fn, what, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function rig(kind, over = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cli-')));
  made.add(base);
  const root = path.join(base, 'work');
  fs.mkdirSync(root);
  const r = { base, root, spawned: [], logFile: path.join(base, 'log.jsonl') };
  r.tracker = createTracker({ now: () => 1_000_000, locate: async () => null, releaseHold: () => false, setTimer: (fn) => { fn(); return 0; } });
  r.events = providerEvents({ tracker: r.tracker, hold: () => {}, release: () => {}, fresh: () => {} });
  r.p = createCliTool({
    events: r.events, kind, sessionDir: path.join(base, 'sessions'),
    exe: (name) => `C:/bin/${name}.exe`,
    spawn: (file, args, opts) => {
      r.spawned.push({ file, args, opts });
      return realSpawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...opts.env, FAKE_CLI_FAMILY: kind, FAKE_CLI_LOG: r.logFile } });
    },
    ...over,
  });
  r.session = () => r.tracker.newSession({ uid: 'o1', officeId: 'o1', provider: kind, name: 'bot', cwd: root, startDir: root, headless: true, status: 'starting' });
  r.say = (s, text) => { r.p.message(s, { text }); r.tracker.userMessage(s); r.tracker.startTurn(s, text); };
  r.idle = (s, turns = 1) => until(() => s.status === 'idle' && s.turns >= turns, 'the turn to end');
  r.log = () => fs.readFileSync(r.logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return r;
}

test('every kind is a provider with honest traits: ungated, cost unknown, paid, in a room of its own', () => {
  for (const kind of Object.keys(TOOLS)) {
    const p = createCliTool({ events: {}, kind });
    assert.equal(checkProvider(p), p);
    const t = traitsOf(p);
    assert.deepEqual([t.gated, t.paid, t.cost, t.supervision], [false, true, 'unknown', 'Unsupervised: its tools run without asking the office'], kind);
    assert.equal(spendLimitFor({ paid: t.paid, cost: t.cost, requested: 5 }), null);
  }
  assert.deepEqual(Object.keys(TOOLS), ['cursor', 'grok', 'pi']);
});

test('codex is an ACP agent: codex-acp, ungated, with the steps to install it', () => {
  assert.equal(AGENTS.codex.program, 'codex-acp');
  assert.equal(AGENTS.codex.gated, false);
  assert.match(AGENTS.codex.needs[0], /codex-acp/);
});

test('the Security room has one CLI tools column for all four', () => {
  const S = globalThis.OfficeVocab.security;
  for (const k of ['codex', 'cursor', 'grok', 'pi']) assert.equal(S.columnOf(k), 'cli', k);
  assert.equal(S.applies('ungated', 'cli'), true);
  assert.equal(S.applies('no-cost', 'cli'), true);
});

for (const kind of ['cursor', 'grok', 'pi']) {
  test(`${kind}: a turn runs the program by absolute path in the folder and reports the reply and the tokens`, async () => {
    const r = rig(kind);
    const s = r.session();
    try {
      r.p.open(s, {});
      assert.equal(s.sid, null, 'nothing is reported inside open (seam timing rule 1)');
      r.say(s, 'hello');
      await r.idle(s);
      assert.equal(r.spawned[0].file, `C:/bin/${TOOLS[kind].program}.exe`);
      assert.equal(r.spawned[0].opts.cwd, r.root);
      assert.equal(r.spawned[0].opts.env.OFFICE_ID, 'o1');
      assert.deepEqual(r.log().map((l) => l.prompt), ['hello']);
      assert.deepEqual(s.replies.map((x) => x.text), ['echo: hello']);
      assert.ok(s.usage.tokens > 0, 'tokens counted');
      assert.ok(s.sid, 'a session id');
    } finally { await r.p.close(s); }
  });

  test(`${kind}: a failed turn shows as an error with the tool's words`, async () => {
    const r = rig(kind);
    const s = r.session();
    try {
      r.p.open(s, {});
      r.say(s, 'FAIL');
      await until(() => s.status === 'error' || s.error, 'the error');
      assert.match(String(s.error?.text || s.error), /boom/);
    } finally { await r.p.close(s); }
  });

  test(`${kind}: interrupt stops the turn and kills the process tree`, async () => {
    const r = rig(kind);
    const s = r.session();
    try {
      r.p.open(s, {});
      r.say(s, 'HANG');
      await until(() => fs.existsSync(r.logFile), 'the process to start');
      r.p.interrupt(s);
      r.tracker.interrupt(s);
      await until(() => s.status === 'idle', 'the turn to stop');
      assert.equal(s.error, null);
    } finally { await r.p.close(s); }
  });
}

test('cursor and grok resume the tool session on the second turn; pi keeps one session file in the office folder', async () => {
  for (const kind of ['cursor', 'grok', 'pi']) {
    const r = rig(kind);
    const s = r.session();
    try {
      r.p.open(s, {});
      r.say(s, 'one');
      await r.idle(s);
      r.say(s, 'two');
      await r.idle(s, 2);
      const [a, b] = r.spawned.map((x) => x.args);
      if (kind === 'pi') {
        const f = (x) => x[x.indexOf('--session') + 1];
        assert.equal(f(a), f(b));
        assert.ok(f(a).startsWith(path.join(r.base, 'sessions')));
      } else {
        assert.ok(!a.includes('--resume'));
        assert.deepEqual(b.slice(b.indexOf('--resume'), b.indexOf('--resume') + 2), ['--resume', `sess-${kind}`]);
      }
    } finally { await r.p.close(s); }
  }
});

test('no auto-approve switch is ever passed, and a prompt that starts with a dash is not read as a flag', async () => {
  for (const kind of ['cursor', 'grok', 'pi']) {
    const r = rig(kind);
    const s = r.session();
    try {
      r.p.open(s, { model: 'some-model' });
      r.say(s, '--yolo now');
      await r.idle(s);
      const args = r.spawned[0].args;
      assert.ok(!args.some((x) => ['--yolo', '--force', '-f', '--always-approve', '--trust', '--dangerously-bypass-approvals-and-sandbox'].includes(x)), `${kind} passes no approve switch`);
      assert.ok(args.includes('--model') && args.includes('some-model'), 'the model');
      assert.equal(r.log()[0].prompt, ' --yolo now', 'a leading space guards the dash');
    } finally { await r.p.close(s); }
  }
});

test('pi reports its tool calls as hooks; the others say in the feed that theirs are not shown', async () => {
  const r = rig('pi');
  const s = r.session();
  try {
    r.p.open(s, {});
    r.say(s, 'TOOL');
    await r.idle(s);
    assert.ok(s.calls.some((c) => c.name === 'Bash' && c.ok === true), 'the bash call is on the session, closed');
  } finally { await r.p.close(s); }
  const c = rig('cursor');
  const cs = c.session();
  try {
    c.p.open(cs, {});
    await until(() => c.tracker.feed.length, 'the feed line');
    assert.ok(c.tracker.feed.some((f) => /does not report its tool calls/.test(f.text)), 'one feed line at start');
  } finally { await c.p.close(cs); }
});

test('readiness: not installed gives the install steps; check() refuses a bad model; a script install is named', async () => {
  const gone = createCliTool({ events: {}, kind: 'grok', exe: () => { throw new Error('grok was not found on PATH.'); } });
  const ready = await gone.readiness();
  assert.equal(ready.ready, false);
  assert.match(ready.needs[0], /grok/);
  const script = createCliTool({ events: {}, kind: 'pi', exe: () => { throw Object.assign(new Error('x'), { code: 'SCRIPT_INSTALL', file: 'C:/n/pi.cmd' }); } });
  assert.match((await script.readiness()).needs.join(' '), /pi\.cmd/);
  const p = createCliTool({ events: {}, kind: 'cursor', exe: (n) => `C:/bin/${n}.exe` });
  assert.throws(() => p.check({ model: '--evil' }), (e) => e.status === 400);
  assert.doesNotThrow(() => p.check({ model: 'gpt-5' }));
  const reg = createRegistry([p]);
  assert.equal(reg.get('cursor').label, 'Cursor CLI');
});

test('readiness: the version comes from the program', async () => {
  const p = createCliTool({
    events: {}, kind: 'cursor', exe: (n) => `C:/bin/${n}.exe`,
    execFile: (file, args, opts, cb) => { assert.deepEqual(args, ['--version']); cb(null, '1.2.3\n', ''); },
  });
  assert.deepEqual(await p.readiness(), { ready: true, version: '1.2.3', needs: [] });
});
