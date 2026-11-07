// Git helpers for Agent Office: one worktree per session, a changes view, and a pull request step.
// Every call runs `git` as a child process with an argument list (no shell), so folder and branch names
// can never be read as commands. The program itself comes from resolveExe, an absolute path.
//
// This file owns: worktrees (the room of an agent, the rooms and floors of a building), the changes view, the pull
// request, `locate` (repo, worktree and branch of a folder; `base` for an agent worktree), `layout`, `relayout` and
// `refreshEntry`, `roomNameOf`, `defaultBranch` and `staleFloors`, and the runner that starts git and gh.
// - Raw execFile of git outside this file is not allowed (test/spawn-safety.test.mjs). Every git call gets
//   GIT_HARDENING before its subcommand (test/git-hardening.test.mjs); createPr refuses when the repository config
//   sets a filter driver (assertNoFilters).
// - Every program the office runs in a room goes through the record (git() or recorded()), or a removal cannot wait
//   for it. Do not call run() or execFile with a room as cwd. A lookup in a room that is being removed waits for the
//   removal.
// - locate tries a passing git failure 3 times before it answers null (#98). Null means "not in git" and the office
//   acts on it, so one slow git call must never give it. The office start reads its recent folders and its branch
//   with locateOrKeep, which answers KEEP after the last try. A lasting failure (not a repository, a folder git
//   refuses for its owner, no git) is null at once and is not tried again. `run` keeps only the last 3 lines of git's
//   message, so the dubious-ownership check also matches safe.directory. A recent folder that still got KEEP after its
//   3 tries is asked again every 30 s (campus.mjs, with the room-list refresh, never twice at once), and
//   OFFICE_PORT=branch stops with "git did not give the branch of this folder" (server.mjs), so a busy start never
//   reads a timeout as "not in a git repository".
// - Rooms and floors: the office never removes a room by itself (the one exception is discardNew, a fork that did not
//   start). deleteFloor refuses while an agent room sits on the floor. floorCandidates (GET /api/branches) is
//   `branches` without the agent branches. staleFloors serves /api/floor/stale and /api/floor/cleanup; both read git's
//   own room list and never force. defaultBranch is never cleaned up.
// - A worktree made inside an agent worktree keeps the first base. When the base branch is gone, layout and locate
//   report no base. Two worktrees on one branch need `git worktree add --force`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { inside } from './risk.mjs';
import { resolveExe } from './launch.mjs';

// Programs start through launch.mjs (resolveExe: an absolute path, never a bare name).
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

// ---------- a folder and its removal take turns ----------
// On Windows a folder cannot be deleted while a process has it as its current folder, and git makes the work tree its
// current folder. `git worktree remove` tries again for about 70 ms, then fails: "failed to delete '<room>': Permission
// denied". The office's own git calls in a room (a session's place lookups, which its last hooks start just before a close,
// the changes view, a pull request push) must not be running then. So a removal (removeFolder) waits for the git calls
// that run in the folder or below it, and a git call that starts there meanwhile waits until the removal is over: it then
// finds the folder gone, or still there when the removal failed. The key is the folder in any spelling, as for perRepo.
const folderKey = (p) => { const r = path.resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
const isBelow = (k, top) => inside(top, k); // the one folder-inside-folder check (risk.mjs)
const gitCalls = new Map(); // folder key -> the git calls that run in it (their promises)
const removals = new Map(); // folder key -> a promise that settles when the removal of that folder is over
// Every program the office runs in a room goes through here (git, gh), or a removal cannot wait for it.
function recorded(cmd, args, cwd, timeout, env) {
  const k = folderKey(cwd);
  for (const [top, over] of removals) if (isBelow(k, top)) return over.then(() => recorded(cmd, args, cwd, timeout, env));
  // From the check to here nothing waits, so a removal that starts later sees this call.
  const call = run(cmd, args, cwd, timeout, env);
  const calls = gitCalls.get(k) || new Set();
  gitCalls.set(k, calls.add(call));
  const done = () => { calls.delete(call); if (!calls.size && gitCalls.get(k) === calls) gitCalls.delete(k); };
  call.then(done, done);
  return call;
}
const git = (args, cwd, timeout, env) => recorded('git', gitArgs(args), cwd, timeout, env);
/**
 * Runs fn, the removal of the folder `root`, once no git call of the office runs in it. One removal of a folder at a time.
 * fn runs its git in `repo`, so `root` must not hold the repository: those calls would wait for this removal, which waits for fn.
 */
async function removeFolder(root, repo, fn) {
  const k = folderKey(root);
  if (isBelow(folderKey(repo), k)) throw new Error('The main folder of the repository cannot be removed.');
  const before = removals.get(k);
  let over;
  const mine = new Promise((resolve) => { over = resolve; });
  removals.set(k, mine); // at once: git calls that start in the folder from now on wait
  try {
    await before;
    await Promise.allSettled([...gitCalls].filter(([f]) => isBelow(f, k)).flatMap(([, calls]) => [...calls]));
    return await fn();
  } finally {
    if (removals.get(k) === mine) removals.delete(k);
    over();
  }
}
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

// A git failure that asking again does not change: git says the folder is not a repository; git refuses a repository
// that another user owns ("detected dubious ownership"; `run` keeps only the last lines of git's message, and they name
// safe.directory); or there is no git to start (resolveExe found none, or the program is gone: ENOENT). Git is asked for
// English, because this check reads its message.
const LASTING_GIT_FAILURE = /not a git repository|dubious ownership|unsafe repository|safe\.directory|was not found on PATH|is installed as a script|\bENOENT\b/i;

// The cause of a lasting git failure, from its message: 'no-git', 'untrusted' (git refuses the folder) or 'not-repo'.
function lastingCause(message) {
  if (/was not found on PATH|is installed as a script|\bENOENT\b/i.test(message)) return 'no-git';
  if (/dubious ownership|unsafe repository|safe\.directory/i.test(message)) return 'untrusted';
  return 'not-repo';
}

// Where a folder sits in git, or KEEP when git still failed for a passing reason after `attempts` tries. See locate and locateOrKeep.
async function placeOrKeep(cwd, { exec = git, exists = fs.existsSync, wait = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3, why } = {}) {
  for (let i = 1; ; i++) try {
    const [top, branch, common] = (await exec(['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD', '--path-format=absolute', '--git-common-dir'], cwd, 8000, ENGLISH)).trim().split(/\r?\n/);
    const dir = path.resolve(cwd, common);
    const repo = path.basename(dir).toLowerCase() === '.git' ? path.dirname(dir) : dir;
    const out = { repo: path.normalize(repo), root: path.normalize(top), branch: branch === 'HEAD' ? 'detached' : branch };
    // A failed base read is not a reason to lose the location: the room sits on its own floor, and the log says why.
    // A base branch that is gone (deleted, renamed) is no base either. A folder that is gone meanwhile (its room was
    // removed between the calls) has no place: null, as when it was gone at the first call.
    try {
      const base = await baseOf(cwd, out.branch);
      if (base && await branchExists(cwd, base)) out.base = base;
    } catch (e2) {
      if (!exists(cwd)) return null;
      console.warn(`Agent Office: could not read the base branch of ${out.branch}: ${e2.message}`);
    }
    return out;
  } catch (e) {
    if (!exists(cwd)) { if (why) why.cause = 'gone'; return null; }
    if (LASTING_GIT_FAILURE.test(String(e && e.message))) { if (why) why.cause = lastingCause(String(e.message)); return null; }
    if (i >= attempts) return KEEP;
    await wait(250 * i);
  }
}

/**
 * Where a folder sits in git: { repo, root, branch } and, for an agent worktree, `base` (the branch it was made from),
 * or null when it is not in a repository, the folder is gone, git refuses it (dubious ownership) or there is no git. A failure that is only passing (git passed its time limit on a
 * loaded machine, a lock) is tried again, `attempts` times in all, because null is an answer the office acts on (#98);
 * after the last try the answer is null too. A lookup in a room that is being removed waits for the removal first, then finds the
 * folder gone (null), so it can take longer than its own tries. `deps` (`exec`, `exists`, `wait`, `attempts`) are for tests.
 */
export async function locate(cwd, deps) {
  const g = await placeOrKeep(cwd, deps);
  return g === KEEP ? null : g;
}

/**
 * `locate` for the office start, which must not read a passing git failure as "outside git": it picks the branch port
 * and makes the recent folders buildings. The same tries, but after the last one the answer is `KEEP` (git kept passing
 * its time limit on a busy computer, or the repository has no commit yet): the caller asks again later. `null` is final:
 * not a repository, the folder is gone, git refuses it, or there is no git. Same `deps` as `locate`.
 */
export async function locateOrKeep(cwd, deps) {
  return placeOrKeep(cwd, deps);
}

/**
 * `locateOrKeep` for the office start (#132): a place or KEEP. A lasting failure throws with its real cause in place of a
 * bare null: git is not installed, git does not trust the folder (safe.directory), the folder is gone, or it is not in a
 * git repository. Same `deps` as `locate`.
 */
export async function startPlace(cwd, deps) {
  const why = {};
  const loc = await placeOrKeep(cwd, { ...deps, why });
  if (loc) return loc;
  const text = {
    'no-git': 'git is not installed, or git.exe is not on PATH. Install Git for Windows.',
    untrusted: 'git does not trust this folder (safe.directory). Run: git config --global --add safe.directory <this folder>',
    gone: 'The folder is gone.',
  }[why.cause];
  throw new Error(text || 'This folder is not in a git repository, so it has no branch to take a port from.');
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

// Where rooms of floors (createFloor, createRoom) stand. OFFICE_ROOMS_DIR moves it: the test runner points it at a temp folder
// (test/fixtures/temp-leaks.mjs), so a test never writes into the real home folder.
const WORKTREE_ROOT = process.env.OFFICE_ROOMS_DIR ? path.resolve(process.env.OFFICE_ROOMS_DIR) : path.join(os.homedir(), '.agent-office', 'worktrees');
const nameSlug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'session';

/**
 * Makes a room for one agent: a branch `agent/<name>-<id>` from the current branch, in the folder
 * `<repo>.worktrees/<name>` next to the main repository (`<name>-<id>` when that folder is taken). Returns where
 * the agent works. `base` is the floor the room sits on: the current branch, or the base of the agent worktree
 * it was made in. It is '' on a detached HEAD, and the room then keeps a floor of its own.
 * The office never removes the folder by itself (removeWorktree runs only after a click and a confirm).
 */
// One task at a time per repository (review M5): two agent rooms opened at once wrote the repository's config together
// (`git config --local` for the base, `worktree add -b`), and git refused one with "could not lock config file". The key
// is the repository folder in any spelling (case, slashes, a trailing slash). A failed task does not stop the next one;
// tasks of other repositories do not wait. Returns what fn gives back.
// keyedQueue(keyOf) makes one such queue: (key, fn) -> what fn gives back. server.mjs keeps its own for due schedules.
export function keyedQueue(keyOf = (k) => k) {
  const queues = new Map();
  return (key, fn) => {
    const k = keyOf(key);
    const run = (queues.get(k) || Promise.resolve()).then(() => fn());
    const tail = run.catch(() => {});
    queues.set(k, tail);
    tail.then(() => { if (queues.get(k) === tail) queues.delete(k); });
    return run;
  };
}
export const perRepo = keyedQueue(folderKey);

export async function createWorktree(cwd, name) {
  // The main repository is common to all its worktrees, so it is the key of the queue.
  const main = (await locate(cwd))?.repo || (await repoTop(cwd));
  const wt = await perRepo(main, () => makeWorktree(cwd, name));
  minted.add(wt);
  return wt;
}
// The one exception to "the office never removes a worktree by itself" (CLAUDE.md Safety rules): a caller that made a
// worktree and could not start its session in it (a fork that ended before init, or whose open threw: server.mjs failedFork and forkSession) removes it again. It
// never held work. discardNew takes only the object createWorktree returned in this process, once: a copy (a past record,
// a session's worktree field, JSON) is refused, so no other worktree can be removed this way. Not forced: a change in it,
// or a commit on its branch, keeps it.
const minted = new WeakSet();
export async function discardNew(wt) {
  if (!wt || typeof wt !== 'object' || !minted.has(wt)) throw new Error('The office removes only a worktree it made in this call.');
  minted.delete(wt);
  return removeWorktree(wt, false);
}
async function makeWorktree(cwd, name) {
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
  await removeFolder(root, repo, () => git(['worktree', 'remove', ...(force ? ['--force'] : []), root], repo, 60000))
    .catch((e) => { throw new Error(/contains modified or untracked files|uncommitted/i.test(e.message) ? 'The worktree has uncommitted changes. Remove it anyway to discard them.' : e.message); });
  let branchKept = false;
  // A branch delete rewrites the repository config (its branch section): one config writer at a time (perRepo, M5).
  try { await perRepo(await queueKey(repo), () => git(['branch', force ? '-D' : '-d', branch], repo)); } catch { branchKept = true; }
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
  const url = (await recorded('gh', ['pr', 'create', '--fill', '--head', branch], cwd, 120000)).trim().split('\n').pop();
  return { url };
}

/** One read-only `gh` call in a repository folder (changes.mjs readArgs: `pr list`). Argument list only, recorded like every room program. */
export function ghRun(args, cwd) {
  if (args[0] !== 'pr' || args[1] !== 'list') throw new Error('ghRun only lists pull requests.');
  return recorded('gh', args, cwd, 30000, { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
}
/** Merges a pull request with `gh` (changes.mjs mergeArgs). Only called after the user's confirm. */
export async function mergePr(cwd, args) {
  if (args[0] !== 'pr' || args[1] !== 'merge') throw new Error('mergePr only merges pull requests.');
  await recorded('gh', args, cwd, 120000, { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
  return { ok: true };
}

// ---------- floors (branches) and rooms (worktrees) ----------
// The office draws a repository as a building, a branch as a floor and a worktree as a room.

/** The worktrees of a repository: each one's folder, branch, and whether it is the main folder. */
// deps (readBases, readBranches) are for tests.
export async function layout(repo, { readBases = bases, readBranches = branches } = {}) {
  const out = await git(['worktree', 'list', '--porcelain'], repo, 15000, ENGLISH); // relayout reads the error text
  const list = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { root: path.normalize(/^[A-Za-z]:$/.test(line.slice(9)) ? line.slice(9) + path.sep : line.slice(9)), branch: 'detached', main: list.length === 0, prunable: false }; list.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
    else if (cur && line === 'bare') cur.bare = true;
  }
  // A base is reported only while its branch is there. When the branch list cannot be read (a timeout, a lock), the base the
  // config names stays: a passing failure must not move a room to a floor of its own for one refresh. live null: unknown.
  let base = new Map(), live = null;
  try { base = await readBases(repo); }
  catch (e) { console.warn(`Agent Office: could not read the base branches of ${repo}: ${e.message}`); }
  if (base.size) {
    try { live = new Set(await readBranches(repo, Infinity)); }
    catch (e) { console.warn(`Agent Office: could not read the branches of ${repo}, so the bases are not checked: ${e.message}`); }
  }
  for (const w of list) if (base.has(w.branch) && (!live || live.has(base.get(w.branch)))) w.base = base.get(w.branch);
  return list.filter((w) => !w.bare && !w.prunable);
}

/** What `relayout` and `locateOrKeep` answer when git failed for a passing reason: change nothing, ask again later. */
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
/** Claims a new room folder under the shared worktree folder with a plain mkdir, which fails when the folder exists, so two
 *  repositories (each has its own perRepo queue) never take one name. The caller lets git fill the empty folder and gives it
 *  back (`addAt`) when git fails. */
function roomFolder(repo, branch, name = '') {
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });
  // Git lists a room by its real path (8.3 short names, links and junctions resolved) and removeRoom matches rooms by that text,
  // so a room is made under the real path of the rooms folder (a CI temp folder is an 8.3 short path).
  const base = fs.realpathSync.native(WORKTREE_ROOT);
  const n = roomNameOf(name);
  const claim = (dir) => {
    try { fs.mkdirSync(dir); return true; }
    catch (e) { if (e.code === 'EEXIST') return false; throw new Error(`The office cannot make the folder ${dir} (${e.code || e.message}).`); }
  };
  if (!n) {
    for (let i = 0; i < 5; i++) {
      const dir = path.join(base, `${path.basename(repo)}-${slugOf(branch)}-${crypto.randomBytes(2).toString('hex')}`);
      if (claim(dir)) return dir;
    }
    throw new Error('The office could not find a free folder for the room. Try again.');
  }
  for (let i = 1; i < 100; i++) {
    const dir = path.join(base, i === 1 ? n : `${n}-${i}`);
    if (claim(dir)) return dir;
  }
  throw new Error('Too many rooms with that name. Pick another name.');
}
/** `git worktree add` into a folder `roomFolder` claimed; on a git failure the claimed folder goes, so its name is free again. */
async function addAt(repo, root, args) {
  try { await git(['worktree', 'add', ...args(root)], repo, 120000); }
  catch (e) { fs.rmSync(root, { recursive: true, force: true }); throw e; }
}

/** The queue key of a repository: its main folder, as for createWorktree, so a worktree path and the repository share one turn. */
export const queueKey = async (repo) => (await locate(repo))?.repo || repo;

/** New floor: a new branch from `from` (default HEAD), checked out in a new worktree (its first room).
 *  It takes its turn in perRepo (#119): the folder is picked, and git writes the config, one task at a time. */
export async function createFloor(repo, branch, from = '', roomName = '') {
  if (!BRANCH_RE.test(branch)) throw new Error('Use letters, digits, dots, dashes and slashes for the branch name.');
  return perRepo(await queueKey(repo), () => addFloor(repo, branch, from, roomName));
}
async function addFloor(repo, branch, from, roomName) {
  try { await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo); throw new Error(`The branch ${branch} exists. Add a room to its floor instead.`); }
  catch (e) { if (/exists/.test(e.message)) throw e; }
  const root = roomFolder(repo, branch, roomName);
  await addAt(repo, root, (r) => ['-b', branch, r, from || 'HEAD']);
  return { root, branch };
}

/** New room on a floor: one more worktree with the branch checked out. Git refuses a second
 *  worktree for a branch unless --force, so a floor that has rooms gets one with --force. It takes its turn in
 *  perRepo (#119), so the "has rooms" check and the folder name are not stale when git runs. */
export async function createRoom(repo, branch, roomName = '') {
  if (!BRANCH_RE.test(branch)) throw new Error('Use letters, digits, dots, dashes and slashes for the branch name.');
  return perRepo(await queueKey(repo), () => addRoom(repo, branch, roomName));
}
async function addRoom(repo, branch, roomName) {
  const taken = (await layout(repo)).some((w) => w.branch === branch);
  const root = roomFolder(repo, branch, roomName);
  await addAt(repo, root, (r) => [...(taken ? ['--force'] : []), r, branch]);
  return { root, branch, shared: taken };
}

/** Removes a room (a worktree that is not the main folder). The branch, and so the floor, stays. The room takes no new git
 *  call while it is removed (removeFolder). The request is checked before that turn starts. */
export async function removeRoom(repo, root, force = false) {
  if (!String(root || '').trim()) throw new Error('Name the room to remove.');
  // Read and check the room first: a bad request must not make other git calls wait.
  const w = (await layout(repo)).find((x) => path.normalize(x.root).toLowerCase() === path.normalize(root).toLowerCase());
  if (!w) throw new Error('That room is gone already.');
  if (w.main) throw new Error('The main folder of the repository cannot be removed.');
  return removeFolder(w.root, repo, async () => {
    await git(['worktree', 'remove', ...(force ? ['--force'] : []), w.root], repo, 60000)
      .catch((e) => { throw new Error(/contains modified or untracked files|uncommitted/i.test(e.message) ? 'The room has uncommitted changes. Remove it anyway to discard them.' : e.message); });
    return { removed: true };
  });
}

/** Deletes a floor: removes its rooms (not the main folder) and deletes the branch. */
export async function deleteFloor(repo, branch, force = false) {
  const wts = await layout(repo);
  if (wts.some((w) => w.main && w.branch === branch)) throw new Error(`The main folder has ${branch} checked out. Switch it to another branch first.`);
  // The office removes a room only after a click on that room. An agent room that sits on this floor is not part of it.
  const agents = wts.filter((w) => w.base === branch && w.branch !== branch);
  if (agents.length) throw new Error(`${agents.length === 1 ? 'An agent room sits' : agents.length + ' agent rooms sit'} on the floor ${branch}. Remove ${agents.length === 1 ? 'it' : 'them'} first.`);
  for (const w of wts.filter((x) => x.branch === branch)) await removeRoom(repo, w.root, force);
  await perRepo(await queueKey(repo), () => git(['branch', force ? '-D' : '-d', branch], repo))
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
