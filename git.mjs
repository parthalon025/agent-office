// Git helpers for Agent Office: one worktree per session, a changes view, and a pull request step.
// Every call runs `git` as a child process with an argument list (no shell), so folder and branch names
// can never be read as commands. The program itself comes from resolveExe, an absolute path.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- programs ----------
// On Windows a bare program name ('git') is looked up in the child's folder before PATH, unless the
// office's own environment has NoDefaultCurrentDirectoryInExePath. A git.exe planted in a session folder
// would then run as the user with no click. So every program the office starts (git, gh, claude, cmd.exe,
// powershell.exe, taskkill, icacls) starts from the absolute path that resolveExe gives, never from a bare name.
const SYSTEM32 = { cmd: 'cmd.exe', powershell: 'WindowsPowerShell\\v1.0\\powershell.exe', taskkill: 'taskkill.exe', icacls: 'icacls.exe' };
const exeCache = new Map();
// Environment names are not case-sensitive on Windows; a plain object (a test's env) is.
const envGet = (env, key) => env[key] ?? env[Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase())];
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
function isRunnable(p, win) {
  if (!isFile(p)) return false;
  if (win) return true; // Windows has no execute bit; the extension decides (.com or .exe only)
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/**
 * The absolute path of a program. Windows tools (cmd, powershell, taskkill, icacls) come from %SystemRoot%\System32.
 * Other names come from the absolute folders of PATH, in order; relative entries ('.', '') and the current
 * folder are never searched. On Windows only .com and .exe count: a .cmd, .bat or .ps1 shim cannot start
 * without a shell, and the office never starts programs through a shell. An absolute path is checked and
 * returned as is. Throws when nothing is found, or for a relative path. Cached per name for process.env.
 */
export function resolveExe(name, env = process.env) {
  const own = env === process.env;
  const hit = own ? exeCache.get(name) : null;
  if (hit && isFile(hit)) return hit;
  const exe = findExe(String(name ?? ''), env, process.platform === 'win32');
  if (own) exeCache.set(name, exe);
  return exe;
}

function findExe(name, env, win) {
  const p = win ? path.win32 : path.posix;
  // Drive or UNC paths only on Windows: '\dir' and 'C:dir' depend on the current drive or folder.
  const absolute = (x) => (win ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(x) : p.isAbsolute(x));
  if (!name || name.includes('\0')) throw new Error('A program name is required.');
  if (absolute(name)) { if (isRunnable(name, win)) return name; throw new Error(`Program not found: ${name}`); }
  if (/[\\/]/.test(name) || (win && name.includes(':'))) throw new Error(`Give a program name or an absolute path, not ${name}.`);
  if (win) {
    const sys = SYSTEM32[name.toLowerCase().replace(/\.exe$/, '')];
    if (sys) {
      const root = String(envGet(env, 'SystemRoot') || envGet(env, 'windir') || '');
      const exe = absolute(root) ? p.join(root, 'System32', sys) : '';
      if (exe && isFile(exe)) return exe;
      throw new Error(`${name} was not found in the Windows System32 folder (SystemRoot is ${root || 'not set'}).`);
    }
  }
  const dirs = String(envGet(env, 'PATH') || '').split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(absolute);
  const exts = !win || /\.(com|exe)$/i.test(name) ? [''] : ['.com', '.exe'];
  for (const d of dirs) for (const x of exts) { const f = p.join(d, name + x); if (isRunnable(f, win)) return f; }
  if (win) {
    for (const d of dirs) for (const x of ['.cmd', '.bat', '.ps1']) {
      const f = p.join(d, name + x);
      // code and file: callers name the file in their own words without reading this message (providers' programPath).
      if (isFile(f)) throw Object.assign(new Error(`${name} is installed as a script (${f}). The office starts programs without a shell, so it needs ${name}.exe on PATH.`), { code: 'SCRIPT_INSTALL', file: f });
    }
  }
  throw new Error(`${name} was not found on PATH.`);
}

function run(cmd, args, cwd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(resolveExe(cmd), args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout }, (err, out, stderr) => {
      if (err) return reject(new Error((String(stderr || '').trim() || err.message).split('\n').slice(-3).join(' ')));
      resolve(String(out));
    });
  });
}
// An untrusted agent can write .git/config, .git/hooks and .gitattributes in the repos the office runs git in.
// These options go before every git subcommand so none of those files can start a program of the agent's choice:
// no fsmonitor command, no hooks (post-checkout, pre-commit, pre-push), no pager, no external diff, no ext:: remote.
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
export const GIT_HARDENING = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NULL_DEVICE}`, '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'protocol.ext.allow=never'];
// Read-only subcommands also skip the optional index refresh, so a look never writes to the repository.
const READ_ONLY = new Set(['status', 'diff', 'log', 'ls-files']);
/** The full argument list for a git call: hardening, then --no-optional-locks for read-only commands, then the command. */
export const gitArgs = (args) => [...GIT_HARDENING, ...(READ_ONLY.has(args[0]) ? ['--no-optional-locks'] : []), ...args];
const git = (args, cwd, timeout) => run('git', gitArgs(args), cwd, timeout);

export async function repoTop(cwd) {
  try { return (await git(['rev-parse', '--show-toplevel'], cwd)).trim(); } catch { throw new Error('That folder is not in a git repository, so it cannot get a worktree.'); }
}

/** Where a folder sits in git: the main repository, this worktree's top folder and its branch. Null outside git. */
export async function locate(cwd) {
  try {
    const [top, branch, common] = (await git(['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD', '--path-format=absolute', '--git-common-dir'], cwd, 8000)).trim().split(/\r?\n/);
    const dir = path.resolve(cwd, common);
    const repo = path.basename(dir).toLowerCase() === '.git' ? path.dirname(dir) : dir;
    return { repo: path.normalize(repo), root: path.normalize(top), branch: branch === 'HEAD' ? 'detached' : branch };
  } catch { return null; }
}

const WORKTREE_ROOT = path.join(os.homedir(), '.agent-office', 'worktrees');

/** Creates a branch `office/<name>-<id>` in its own folder and returns where Claude should work. */
export async function createWorktree(cwd, name) {
  const top = await repoTop(cwd);
  const rel = path.relative(top, path.resolve(cwd));
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'session';
  const id = crypto.randomBytes(2).toString('hex');
  const branch = `office/${slug}-${id}`;
  const root = path.join(WORKTREE_ROOT, `${path.basename(top)}-${slug}-${id}`);
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });
  await git(['worktree', 'add', '-b', branch, root, 'HEAD'], top, 120000);
  return { root, branch, repo: top, path: rel && !rel.startsWith('..') ? path.join(root, rel) : root };
}

const STATUS_WORD = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'new' };

/** Branch, changed files and a unified diff for the folder a session works in. */
export async function changes(cwd) {
  const out = { branch: '', ahead: 0, files: [], stat: '', diff: '', truncated: false, commits: [] };
  // The last commits of this folder's branch, newest first, for the commit timeline.
  try {
    const log = await git(['log', '-8', '--format=%x1e%h%x1f%s%x1f%cr', '--shortstat'], cwd);
    out.commits = log.split('\x1e').filter((x) => x.trim()).map((rec) => {
      const [head, ...rest] = rec.split('\n');
      const [id, label, time] = head.split('\x1f');
      const files = Number(((rest.join(' ').match(/(\d+) files? changed/) || [])[1]) || 0);
      return { id, label: label || '(no message)', time: time || '', files };
    });
  } catch { /* no commits yet */ }
  const status = (await git(['status', '--porcelain=v1', '-b'], cwd)).split('\n').filter(Boolean);
  const head = status.shift() || '';
  out.branch = (head.match(/^## ([^.\s]+)/) || [])[1] || '';
  out.ahead = Number((head.match(/ahead (\d+)/) || [])[1] || 0);
  out.files = status.map((l) => ({ code: l.slice(0, 2).trim() || '?', word: STATUS_WORD[(l.slice(0, 2).trim() || '?')[0]] || 'changed', path: l.slice(3) }));
  try { out.stat = (await git(['diff', 'HEAD', '--no-ext-diff', '--shortstat'], cwd)).trim(); } catch { /* no commits yet */ }
  try {
    const diff = await git(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3'], cwd);
    out.truncated = diff.length > 120000;
    out.diff = diff.slice(0, 120000);
  } catch { /* no commits yet */ }
  return out;
}

/** Removes a worktree folder. Refuses when it has uncommitted changes unless `force` is set. */
export async function removeWorktree({ root, repo, branch }, force = false) {
  if (!root || !repo) throw new Error('This session has no worktree.');
  await git(['worktree', 'remove', ...(force ? ['--force'] : []), root], repo, 60000)
    .catch((e) => { throw new Error(/contains modified or untracked files|uncommitted/i.test(e.message) ? 'The worktree has uncommitted changes. Remove it anyway to discard them.' : e.message); });
  let branchKept = false;
  try { await git(['branch', force ? '-D' : '-d', branch], repo); } catch { branchKept = true; }
  return { removed: true, branchKept };
}

/**
 * Refuses when the repository config defines a filter driver (filter.<name>.clean, smudge or process).
 * `git add` and `git commit` run it for any path that .gitattributes names, and an agent can write both.
 * Filters from the user's own global or system config (git-lfs) are trusted and do not count.
 */
export async function assertNoFilters(cwd) {
  let out = '';
  try { out = await git(['config', '--show-scope', '--get-regexp', '^filter\\.'], cwd, 8000); }
  catch (e) { if (!/^Command failed/.test(e.message)) throw e; } // exit code 1 with no output = none set
  const names = new Set();
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [scope, rest = ''] = line.split('\t');
    if (scope === 'global' || scope === 'system') continue;
    names.add((rest.match(/^filter\.(.+)\.[^.\s]+(?:\s|$)/) || [])[1] || rest.split(/\s/)[0]);
  }
  if (names.size) throw new Error(`This repository sets the git filter ${[...names].join(', ')}. A filter runs a program when git adds files. The office commits nothing. Remove the filter, or commit by hand.`);
}

/** Commits what is there, pushes the branch and opens a pull request with `gh`. Only called after the user confirms. */
export async function createPr(cwd, branch, title) {
  const dirty = (await git(['status', '--porcelain'], cwd)).trim();
  if (dirty) {
    await assertNoFilters(cwd);
    await git(['add', '-A'], cwd);
    await git(['commit', '-m', `Agent Office: ${title}`], cwd);
  }
  await git(['push', '-u', 'origin', branch], cwd, 120000);
  const url = (await run('gh', ['pr', 'create', '--fill', '--head', branch], cwd, 120000)).trim().split('\n').pop();
  return { url };
}

// ---------- floors (branches) and rooms (worktrees) ----------
// The office draws a repository as a building, a branch as a floor and a worktree as a room.

/** The worktrees of a repository: each one's folder, branch, and whether it is the main folder. */
export async function layout(repo) {
  const out = await git(['worktree', 'list', '--porcelain'], repo, 15000);
  const list = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { root: path.normalize(/^[A-Za-z]:$/.test(line.slice(9)) ? line.slice(9) + path.sep : line.slice(9)), branch: 'detached', main: list.length === 0, prunable: false }; list.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
    else if (cur && line === 'bare') cur.bare = true;
  }
  return list.filter((w) => !w.bare && !w.prunable);
}

/** The files git tracks in a folder (relative, forward slashes), at most 20000. */
export async function files(root) {
  return (await git(['ls-files'], root, 20000)).split(/\r?\n/).filter(Boolean).slice(0, 20000);
}

/** Local branches, the most recent commit first. */
export async function branches(repo) {
  return (await git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], repo, 15000)).split(/\r?\n/).filter(Boolean).slice(0, 200);
}

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,100}(?<![./])$/;
const slugOf = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'branch';
function roomFolder(repo, branch) {
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });
  return path.join(WORKTREE_ROOT, `${path.basename(repo)}-${slugOf(branch)}-${crypto.randomBytes(2).toString('hex')}`);
}

/** New floor: a new branch from `from` (default HEAD), checked out in a new worktree (its first room). */
export async function createFloor(repo, branch, from = '') {
  if (!BRANCH_RE.test(branch)) throw new Error('Use letters, digits, dots, dashes and slashes for the branch name.');
  try { await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo); throw new Error(`The branch ${branch} exists. Add a room to its floor instead.`); }
  catch (e) { if (/exists/.test(e.message)) throw e; }
  const root = roomFolder(repo, branch);
  await git(['worktree', 'add', '-b', branch, root, from || 'HEAD'], repo, 120000);
  return { root, branch };
}

/** New room on a floor: one more worktree with the branch checked out. Git refuses a second
 *  worktree for a branch unless --force, so a floor that has rooms gets one with --force. */
export async function createRoom(repo, branch) {
  if (!BRANCH_RE.test(branch)) throw new Error('Use letters, digits, dots, dashes and slashes for the branch name.');
  const taken = (await layout(repo)).some((w) => w.branch === branch);
  const root = roomFolder(repo, branch);
  await git(['worktree', 'add', ...(taken ? ['--force'] : []), root, branch], repo, 120000);
  return { root, branch, shared: taken };
}

/** Removes a room (a worktree that is not the main folder). The branch, and so the floor, stays. */
export async function removeRoom(repo, root, force = false) {
  const w = (await layout(repo)).find((x) => path.normalize(x.root).toLowerCase() === path.normalize(root).toLowerCase());
  if (!w) throw new Error('That room is gone already.');
  if (w.main) throw new Error('The main folder of the repository cannot be removed.');
  await git(['worktree', 'remove', ...(force ? ['--force'] : []), w.root], repo, 60000)
    .catch((e) => { throw new Error(/contains modified or untracked files|uncommitted/i.test(e.message) ? 'The room has uncommitted changes. Remove it anyway to discard them.' : e.message); });
  return { removed: true };
}

/** Deletes a floor: removes its rooms (not the main folder) and deletes the branch. */
export async function deleteFloor(repo, branch, force = false) {
  const wts = await layout(repo);
  if (wts.some((w) => w.main && w.branch === branch)) throw new Error(`The main folder has ${branch} checked out. Switch it to another branch first.`);
  for (const w of wts.filter((x) => x.branch === branch)) await removeRoom(repo, w.root, force);
  await git(['branch', force ? '-D' : '-d', branch], repo)
    .catch((e) => { throw new Error(/not fully merged/i.test(e.message) ? `The branch ${branch} has commits that are not merged. Delete it anyway to lose them.` : e.message); });
  return { deleted: true };
}
