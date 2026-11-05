import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startupDir, entryPath, entryContent, state, status, access, enable, disable, change, ENTRY_NAME } from '../startup.mjs';

test('startup folder is under APPDATA; unknown without it', () => {
  assert.equal(startupDir('C:\\Users\\a\\AppData\\Roaming'), 'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
  assert.equal(startupDir(''), '');
  assert.equal(entryPath('C:\\S'), path.join('C:\\S', ENTRY_NAME)); // this platform's rules: the folder is a real local one
});

test('entry content: quoted title, quoted paths, CRLF, no kill', () => {
  const c = entryContent('E:\\agent office\\100%', 'C:\\Program Files\\nodejs\\node.exe');
  assert.match(c, /cd \/d "E:\\agent office\\100%%"/);
  assert.match(c, /start "Office" \/min "C:\\Program Files\\nodejs\\node\.exe" server\.mjs/);
  assert.ok(c.includes('\r\n') && !/[^\r]\n/.test(c));
  assert.doesNotMatch(c, /taskkill|\/IM/i);
});

test('enable and disable touch only the injected folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-startup-'));
  try {
    assert.equal(state(dir).enabled, false);
    assert.equal(enable(dir, 'E:\\x', 'C:\\node.exe').enabled, true);
    assert.equal(fs.readFileSync(path.join(dir, ENTRY_NAME), 'utf8'), entryContent('E:\\x', 'C:\\node.exe'));
    assert.equal(disable(dir).enabled, false);
    assert.equal(disable(dir).enabled, false); // already off: no error
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(state(''), { available: false, enabled: false, path: '' });
  assert.throws(() => enable('', 'r', 'n'));
});

// #108: the Startup entry is one global file, so only the office on the default port, in the main folder, may change it.
// Another office (OFFICE_PORT, npm run start:branch, a worktree) shows it read-only, with a reason.
function folder(kind) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-own-'));
  if (kind === 'main') fs.mkdirSync(path.join(d, '.git'));
  if (kind === 'worktree') fs.writeFileSync(path.join(d, '.git'), 'gitdir: /repo/.git/worktrees/x\n');
  return d; // 'plain': no .git (a download), counts as a main folder
}
const rm = (...d) => d.forEach((x) => fs.rmSync(x, { recursive: true, force: true }));

test('access: the default port in a main or plain folder may change the entry', () => {
  const main = folder('main'), plain = folder('plain');
  try {
    for (const root of [main, plain]) assert.deepEqual(access(root, 4317), { canChange: true, reason: '' });
    assert.equal(access(main).canChange, true, 'no port means the default port');
  } finally { rm(main, plain); }
});

test('access: another port or a worktree folder may not, and the reason says why', () => {
  const main = folder('main'), wt = folder('worktree');
  try {
    const port = access(main, 4392);
    assert.equal(port.canChange, false);
    assert.match(port.reason, /port 4317/);
    assert.match(port.reason, /4392/);
    const tree = access(wt, 4317);
    assert.equal(tree.canChange, false);
    assert.match(tree.reason, /main folder/);
    assert.equal(access(wt, 4392).canChange, false);
    for (const r of [port.reason, tree.reason]) assert.doesNotMatch(r, /please|oops|sorry|!/i);
  } finally { rm(main, wt); }
});

test('enable and disable refuse for an office that does not own the entry, and leave the entry as it is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-startup-'));
  const main = folder('main'), wt = folder('worktree');
  try {
    enable(dir, main, 'C:\\node.exe', 4317);
    const before = fs.readFileSync(path.join(dir, ENTRY_NAME), 'utf8');
    assert.throws(() => disable(dir, main, 4392), (e) => e.status === 403 && /port 4317/.test(e.message));
    assert.throws(() => disable(dir, wt, 4317), (e) => e.status === 403);
    assert.throws(() => enable(dir, wt, 'C:\\node.exe', 4317), (e) => e.status === 403);
    assert.throws(() => enable(dir, main, 'C:\\other.exe', 4392), (e) => e.status === 403);
    assert.equal(fs.readFileSync(path.join(dir, ENTRY_NAME), 'utf8'), before, 'entry untouched');
    assert.equal(disable(dir, main, 4317).enabled, false, 'the owner can still turn it off');
    assert.throws(() => enable(dir, wt, 'C:\\node.exe', 4317), (e) => e.status === 403);
    assert.deepEqual(fs.readdirSync(dir), [], 'no file from a refused enable');
  } finally { rm(dir, main, wt); }
});

test('status: the entry state plus whether this office may change it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-startup-'));
  const main = folder('main');
  try {
    enable(dir, main, 'C:\\node.exe', 4317);
    assert.deepEqual(status(dir, main, 4317), { available: true, enabled: true, path: entryPath(dir), canChange: true, reason: '' });
    const other = status(dir, main, 4392);
    assert.equal(other.enabled, true, 'a read-only office still shows the real state');
    assert.equal(other.canChange, false);
    assert.ok(other.reason);
    assert.deepEqual(status('', main, 4317), { available: false, enabled: false, path: '', canChange: true, reason: '' });
  } finally { rm(dir, main); }
});

// A .git file alone does not make a worktree: a --separate-git-dir clone and a submodule have one too, and each is a main folder.
test('access: only a linked worktree is read-only, not any folder with a .git file', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gitfile-'));
  const mk = (name, gitdirLine, makeGitdir) => {
    const d = path.join(base, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, '.git'), `${gitdirLine}\n`);
    if (makeGitdir) fs.mkdirSync(path.join(base, makeGitdir), { recursive: true });
    return d;
  };
  try {
    const separate = mk('separate', 'gitdir: ' + path.join(base, 'sep.git').split(path.sep).join('/'), 'sep.git');
    const sub = mk('sub', 'gitdir: ../parent/.git/modules/sub', 'parent/.git/modules/sub');
    const garbage = mk('garbage', 'not a gitdir line', '');
    const real = mk('real', 'gitdir: ../main/.git/worktrees/real', 'main/.git/worktrees/real');
    fs.writeFileSync(path.join(base, 'main/.git/worktrees/real/commondir'), '../..\n'); // what git writes for a linked worktree
    const gone = mk('gone', 'gitdir: ' + path.join(base, 'main2/.git/worktrees/gone').split(path.sep).join('/'), ''); // folder pruned: the path still says worktree
    for (const d of [separate, sub, garbage]) assert.equal(access(d, 4317).canChange, true, path.basename(d) + ' is a main folder');
    for (const d of [real, gone]) {
      const a = access(d, 4317);
      assert.equal(a.canChange, false, path.basename(d) + ' is a worktree');
      assert.match(a.reason, /worktree/);
    }
  } finally { rm(base); }
});

// The reply of POST /api/startup (server.mjs calls change): the page keeps the toggle only when canChange stays in it (#108).
test('change: the owner gets the entry state with canChange true, another office gets 403', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-startup-'));
  const main = folder('main'), wt = folder('worktree');
  try {
    const on = change(dir, main, process.execPath, 4317, true);
    assert.deepEqual(on, { available: true, enabled: true, path: entryPath(dir), canChange: true, reason: '' });
    assert.ok(fs.existsSync(entryPath(dir)));
    const off = change(dir, main, process.execPath, 4317, false);
    assert.deepEqual(off, { available: true, enabled: false, path: entryPath(dir), canChange: true, reason: '' });
    assert.equal(change(dir, main, process.execPath, 4317, undefined).enabled, false, 'anything but true turns it off');
    assert.throws(() => change(dir, main, process.execPath, 4392, true), (e) => e.status === 403);
    assert.throws(() => change(dir, wt, process.execPath, 4317, true), (e) => e.status === 403);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { rm(dir, main, wt); }
});
