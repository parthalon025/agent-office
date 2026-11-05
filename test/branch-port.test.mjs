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
import { execFileSync } from 'node:child_process';
import * as git from '../git.mjs';
import { officeFiles } from '../files.mjs';
import { startOffice } from './fixtures/office-server.mjs';

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

// listening: the server said it is open. A server that stopped first has its exit code.
const settle = async (o) => {
  const listening = await o.done.then(() => true, () => false);
  return { listening, code: listening ? null : await o.exited };
};

test('OFFICE_PORT=branch: the office uses the port of its branch, says so, and stops when that port is busy', { timeout: 900000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bport-')));
  const dir = path.join(tmp, 'office'), lad = path.join(tmp, 'local');
  fs.mkdirSync(dir);
  fs.mkdirSync(lad);
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.mjs') || f === 'package.json') fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['providers', 'public']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  // The port comes from the branch name, so a fixed name collides with another suite that runs at the same time. Take the first name
  // whose port is free now. A free port is a guess: another run can take it before the office binds it, so a step that finds its
  // port taken moves the repository to the next free name (git branch -m) and tries again.
  let tries = 0;
  const freeName = async () => {
    for (;;) {
      if (++tries > 400) assert.fail('no free branch port to test with');
      const name = 'test/port-check-' + tries;
      try { await holdPort(git.branchPort(name)).then((s) => new Promise((r) => s.close(r))); return name; } catch { /* in use: try the next name */ }
    }
  };
  let branch = await freeName();
  sh(['init', '-b', branch], dir);
  sh(['commit', '--allow-empty', '-m', 'x'], dir);
  const moveToFreeBranch = async () => { branch = await freeName(); sh(['branch', '-m', branch], dir); };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [path.dirname(process.execPath), path.dirname(git.resolveExe('git')), ...(win ? [path.join(process.env.SystemRoot || 'C:\Windows', 'System32')] : [])].join(path.delimiter),
    OFFICE_PORT: 'branch', OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(tmp, 'roaming'),
    OFFICE_RATE_FILE: path.join(tmp, 'no-rate.json'),
  });
  const filesIn = (d) => fs.readdirSync(d).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();
  try {
    // Busy: the office stops, names the port and the branch, and does not move to another port.
    let blocker = null;
    while (!blocker) {
      try { blocker = await holdPort(git.branchPort(branch)); } catch { await moveToFreeBranch(); /* the port was taken since the check */ }
    }
    let want = git.branchPort(branch);
    const before = filesIn(dir);
    const busy = startOffice(dir, env);
    const r1 = await settle(busy);
    await new Promise((r) => blocker.close(r));
    assert.equal(r1.listening, false, busy.out());
    assert.equal(r1.code, 1, busy.out());
    assert.match(busy.out(), new RegExp(`port ${want}[. ]`));
    assert.ok(busy.out().includes(branch), busy.out());
    assert.deepEqual(filesIn(dir), before, 'a stopped copy writes no file: no token, no hook or MCP settings');

    // Free: it listens on that port and prints it. If another run took the port in between, the office says it is busy: move on.
    let ok = null, r2 = null;
    for (let i = 0; i < 6; i++) {
      want = git.branchPort(branch);
      ok = startOffice(dir, env);
      r2 = await settle(ok);
      if (r2.listening || !/is busy/.test(ok.out())) break;
      await moveToFreeBranch();
    }
    try {
      assert.equal(r2.listening, true, ok.out());
      assert.match(ok.out(), new RegExp(`port ${want}[. ]`));
      assert.ok(ok.out().includes(branch), ok.out());
      assert.ok(ok.out().includes(`127.0.0.1:${want}/`), ok.out());
      const own = officeFiles(dir, want); // a branch port is never the default one, so the names carry the port (files.mjs)
      assert.equal(JSON.parse(fs.readFileSync(own.token, 'utf8')).port, want);
      // The office of npm start keeps the plain names: a branch office never writes them (#100).
      for (const f of Object.values(officeFiles(dir))) assert.ok(!fs.existsSync(f), `a branch office wrote ${path.basename(f)}`);
    } finally { await ok.stop(); }

    // Outside git: a clear stop, no port guess.
    const plain = path.join(tmp, 'plain');
    fs.cpSync(dir, plain, { recursive: true });
    fs.rmSync(path.join(plain, '.git'), { recursive: true, force: true });
    fs.rmSync(officeFiles(plain, want).token, { force: true });
    const nogit = startOffice(plain, env);
    const r3 = await settle(nogit);
    assert.equal(r3.listening, false, nogit.out());
    assert.equal(r3.code, 1);
    assert.match(nogit.out(), /not in a git repository/i);
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder may stay */ }
  }
});
