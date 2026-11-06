// Git hardening (audit #27, H2): an agent can write .git/config, .git/hooks and .gitattributes in the repos the
// office runs git in. git.mjs puts GIT_HARDENING before every subcommand so those files start nothing.
// Each test sets a harmless marker command (it writes one file in a temp folder), runs the office's git path,
// and checks the marker is absent. A control run with plain git proves the marker command would have run.
// Offline: throwaway repos in os.tmpdir, no network, no paid call. Own file: this is a distinct concern from
// spawn-safety.test.mjs (which is about which program starts, not what git does once it runs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as git from '../src/git.mjs';
import * as launch from '../src/launch.mjs';

const GIT = launch.resolveExe('git');
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

function scratch() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hard-')));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
/** Plain git, no hardening: what a hostile config would get from an unprotected caller. */
const plain = (cwd, ...a) => execFileSync(GIT, a, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
/** Git with the office's argument list, run directly so a test can use commands git.mjs has no function for. */
const hardened = (cwd, ...a) => plain(cwd, ...git.gitArgs(a));
const slash = (p) => p.split(path.sep).join('/');
/** A sh command (git runs these through its own sh) that writes the marker file. */
const markerCmd = (marker) => `echo x > '${slash(marker)}'`;

function makeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  plain(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'one\n');
  plain(repo, 'add', 'f.txt');
  plain(repo, ...IDENT, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'one\ntwo\n'); // a change, so diff has something to show
  return repo;
}

test('gitArgs puts the hardening first, and --no-optional-locks only on read-only commands', () => {
  const a = git.gitArgs(['status', '--porcelain']);
  assert.deepEqual(a.slice(0, git.GIT_HARDENING.length), git.GIT_HARDENING);
  assert.deepEqual(a.slice(git.GIT_HARDENING.length), ['--no-optional-locks', 'status', '--porcelain']);
  for (const c of ['diff', 'log', 'ls-files']) assert.ok(git.gitArgs([c]).includes('--no-optional-locks'), c);
  for (const c of ['add', 'commit', 'push', 'worktree', 'branch', 'rev-parse', 'config']) assert.ok(!git.gitArgs([c]).includes('--no-optional-locks'), c);
  const joined = git.GIT_HARDENING.join(' ');
  for (const opt of ['core.fsmonitor=false', 'core.pager=cat', 'diff.external=', 'protocol.ext.allow=never']) assert.ok(joined.includes(opt), opt);
  assert.match(joined, /core\.hooksPath=(NUL|\/dev\/null)/);
});

test('every hardening option is accepted by this git and normal commands still work', () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    assert.match(hardened(repo, 'status', '--porcelain', '-b'), /## .*\n M f\.txt/);
    assert.match(hardened(repo, 'diff', 'HEAD', '--no-ext-diff', '--shortstat'), /1 file changed/);
    assert.equal(hardened(repo, 'rev-parse', '--show-toplevel').trim().toLowerCase(), slash(repo).toLowerCase());
    assert.match(hardened(repo, 'log', '-1', '--format=%s'), /init/);
    assert.match(hardened(repo, 'ls-files'), /f\.txt/);
  } finally { s.done(); }
});

test('changes() does not run core.fsmonitor from the repository config', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    const marker = path.join(s.dir, 'fsmonitor.marker');
    plain(repo, 'config', 'core.fsmonitor', markerCmd(marker));
    const ch = await git.changes(repo);
    assert.ok(ch.files.some((f) => f.path === 'f.txt'), 'changes() still works');
    assert.ok(!fs.existsSync(marker), 'the fsmonitor command did not run');
    try { plain(repo, 'status', '--porcelain'); } catch { /* the command prints nothing; only the marker counts */ }
    assert.ok(fs.existsSync(marker), 'control: plain git status runs the fsmonitor command');
  } finally { s.done(); }
});

test('changes() does not run diff.external from the repository config', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    const marker = path.join(s.dir, 'diff.marker');
    plain(repo, 'config', 'diff.external', markerCmd(marker));
    const ch = await git.changes(repo);
    assert.match(ch.diff, /\+two/, 'the built-in diff text comes back');
    assert.ok(!fs.existsSync(marker), 'the external diff command did not run');
    try { plain(repo, 'diff', 'HEAD'); } catch { /* ignore */ }
    assert.ok(fs.existsSync(marker), 'control: plain git diff runs the external diff command');
  } finally { s.done(); }
});

test('changes() does not run a textconv program from the repository config', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    const marker = path.join(s.dir, 'textconv.marker');
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=evil\n');
    plain(repo, 'config', 'diff.evil.textconv', markerCmd(marker) + '; cat');
    const ch = await git.changes(repo);
    assert.match(ch.diff, /\+two/);
    assert.ok(!fs.existsSync(marker), 'the textconv command did not run');
    try { plain(repo, 'diff', 'HEAD'); } catch { /* ignore */ }
    assert.ok(fs.existsSync(marker), 'control: plain git diff runs the textconv command');
  } finally { s.done(); }
});

test('createWorktree does not run the post-checkout hook, and still makes the worktree', async () => {
  const s = scratch();
  let made = null;
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    const marker = path.join(s.dir, 'hook.marker');
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, `#!/bin/sh\n${markerCmd(marker)}\n`, { mode: 0o755 });
    made = await git.createWorktree(repo, 'hardening test');
    assert.ok(fs.existsSync(path.join(made.root, 'f.txt')), 'the worktree has its files');
    assert.ok(!fs.existsSync(marker), 'the post-checkout hook did not run');
    plain(repo, 'worktree', 'add', '-q', path.join(s.dir, 'control-wt'), 'HEAD');
    assert.ok(fs.existsSync(marker), 'control: plain git worktree add runs the post-checkout hook');
  } finally {
    if (made) await git.removeWorktree(made, true).catch(() => {});
    s.done();
  }
});

test('a pre-commit hook does not run under the office git arguments', () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    const marker = path.join(s.dir, 'precommit.marker');
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${markerCmd(marker)}\n`, { mode: 0o755 });
    hardened(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'no hook');
    assert.ok(!fs.existsSync(marker), 'the pre-commit hook did not run');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'three\n');
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'control');
    assert.ok(fs.existsSync(marker), 'control: plain git commit runs the pre-commit hook');
  } finally { s.done(); }
});

test('assertNoFilters refuses a repository filter and names it, and passes without one', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    await git.assertNoFilters(repo);
    plain(repo, 'config', 'filter.evil.clean', markerCmd(path.join(s.dir, 'x')));
    await assert.rejects(git.assertNoFilters(repo), (e) => /filter evil\b/.test(e.message) && !/please|oops/i.test(e.message));
  } finally { s.done(); }
});

test('createPr refuses when a filter is set, and commits and stages nothing', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    const marker = path.join(s.dir, 'filter.marker');
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=x\n');
    plain(repo, 'config', 'filter.x.clean', markerCmd(marker) + '; cat');
    const head = plain(repo, 'rev-parse', 'HEAD').trim();
    await assert.rejects(git.createPr(repo, 'main', 'test'), /filter x\b/);
    assert.equal(plain(repo, 'rev-parse', 'HEAD').trim(), head, 'no commit');
    assert.equal(plain(repo, 'diff', '--cached', '--name-only').trim(), '', 'nothing staged');
    assert.ok(!fs.existsSync(marker), 'the filter did not run');
  } finally { s.done(); }
});

// ---------- agent worktrees (#69): branch agent/<name>-<id> from the current branch, folder <repo>.worktrees/<name> ----------
const same = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

test('createWorktree makes agent/<name>-<id> from the current branch, in <repo>.worktrees/<name> next to the repository', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    plain(repo, 'checkout', '-q', '-b', 'dev');
    const made = await git.createWorktree(repo, 'Fix login!');
    assert.match(made.branch, /^agent\/fix-login-[0-9a-f]{4}$/);
    assert.equal(made.base, 'dev');
    assert.ok(same(made.root, path.join(s.dir, 'repo.worktrees', 'fix-login')), made.root);
    assert.ok(fs.existsSync(path.join(made.root, 'f.txt')));
    assert.equal(plain(made.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), made.branch);
    // locate and layout both report the base branch, and only for the agent worktree
    const g = await git.locate(made.root);
    assert.equal(g.branch, made.branch);
    assert.equal(g.base, 'dev');
    assert.ok(same(g.repo, repo), 'the building is the main repository');
    const lay = await git.layout(repo);
    assert.equal(lay.find((w) => w.main).base, undefined);
    assert.equal(lay.find((w) => !w.main).base, 'dev');
    assert.equal((await git.locate(repo)).base, undefined);
  } finally { s.done(); }
});

test('two agents with one name get two folders; a worktree made inside an agent worktree keeps the first base', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    const a = await git.createWorktree(repo, 'helper');
    const b = await git.createWorktree(repo, 'helper');
    assert.ok(!same(a.root, b.root));
    assert.ok(same(path.dirname(b.root), path.join(s.dir, 'repo.worktrees')));
    assert.notEqual(a.branch, b.branch);
    const c = await git.createWorktree(a.path, 'nested');
    assert.equal(c.base, a.base, 'the floor stays the base of the first agent');
    assert.ok(same(path.dirname(c.root), path.join(s.dir, 'repo.worktrees')), 'next to the main repository, not the agent folder');
  } finally { s.done(); }
});

test('createWorktree from a detached HEAD has no base branch, and refuses outside git', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    plain(repo, 'checkout', '-q', '--detach');
    const made = await git.createWorktree(repo, 'loose');
    assert.equal(made.base, '');
    assert.equal((await git.locate(made.root)).base, undefined);
    await assert.rejects(git.createWorktree(s.dir, 'x'), /not in a git repository/);
  } finally { s.done(); }
});

test('deleteFloor refuses while an agent room sits on the floor, and deletes it after the room is removed', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    plain(repo, 'branch', 'side');
    const made = await git.createWorktree(repo, 'agent one'); // from the main folder's branch
    plain(repo, 'config', `branch.${made.branch}.officebase`, 'side'); // as if it was made on `side`
    await assert.rejects(git.deleteFloor(repo, 'side'), /agent room/i);
    await git.removeRoom(repo, made.root, true);
    assert.deepEqual(await git.deleteFloor(repo, 'side', true), { deleted: true });
  } finally { s.done(); }
});

// ---------- review fixes for #69 ----------
test('gitNoMatch: only exit code 1 means "no such key"; a kill, a timeout or a bare "Command failed" does not', () => {
  assert.equal(git.gitNoMatch(Object.assign(new Error('x'), { code: 1 })), true);
  assert.equal(git.gitNoMatch(Object.assign(new Error('Command failed: git config'), { code: 128 })), false);
  assert.equal(git.gitNoMatch(Object.assign(new Error('Command failed: git config'), { code: null, killed: true })), false);
  assert.equal(git.gitNoMatch(new Error('Command failed: git config')), false);
});

test('createWorktree cleans up the new room when the base cannot be saved, and the open fails with that error', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    fs.writeFileSync(path.join(repo, '.git', 'config.lock'), ''); // git config cannot write while this exists
    await assert.rejects(git.createWorktree(repo, 'locked'), /lock/i);
    fs.rmSync(path.join(repo, '.git', 'config.lock'));
    assert.equal(plain(repo, 'branch', '--list', 'agent/*').trim(), '', 'no branch left behind');
    assert.equal((await git.layout(repo)).length, 1, 'no worktree left behind');
    assert.ok(!fs.existsSync(path.join(s.dir, 'repo.worktrees', 'locked')), 'no folder left behind');
  } finally { s.done(); }
});

test('createWorktree says in plain words when the folder next to the repository cannot be made', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    fs.writeFileSync(path.join(s.dir, 'repo.worktrees'), 'a file, not a folder');
    await assert.rejects(git.createWorktree(repo, 'x'), /The office cannot make the folder .*repo\.worktrees/);
  } finally { s.done(); }
});

test('two agents that ask for one folder name at once get two folders (the folder is claimed, not checked)', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    const [a, b, c] = await Promise.all([git.createWorktree(repo, 'same'), git.createWorktree(repo, 'same'), git.createWorktree(repo, 'same')]);
    assert.equal(new Set([a, b, c].map((x) => path.normalize(x.root).toLowerCase())).size, 3);
    assert.equal((await git.layout(repo)).length, 4);
  } finally { s.done(); }
});

test('a base branch that is gone (deleted or renamed) is no base: the room keeps its own floor', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    plain(repo, 'branch', 'side');
    const made = await git.createWorktree(repo, 'orphan');
    plain(repo, 'config', `branch.${made.branch}.officebase`, 'side');
    assert.equal((await git.locate(made.root)).base, 'side');
    plain(repo, 'branch', '-m', 'side', 'side2');
    assert.equal((await git.locate(made.root)).base, undefined, 'locate');
    assert.equal((await git.layout(repo)).find((w) => w.branch === made.branch).base, undefined, 'layout');
  } finally { s.done(); }
});

test('floorCandidates() leaves out agent branches, so they do not pile up as floors without a room', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, ...IDENT, 'commit', '-q', '-a', '-m', 'two');
    plain(repo, 'branch', 'side');
    const made = await git.createWorktree(repo, 'gone soon');
    await git.removeRoom(repo, made.root, true);
    assert.ok(plain(repo, 'branch', '--list', made.branch).trim(), 'the branch is still there');
    const list = await git.floorCandidates(repo);
    assert.ok(list.includes('side'));
    assert.ok(!list.includes(made.branch), list.join(','));
  } finally { s.done(); }
});

// #70 review, found while merging main: git's "nothing matches" (exit code 1) must reach gitNoMatch. run() dropped the exit
// code, so bases() threw for every repository without agent branches and GET /api/branches answered 500.
test('a repository with no agent branch: floorCandidates lists its branches, and layout reads no error', async () => {
  const s = scratch();
  try {
    const repo = makeRepo(s.dir);
    plain(repo, 'branch', 'side');
    const warned = [], warn = console.warn;
    console.warn = (m) => warned.push(String(m));
    try {
      assert.ok((await git.floorCandidates(repo)).includes('side'));
      assert.equal((await git.layout(repo)).length, 1);
    } finally { console.warn = warn; }
    assert.deepEqual(warned, [], 'no "could not read the base branches" warning');
  } finally { s.done(); }
});
