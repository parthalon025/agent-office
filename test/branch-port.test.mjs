// Port per branch: one stable port for each branch or worktree, in a reserved range, so final browser tests of
// several worktrees never share a port with each other or with the owner's office on 4317.
// Pure rules (git.mjs) plus the real server with OFFICE_PORT=branch. Offline: no claude on PATH, no browser, no paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import * as git from '../git.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';

test('branchPort: same name, same port; always inside 4330-4399; never 4317', () => {
  assert.equal(git.BRANCH_PORT_MIN, 4330);
  assert.equal(git.BRANCH_PORT_MAX, 4399);
  const names = ['main', 'chore/port-per-branch', 'fix/55-64-66-small-layout', 'agent-a24e3e08d03fba8dc', 'detached', 'a', 'Ünï/çödé', '', ' '];
  for (let i = 0; i < 500; i++) names.push('feature/' + i, 'worktree-agent-' + (i * 7919).toString(16));
  for (const n of names) {
    const p = git.branchPort(n);
    assert.ok(Number.isInteger(p) && p >= 4330 && p <= 4399, `${n} -> ${p}`);
    assert.notEqual(p, 4317);
    assert.equal(git.branchPort(n), p, 'stable for ' + n);
  }
  // Fixed values: the same on every machine and every release. Changing the hash moves every branch, so this fails on purpose.
  const spread = new Set(names.map(git.branchPort));
  assert.ok(spread.size > 60, 'the hash uses the range: ' + spread.size);
});

test('branchPort pins known values', () => {
  assert.deepEqual(
    ['main', 'chore/port-per-branch', 'fix/60-hide-agent-token'].map(git.branchPort),
    PINNED,
  );
});
const PINNED = [4392, 4355, 4354];

test('checkoutName: the branch, or the worktree folder name when HEAD is detached', () => {
  assert.equal(git.checkoutName({ branch: 'chore/x', root: 'E:\\a\\b\\wt1' }), 'chore/x');
  assert.equal(git.checkoutName({ branch: 'detached', root: 'E:\\a\\b\\wt1' }), 'wt1');
  assert.equal(git.checkoutName({ branch: 'detached', root: '/a/b/wt2/' }), 'wt2');
  assert.throws(() => git.checkoutName(null), /not in a git repository/i);
});

const sh = (args, cwd) => execFileSync(git.resolveExe('git'), ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
const holdPort = (port) => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(port, '127.0.0.1', () => resolve(s));
});

function startOffice(dir, env) {
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const settled = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ listening: /is open: /.test(out), code: null }), 30000);
    const check = () => { if (/is open: /.test(out)) { clearTimeout(t); resolve({ listening: true, code: null }); } };
    child.stdout.on('data', check);
    child.on('exit', (code) => { clearTimeout(t); resolve({ listening: false, code }); });
  });
  return { child, settled, out: () => out };
}

test('OFFICE_PORT=branch: the office uses the port of its branch, says so, and stops when that port is busy', { timeout: 120000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bport-')));
  const dir = path.join(tmp, 'office'), lad = path.join(tmp, 'local');
  fs.mkdirSync(dir);
  fs.mkdirSync(lad);
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.mjs') || f === 'package.json') fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['providers', 'public']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  // The port comes from the branch name, so a fixed name collides with another suite that runs at the same time. Take the first name whose port is free now.
  let branch = '';
  for (let i = 0; !branch; i++) {
    if (i > 200) assert.fail('no free branch port to test with');
    const name = 'test/port-check-' + i;
    try { await holdPort(git.branchPort(name)).then((s) => new Promise((r) => s.close(r))); branch = name; } catch { /* in use: try the next name */ }
  }
  sh(['init', '-b', branch], dir);
  sh(['commit', '--allow-empty', '-m', 'x'], dir);
  const want = git.branchPort(branch);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [path.dirname(process.execPath), path.dirname(git.resolveExe('git')), ...(win ? [path.join(process.env.SystemRoot || 'C:\Windows', 'System32')] : [])].join(path.delimiter),
    OFFICE_PORT: 'branch', OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(tmp, 'roaming'),
    OFFICE_RATE_FILE: path.join(tmp, 'no-rate.json'),
  });
  try {
    // Busy: the office stops, names the port and the branch, and does not move to another port.
    const blocker = await holdPort(want);
    const busy = startOffice(dir, env);
    const r1 = await busy.settled;
    await new Promise((r) => blocker.close(r));
    assert.equal(r1.listening, false, busy.out());
    assert.equal(r1.code, 1, busy.out());
    assert.match(busy.out(), new RegExp(`port ${want}[. ]`));
    assert.ok(busy.out().includes(branch), busy.out());
    assert.ok(!fs.existsSync(path.join(dir, '.office-token')), 'a stopped copy writes no token');

    // Free: it listens on that port and prints it.
    const ok = startOffice(dir, env);
    try {
      const r2 = await ok.settled;
      assert.equal(r2.listening, true, ok.out());
      assert.match(ok.out(), new RegExp(`port ${want}[. ]`));
      assert.ok(ok.out().includes(branch), ok.out());
      assert.ok(ok.out().includes(`127.0.0.1:${want}/`), ok.out());
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.office-token'), 'utf8')).port, want);
    } finally { ok.child.kill(); }

    // Outside git: a clear stop, no port guess.
    const plain = path.join(tmp, 'plain');
    fs.cpSync(dir, plain, { recursive: true });
    fs.rmSync(path.join(plain, '.git'), { recursive: true, force: true });
    fs.rmSync(path.join(plain, '.office-token'), { force: true });
    const nogit = startOffice(plain, env);
    const r3 = await nogit.settled;
    assert.equal(r3.listening, false, nogit.out());
    assert.equal(r3.code, 1);
    assert.match(nogit.out(), /not in a git repository/i);
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder may stay */ }
  }
});
