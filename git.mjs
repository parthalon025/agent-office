// Git helpers for Agent Office: one worktree per session, a changes view, and a pull request step.
// Every call runs `git` as a child process with an argument list (no shell), so folder and branch names
// can never be read as commands.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function run(cmd, args, cwd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout }, (err, out, stderr) => {
      if (err) return reject(new Error((String(stderr || '').trim() || err.message).split('\n').slice(-3).join(' ')));
      resolve(String(out));
    });
  });
}
const git = (args, cwd, timeout) => run('git', args, cwd, timeout);

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
  try { out.stat = (await git(['diff', 'HEAD', '--shortstat'], cwd)).trim(); } catch { /* no commits yet */ }
  try {
    const diff = await git(['diff', 'HEAD', '--no-color', '--unified=3'], cwd);
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

/** Commits what is there, pushes the branch and opens a pull request with `gh`. Only called after the user confirms. */
export async function createPr(cwd, branch, title) {
  const dirty = (await git(['status', '--porcelain'], cwd)).trim();
  if (dirty) {
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
