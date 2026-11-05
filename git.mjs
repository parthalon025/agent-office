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

/**
 * The folder a helper starts in when it works on no folder of its own (the walkToClaude PowerShell, icacls, the ACL
 * reader, taskkill, `claude --version`): %SystemRoot% on Windows, else the root of the file system. Never the office
 * folder, which a helper would otherwise inherit: on Windows a running process keeps its current folder busy, so nobody
 * can remove or rename the folder until the process ends (#78). Work in a session folder passes that folder instead.
 */
export function helperCwd(env = process.env) {
  if (process.platform !== 'win32') return '/';
  const root = String(envGet(env, 'SystemRoot') || envGet(env, 'windir') || '');
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  return /^[A-Za-z]:[\\/]/.test(root) && isDir(root) ? root : path.parse(os.homedir()).root;
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
      if (isFile(f)) throw new Error(`${name} is installed as a script (${f}). The office starts programs without a shell, so it needs ${name}.exe on PATH.`);
    }
  }
  throw new Error(`${name} was not found on PATH.`);
}

// A failed program rejects with its last stderr lines, and keeps the exit code (err.code: a number when the program
// exited, null when it was killed) and killed, so gitNoMatch can tell git's "nothing matches" (code 1) from a failure.
function run(cmd, args, cwd, timeout = 30000, env) {
  return new Promise((resolve, reject) => {
    execFile(resolveExe(cmd), args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, out, stderr) => {
      if (err) return reject(Object.assign(new Error((String(stderr || '').trim() || err.message).split('\n').slice(-3).join(' ')), { code: err.code ?? null, killed: !!err.killed }));
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
const git = (args, cwd, timeout, env) => run('git', gitArgs(args), cwd, timeout, env);
// Git words its errors in the user's language where it ships translations. Code that reads an error message asks for English.
const ENGLISH = { LC_ALL: 'C', LANGUAGE: 'C' };

export async function repoTop(cwd) {
  try { return (await git(['rev-parse', '--show-toplevel'], cwd)).trim(); } catch { throw new Error('That folder is not in a git repository, so it cannot get a worktree.'); }
}

// The base branch of an agent worktree: the branch it was made from. The office writes it into the repository
// config as branch.<agent branch>.officebase when it makes the worktree (`git branch -d` removes it with the branch).
// place.mjs puts the room of such a worktree on the floor of its base branch. Nothing else reads it.
const BASE_VAR = 'officebase';
const baseKey = (branch) => `branch.${branch}.${BASE_VAR}`;
/** `git config --get` and `--get-regexp` exit with code 1 and no output when nothing matches. Any other failure
 *  (a kill, a timeout, a lock, a bad config) has another code, or none, and is a real error. */
export const gitNoMatch = (e) => e?.code === 1;

// The office makes only agent/<name>-<id> branches with a base, so no other branch costs a config read.
const hasBase = (branch) => String(branch || '').startsWith('agent/');
const branchExists = (cwd, branch) => git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd, 8000).then(() => true, (e) => { if (gitNoMatch(e)) return false; throw e; });

/** The base branch of one branch, or '' when it has none. */
async function baseOf(cwd, branch) {
  if (!hasBase(branch)) return '';
  try { return (await git(['config', '--local', '--get', baseKey(branch)], cwd, 8000)).trim(); }
  catch (e) { if (gitNoMatch(e)) return ''; throw e; }
}

/** Where a folder sits in git: the main repository, this worktree's top folder, its branch and, for an agent
 *  worktree, `base` (the branch it was made from). Null outside git. */
export async function locate(cwd) {
  try {
    const [top, branch, common] = (await git(['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD', '--path-format=absolute', '--git-common-dir'], cwd, 8000)).trim().split(/\r?\n/);
    const dir = path.resolve(cwd, common);
    const repo = path.basename(dir).toLowerCase() === '.git' ? path.dirname(dir) : dir;
    const out = { repo: path.normalize(repo), root: path.normalize(top), branch: branch === 'HEAD' ? 'detached' : branch };
    // A failed base read is not a reason to lose the location: the room sits on its own floor, and the log says why.
    // A base branch that is gone (deleted, renamed) is no base either.
    try {
      const base = await baseOf(cwd, out.branch);
      if (base && await branchExists(cwd, base)) out.base = base;
    } catch (e) { console.warn(`Agent Office: could not read the base branch of ${out.branch}: ${e.message}`); }
    return out;
  } catch { return null; }
}

/** Every agent branch's base in one call: branch -> base branch. */
async function bases(repo) {
  const map = new Map();
  let out = '';
  try { out = await git(['config', '--local', '--get-regexp', `^branch\\..*\\.${BASE_VAR}$`], repo, 8000); }
  catch (e) { if (!gitNoMatch(e)) throw e; }
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^branch\\.(.+)\\.${BASE_VAR} (.+)$`));
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

// ---------- ports ----------
// Each checkout gets its own port for browser tests, so worktrees never share one and never touch the owner's office
// on 4317. The port comes from the branch name alone (FNV-1a, 32 bit, over the UTF-8 bytes), so it is the same on every
// machine and every run. The range is reserved: 4330 to 4399. Two names can share a port (70 ports); the second office
// then stops with a message and does not move to another port.
export const BRANCH_PORT_MIN = 4330;
export const BRANCH_PORT_MAX = 4399;
export function branchPort(name) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(String(name), 'utf8')) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return BRANCH_PORT_MIN + (h % (BRANCH_PORT_MAX - BRANCH_PORT_MIN + 1));
}
/** The name a checkout's port comes from: its branch, or the worktree folder name when HEAD is detached. `loc` is what `locate` returns. */
export function checkoutName(loc) {
  if (!loc) throw new Error('This folder is not in a git repository, so it has no branch to take a port from.');
  // Windows rules on every host, so Linux CI reads a Windows folder name the same way
  return loc.branch === 'detached' ? path.win32.basename(loc.root) : loc.branch;
}

const WORKTREE_ROOT = path.join(os.homedir(), '.agent-office', 'worktrees');
const nameSlug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'session';

/**
 * Makes a room for one agent: a branch `agent/<name>-<id>` from the current branch, in the folder
 * `<repo>.worktrees/<name>` next to the main repository (`<name>-<id>` when that folder is taken). Returns where
 * the agent works. `base` is the floor the room sits on: the current branch, or the base of the agent worktree
 * it was made in. It is '' on a detached HEAD, and the room then keeps a floor of its own.
 * The office never removes the folder by itself (removeWorktree runs only after a click and a confirm).
 */
export async function createWorktree(cwd, name) {
  const top = await repoTop(cwd);
  const rel = path.relative(top, path.resolve(cwd));
  const main = (await locate(cwd))?.repo || top;
  const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], top, 8000)).trim();
  // A failed config read stops the open: a wrong base would put the room on the wrong floor with no warning.
  const base = current === 'HEAD' ? '' : (await baseOf(top, current)) || current;
  const slug = nameSlug(name);
  const id = crypto.randomBytes(2).toString('hex');
  const branch = `agent/${slug}-${id}`;
  const parent = path.join(path.dirname(main), `${path.basename(main)}.worktrees`);
  try { fs.mkdirSync(parent, { recursive: true }); }
  catch (e) { throw new Error(`The office cannot make the folder ${parent} (${e.code || e.message}). Check that you can write next to the repository, or use the folder as it is.`); }
  // Claim the folder with a plain mkdir (it fails when the folder exists, so two opens never take one name), then
  // let git fill the empty folder.
  const claim = (dir) => {
    try { fs.mkdirSync(dir); return true; }
    catch (e) { if (e.code === 'EEXIST') return false; throw new Error(`The office cannot make the folder ${dir} (${e.code || e.message}).`); }
  };
  let root = path.join(parent, slug);
  if (!claim(root)) { root = path.join(parent, `${slug}-${id}`); if (!claim(root)) throw new Error(`The folder ${root} exists. Try again.`); }
  try { await git(['worktree', 'add', '-b', branch, root, 'HEAD'], top, 120000); }
  catch (e) { fs.rmSync(root, { recursive: true, force: true }); throw e; }
  if (base) {
    try { await git(['config', '--local', baseKey(branch), base], top, 8000); }
    catch (e) {
      // No half-made room: without its base the new room would sit on a floor of its own.
      await git(['worktree', 'remove', '--force', root], top, 60000).catch(() => {});
      await git(['branch', '-D', branch], top, 8000).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
      throw new Error(`The office could not save the base branch of the new room: ${e.message}`);
    }
  }
  return { root, branch, base, repo: main, path: rel && !rel.startsWith('..') ? path.join(root, rel) : root };
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
  catch (e) { if (!gitNoMatch(e)) throw e; } // exit code 1 with no output = none set
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
  const out = await git(['worktree', 'list', '--porcelain'], repo, 15000, ENGLISH); // relayout reads the error text
  const list = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { root: path.normalize(/^[A-Za-z]:$/.test(line.slice(9)) ? line.slice(9) + path.sep : line.slice(9)), branch: 'detached', main: list.length === 0, prunable: false }; list.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
    else if (cur && line === 'bare') cur.bare = true;
  }
  let base = new Map(), live = null;
  try { base = await bases(repo); if (base.size) live = new Set(await branches(repo, Infinity)); }
  catch (e) { console.warn(`Agent Office: could not read the base branches of ${repo}: ${e.message}`); }
  for (const w of list) if (base.has(w.branch) && live.has(base.get(w.branch))) w.base = base.get(w.branch);
  return list.filter((w) => !w.bare && !w.prunable);
}

/** What `relayout` answers when git failed for a passing reason: change nothing. */
export const KEEP = Symbol('keep');

/**
 * The worktrees of a known repository, read again. When git fails for a passing reason (a timeout, a lock,
 * a busy disk) the answer is `KEEP`: the caller leaves what it has. Returns `null` only when the repository is
 * really gone: its folder is missing, or git says the folder is not a repository. `deps` (`list`, `exists`) are for tests.
 */
export async function relayout(repo, { list = layout, exists = fs.existsSync } = {}) {
  try { return await list(repo); } catch (e) {
    if (!exists(repo) || /not a git repository/i.test(String(e && e.message))) return null;
    return KEEP;
  }
}

// Refreshes of one repository overlap: the 30 s timer, `addRepo` and every room or floor action each start one.
// The order they START in is the order of their facts, so a slower older read must not undo a newer one.
const refreshSeq = new WeakMap(); // entry -> { started, applied }

/**
 * Reads the worktrees of a repository entry (`{ path, worktrees }`) again and sets `entry.worktrees`.
 * Answers `'changed'`, `'same'`, `'gone'` (the repository is gone: the caller drops the entry), or `'stale'`
 * (a refresh that started later already settled: nothing is written). A failed read changes nothing: it carries
 * no fact, so it neither writes nor blocks an older read that is still running. `deps` are `relayout`'s.
 */
export async function refreshEntry(entry, deps) {
  const seq = refreshSeq.get(entry) || { started: 0, applied: 0 };
  refreshSeq.set(entry, seq);
  const mine = ++seq.started;
  const res = await relayout(entry.path, deps);
  if (res === KEEP) return 'same';
  if (mine < seq.applied) return 'stale';
  seq.applied = mine;
  if (res === null) return 'gone';
  if (JSON.stringify(res) === JSON.stringify(entry.worktrees)) return 'same';
  entry.worktrees = res;
  return 'changed';
}

/** The files git tracks in a folder (relative, forward slashes), at most 20000. */
export async function files(root) {
  return (await git(['ls-files'], root, 20000)).split(/\r?\n/).filter(Boolean).slice(0, 20000);
}

/** Local branches, the most recent commit first. */
export async function branches(repo, limit = 200) {
  return (await git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], repo, 15000)).split(/\r?\n/).filter(Boolean).slice(0, limit);
}

/** Branches that can become a floor: all of them but the agent branches the office made (they have a base and
 *  sit on the floor of that base; a finished agent's branch stays in git but is not a floor of its own). */
export async function floorCandidates(repo) {
  const agents = await bases(repo);
  return (await branches(repo)).filter((b) => !agents.has(b));
}

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,100}(?<![./])$/;
/** Letters with accents become their plain letter (Ünïcode -> Unicode); a few that do not decompose get a spelled form. */
const FOLD = { 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'ł': 'l', 'Ł': 'L', 'þ': 'th', 'Þ': 'Th', 'ı': 'i' };
const fold = (t) => String(t).normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[ßæÆœŒøØđĐðÐłŁþÞı]/g, (c) => FOLD[c]);
const slugOf = (t) => fold(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'branch';
/** A room name as a folder name: letters, digits, dots and dashes. The folder name is the room name in the office. */
export function roomNameOf(name) {
  const n = fold(String(name || '').trim()).replace(/[^A-Za-z0-9._]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (String(name || '').trim() && !n) throw new Error('Use letters or digits in the room name.');
  const cut = n.slice(0, 40).replace(/[-.]+$/, ''); // Windows drops a trailing dot from a folder name
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cut)) throw new Error('Windows reserves that name. Pick another room name.');
  return cut;
}
function roomFolder(repo, branch, name = '') {
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });
  const n = roomNameOf(name);
  if (!n) return path.join(WORKTREE_ROOT, `${path.basename(repo)}-${slugOf(branch)}-${crypto.randomBytes(2).toString('hex')}`);
  for (let i = 1; i < 100; i++) {
    const dir = path.join(WORKTREE_ROOT, i === 1 ? n : `${n}-${i}`);
    if (!fs.existsSync(dir)) return dir;
  }
  throw new Error('Too many rooms with that name. Pick another name.');
}

/** New floor: a new branch from `from` (default HEAD), checked out in a new worktree (its first room). */
export async function createFloor(repo, branch, from = '', roomName = '') {
  if (!BRANCH_RE.test(branch)) throw new Error('Use letters, digits, dots, dashes and slashes for the branch name.');
  try { await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo); throw new Error(`The branch ${branch} exists. Add a room to its floor instead.`); }
  catch (e) { if (/exists/.test(e.message)) throw e; }
  const root = roomFolder(repo, branch, roomName);
  await git(['worktree', 'add', '-b', branch, root, from || 'HEAD'], repo, 120000);
  return { root, branch };
}

/** New room on a floor: one more worktree with the branch checked out. Git refuses a second
 *  worktree for a branch unless --force, so a floor that has rooms gets one with --force. */
export async function createRoom(repo, branch, roomName = '') {
  if (!BRANCH_RE.test(branch)) throw new Error('Use letters, digits, dots, dashes and slashes for the branch name.');
  const taken = (await layout(repo)).some((w) => w.branch === branch);
  const root = roomFolder(repo, branch, roomName);
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
  // The office removes a room only after a click on that room. An agent room that sits on this floor is not part of it.
  const agents = wts.filter((w) => w.base === branch && w.branch !== branch);
  if (agents.length) throw new Error(`${agents.length === 1 ? 'An agent room sits' : agents.length + ' agent rooms sit'} on the floor ${branch}. Remove ${agents.length === 1 ? 'it' : 'them'} first.`);
  for (const w of wts.filter((x) => x.branch === branch)) await removeRoom(repo, w.root, force);
  await git(['branch', force ? '-D' : '-d', branch], repo)
    .catch((e) => { throw new Error(/not fully merged/i.test(e.message) ? `The branch ${branch} has commits that are not merged. Delete it anyway to lose them.` : e.message); });
  return { deleted: true };
}

/** The default branch: origin/HEAD when there is one, else main or master when it exists. */
export async function defaultBranch(repo) {
  const head = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo, 15000).catch(() => '')).trim().replace(/^origin\//, '');
  if (head) return head;
  for (const b of ['main', 'master']) if (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], repo, 15000).then(() => true, () => false)) return b;
  return '';
}

/** A floor younger than this is not "unused" yet: its room may wait for its first session. One hour;
 *  OFFICE_FLOOR_MIN_AGE_MS changes it (the route tests set 0). */
const AGE_ENV = process.env.OFFICE_FLOOR_MIN_AGE_MS;
const FLOOR_MIN_AGE_MS = AGE_ENV && Number.isFinite(Number(AGE_ENV)) ? Number(AGE_ENV) : 3600000;

/** Floors nobody needs: not the default branch or the main folder's branch, merged into it, every room clean
 *  and older than minAgeMs. Deleting them loses nothing. Returns [{ branch, rooms }] (rooms = worktrees). */
export async function staleFloors(repo, { minAgeMs = FLOOR_MIN_AGE_MS } = {}) {
  const wts = await layout(repo);
  const main = wts.find((w) => w.main);
  if (!main || main.branch === 'detached') return [];
  const merged = new Set((await git(['branch', '--merged', main.branch, '--format=%(refname:short)'], repo, 15000)).split(/\r?\n/).filter(Boolean));
  const keep = await defaultBranch(repo);
  const out = [];
  // An agent room (base set, #69) sits on the floor of its base: its branch is no floor, and a floor with an agent room on
  // it is in use (deleteFloor refuses it until the agent room is removed).
  const agentOf = (w) => !!w.base && w.base !== w.branch;
  for (const b of new Set(wts.filter((w) => !agentOf(w)).map((w) => w.branch))) {
    if (b === main.branch || b === keep || b === 'detached' || !merged.has(b)) continue;
    if (wts.some((w) => agentOf(w) && w.base === b)) continue;
    const rooms = wts.filter((w) => w.branch === b);
    if (rooms.some((w) => w.main)) continue;
    const young = rooms.some((w) => { try { return Date.now() - fs.statSync(w.root).birthtimeMs < minAgeMs; } catch { return true; } });
    if (young) continue;
    let clean = true;
    for (const w of rooms) if ((await git(['status', '--porcelain'], w.root, 15000).catch(() => 'x')).trim()) { clean = false; break; }
    if (clean) out.push({ branch: b, rooms: rooms.length });
  }
  return out;
}
