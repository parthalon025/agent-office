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
  const out = { branch: '', ahead: 0, files: [], stat: '', diff: '', truncated: false };
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
