// Port per branch: one stable port sequence for each branch or worktree, in a reserved range, so final browser tests of
// several worktrees never share a port with each other or with the owner's office on 4317 (#96, #106).
// Pure rules (launch.mjs) plus the real server with OFFICE_PORT=branch. Offline: no claude on PATH, no browser, no paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as bp from '../src/branch-port.mjs';
import * as launch from '../src/launch.mjs';
import { officeFiles } from '../src/files.mjs';
import { pageFile } from '../src/auth.mjs';
import { startOffice, settle, holdPort, hold, close, closeHeld, copyOffice } from './fixtures/office-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';

test('branchPort: same name, same port; always inside 4330-4399; never 4317', () => {
  assert.equal(bp.BRANCH_PORT_MIN, 4330);
  assert.equal(bp.BRANCH_PORT_MAX, 4399);
  const names = ['main', 'chore/port-per-branch', 'fix/55-64-66-small-layout', 'agent-a24e3e08d03fba8dc', 'detached', 'a', 'Ünï/çödé', '', ' '];
  for (let i = 0; i < 500; i++) names.push('feature/' + i, 'worktree-agent-' + (i * 7919).toString(16));
  for (const n of names) {
    const p = bp.branchPort(n);
    assert.ok(Number.isInteger(p) && p >= 4330 && p <= 4399, `${n} -> ${p}`);
    assert.notEqual(p, 4317);
    assert.equal(bp.branchPort(n), p, 'stable for ' + n);
  }
  // Fixed values: the same on every machine and every release. Changing the hash moves every branch, so this fails on purpose.
  const spread = new Set(names.map(bp.branchPort));
  assert.ok(spread.size > 60, 'the hash uses the range: ' + spread.size);
});

test('branchPort pins known values', () => {
  assert.deepEqual(
    ['main', 'chore/port-per-branch', 'fix/60-hide-agent-token'].map(bp.branchPort),
    PINNED,
  );
});
const PINNED = [4392, 4355, 4354];

test('branchPorts: a fixed sequence per name, the first is branchPort, no repeats, inside the range', () => {
  for (const n of ['main', 'feat/20-agent-kinds-ui', 'fix/79-toast-stack-400', 'x', '']) {
    const seq = bp.branchPorts(n);
    assert.equal(seq.length, bp.BRANCH_PORT_TRIES);
    assert.equal(seq[0], bp.branchPort(n));
    assert.equal(new Set(seq).size, seq.length, 'no repeat for ' + n);
    assert.ok(seq.every((p) => p >= 4330 && p <= 4399 && p !== 4317));
    assert.deepEqual(bp.branchPorts(n), seq, 'stable for ' + n);
    assert.deepEqual(bp.branchPorts(n, 3), seq.slice(0, 3));
  }
  assert.equal(bp.branchPorts('a', 1000).length, 70, 'never more than the range');
  assert.equal(bp.branchPorts('a', 0).length, 1);
  // The sequence wraps at the end of the range.
  const wrap = Array.from({ length: 400 }, (_, i) => bp.branchPorts('w' + i)).find((q) => q[0] === 4399);
  assert.ok(wrap && wrap[1] === 4330, 'wraps from 4399 to 4330');
});

// Two names with one first port (#106): the second office takes the next free port of the sequence.
const sameFirst = (() => {
  const seen = new Map();
  for (let i = 0; ; i++) {
    const n = 'fix/' + i, p = bp.branchPort(n);
    if (seen.has(p)) return [seen.get(p), n];
    seen.set(p, n);
  }
})();
const pick = (name, busy, own = []) => bp.pickBranchPort(name, { isFree: async (p) => !busy.includes(p), isOwn: async (p) => own.includes(p) });

test('pickBranchPort: two names with the same first port get different ports', async () => {
  const [a, b] = sameFirst;
  assert.equal(bp.branchPort(a), bp.branchPort(b));
  const first = await pick(a, []);
  assert.equal(first.port, bp.branchPort(a));
  assert.deepEqual(first.busy, []);
  const second = await pick(b, [first.port]); // the office of a holds it
  assert.equal(second.port, bp.branchPorts(b)[1]);
  assert.notEqual(second.port, first.port);
  assert.deepEqual(second.busy, [first.port]);
  const third = await pick('fix/third', bp.branchPorts('fix/third').slice(0, 2));
  assert.equal(third.port, bp.branchPorts('fix/third')[2]);
});

test('pickBranchPort: never takes a port an office of this checkout holds, and never leaves the sequence', async () => {
  const seq = bp.branchPorts('main');
  const own = await pick('main', [seq[0]], [seq[0]]);
  assert.equal(own.port, null);
  assert.equal(own.own, seq[0]);
  const foreign = await pick('main', [seq[0], seq[1]], [seq[1]]); // seq[0] is another checkout's office, seq[1] is ours
  assert.equal(foreign.port, null);
  assert.equal(foreign.own, seq[1]);
  // An own office at a later port counts even when an earlier port is free (the office of this checkout started when
  // seq[0] was busy, so it took seq[1]; seq[0] is free now): no second office here.
  const later = await pick('main', [seq[1]], [seq[1]]);
  assert.equal(later.port, null);
  assert.equal(later.own, seq[1]);
  const late = await pick('main', [seq[5]], [seq[5]]);
  assert.equal(late.port, null);
  assert.equal(late.own, seq[5]);
  // A foreign office at a later port is no reason to stop: the first free port is taken, busy lists only the ports skipped.
  const skip = await pick('main', [seq[0], seq[3]]);
  assert.equal(skip.port, seq[1]);
  assert.deepEqual(skip.busy, [seq[0]]);
  const full = await pick('main', seq); // a free port after the sequence is not tried
  assert.equal(full.port, null);
  assert.equal(full.own, undefined);
  assert.deepEqual(full.busy, seq);
});

test('checkoutName: the branch, or the worktree folder name when HEAD is detached', () => {
  assert.equal(bp.checkoutName({ branch: 'chore/x', root: 'E:\\a\\b\\wt1' }), 'chore/x');
  assert.equal(bp.checkoutName({ branch: 'detached', root: 'E:\\a\\b\\wt1' }), 'wt1');
  assert.equal(bp.checkoutName({ branch: 'detached', root: '/a/b/wt2/' }), 'wt2');
  assert.throws(() => bp.checkoutName(null), /not in a git repository/i);
});

const sh = (args, cwd) => execFileSync(launch.resolveExe('git'), ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
// The office takes ports of a name's sequence, so the test picks a name whose whole sequence is free to hold now. Offices
// that run at the same time hold other ports and cannot change what this test sees (#96).
async function freeName() {
  for (let i = 0; i < 300; i++) {
    const name = 'test/port-check-' + process.pid + '-' + i;
    const held = [];
    try { for (const p of bp.branchPorts(name)) held.push(await holdPort(p)); } catch { for (const s of held) s.close(); continue; }
    for (const s of held) await close(s);
    return name;
  }
  assert.fail('no branch with a free port sequence to test with');
}

// A stand-in for an office of this checkout: /api/info with the page token, and a hooks file inside the folder.
// `sub`: the hooks file sits in a subfolder (an office of a worktree below this checkout, not of this checkout).
const fakeOwn = (port, dir, lad, sub = '') => new Promise((resolve, reject) => {
  fs.mkdirSync(path.dirname(pageFile({ LOCALAPPDATA: lad }, port)), { recursive: true });
  fs.writeFileSync(pageFile({ LOCALAPPDATA: lad }, port), JSON.stringify({ token: 'page-token', port }));
  const s = http.createServer((req, res) => {
    const ok = req.url === '/api/info' && req.headers['x-office-token'] === 'page-token';
    res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hooksFile: officeFiles(path.join(dir, sub), port).hooksCmd }));
  });
  s.once('error', reject);
  s.listen(port, '127.0.0.1', () => resolve(hold(s)));
});

test('OFFICE_PORT=branch: the office takes the first free port of its sequence, says so, and stops when none is free or its own checkout holds one', { timeout: 600000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bport-')));
  const dir = path.join(tmp, 'office'), lad = path.join(tmp, 'local');
  fs.mkdirSync(dir);
  fs.mkdirSync(lad);
  copyOffice(dir);
  const branch = await freeName();
  const seq = bp.branchPorts(branch);
  sh(['init', '-b', branch], dir);
  sh(['commit', '--allow-empty', '-m', 'x'], dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [path.dirname(process.execPath), path.dirname(launch.resolveExe('git')), ...(win ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [])].join(path.delimiter),
    OFFICE_PORT: 'branch', OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(tmp, 'roaming'),
    OFFICE_RATE_FILE: path.join(tmp, 'no-rate.json'),
  });
  const filesIn = (d) => fs.readdirSync(d).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();
  try {
    // Every port of the sequence is busy: the office stops, names the branch and the ports it tried, and writes no file.
    const all = [];
    for (const p of seq) all.push(await holdPort(p));
    const before = filesIn(dir);
    const none = startOffice(dir, env);
    const r1 = await settle(none);
    for (const s of all) await close(s);
    assert.equal(r1.listening, false, none.out());
    assert.equal(r1.code, 1, none.out());
    assert.ok(none.out().includes(branch), none.out());
    for (const p of seq) assert.match(none.out(), new RegExp(`\\b${p}\\b`));
    assert.deepEqual(filesIn(dir), before, 'a stopped copy writes no file: no token, no hook or MCP settings');

    // The first port is held by an office of another checkout: the office takes the second port and says which one it took.
    const foreign = await holdPort(seq[0]);
    const second = startOffice(dir, env);
    try {
      const r2 = await settle(second);
      assert.equal(r2.listening, true, second.out());
      assert.match(second.out(), new RegExp(`port ${seq[1]}[. ]`));
      assert.match(second.out(), new RegExp(`${seq[0]} was busy`));
      assert.ok(second.out().includes(branch), second.out());
      assert.ok(second.out().includes(`127.0.0.1:${seq[1]}/`), second.out());
      assert.equal(JSON.parse(fs.readFileSync(officeFiles(dir, seq[1]).token, 'utf8')).port, seq[1]);
      assert.ok(!fs.existsSync(officeFiles(dir, seq[0]).token), 'the busy port gets no file (#100)');
      // The office of npm start keeps the plain names: a branch office never writes them (#100).
      for (const f of Object.values(officeFiles(dir))) assert.ok(!fs.existsSync(f), `a branch office wrote ${path.basename(f)}`);
    } finally { await second.stop(); await close(foreign); }
    await new Promise((r) => setTimeout(r, 500));

    // The first port is held by an office of this checkout: the office stops. It does not start a second office here.
    const mine = await fakeOwn(seq[0], dir, lad);
    const dup = startOffice(dir, env);
    const r3 = await settle(dup);
    await close(mine);
    assert.equal(r3.listening, false, dup.out());
    assert.equal(r3.code, 1, dup.out());
    assert.match(dup.out(), new RegExp(`already open on port ${seq[0]}`));
    const taken = officeFiles(dir, seq[1]).token;
    assert.equal(fs.readFileSync(taken, 'utf8').includes(`"port":${seq[1]}`), true, 'the earlier office left its own file');
    assert.ok(!dup.out().includes(`127.0.0.1:${seq[1]}/`), 'no second office of this checkout');

    // An office of this checkout holds a later port while the first is free: the office stops too (a checkout never runs two).
    const mineLater = await fakeOwn(seq[1], dir, lad);
    const dupLater = startOffice(dir, env);
    const r3b = await settle(dupLater);
    await close(mineLater);
    assert.equal(r3b.listening, false, dupLater.out());
    assert.equal(r3b.code, 1, dupLater.out());
    assert.match(dupLater.out(), new RegExp(`already open on port ${seq[1]}`));
    assert.ok(!fs.existsSync(officeFiles(dir, seq[0]).token), 'the stopped copy took no port');

    // The first port is held by an office of a worktree below this checkout (its hooks file is in a subfolder): that is
    // another checkout. The office takes the next port and does not stop with "already open from this folder".
    const nested = await fakeOwn(seq[0], dir, lad, path.join('.claude', 'worktrees', 'wf_x'));
    const nestedRun = startOffice(dir, env);
    try {
      const r3c = await settle(nestedRun);
      assert.equal(r3c.listening, true, nestedRun.out());
      assert.ok(!/already open/.test(nestedRun.out()), nestedRun.out());
      assert.match(nestedRun.out(), new RegExp(`port ${seq[1]}[. ]`));
    } finally { await nestedRun.stop(); await close(nested); }
    await new Promise((r) => setTimeout(r, 500));

    // Free: it listens on the first port and prints it.
    const ok = startOffice(dir, env);
    try {
      const r4 = await settle(ok);
      assert.equal(r4.listening, true, ok.out());
      assert.match(ok.out(), new RegExp(`port ${seq[0]}[. ]`));
      assert.ok(!/was busy/.test(ok.out()), ok.out());
      assert.ok(ok.out().includes(`127.0.0.1:${seq[0]}/`), ok.out());
      assert.equal(JSON.parse(fs.readFileSync(officeFiles(dir, seq[0]).token, 'utf8')).port, seq[0]);
    } finally { await ok.stop(); }

    // Outside git: a clear stop, no port guess.
    const plain = path.join(tmp, 'plain');
    fs.cpSync(dir, plain, { recursive: true });
    fs.rmSync(path.join(plain, '.git'), { recursive: true, force: true });
    fs.rmSync(officeFiles(plain, seq[0]).token, { force: true });
    const nogit = startOffice(plain, env);
    const r5 = await settle(nogit);
    assert.equal(r5.listening, false, nogit.out());
    assert.equal(r5.code, 1);
    assert.match(nogit.out(), /not in a git repository/i);
  } finally {
    await closeHeld();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder may stay */ }
  }
});
