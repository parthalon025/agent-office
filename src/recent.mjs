// Recent folders: the list of folders the user started from, kept in one form. One job: the folder rules of the list (no
// duplicates in any case or slash style, no agent room folders). Pure functions, no I/O, no timers: safe to import in tests.
import { win32 as path } from 'node:path'; // Windows-first, like place.mjs
import { normPath } from './place.mjs';

/** A folder as the office stores and shows it: normalized, no trailing separator, the case the user typed. */
function dirForm(p) {
  if (!p || !String(p).trim()) return '';
  const n = path.normalize(String(p));
  const root = path.parse(n).root;
  return n.length > root.length ? n.replace(/[\\/]+$/, '') : n;
}
// An agent room folder is an implementation detail, never a place to start from: <repo>.worktrees/<name> and anything in it
// (git.createWorktree, #69), and the .agent-office/worktrees folders of older runs. The folder that holds the rooms is plain.
const ROOM_DIR = /[\\/][^\\/]+\.worktrees[\\/][^\\/]+|[\\/]\.agent-office[\\/]worktrees([\\/]|$)/i;
const roomDir = (d) => ROOM_DIR.test(d);
/** The recent-folders list with dir first. One form per folder, no duplicates in any case or slash style, no agent rooms. */
export function addRecent(list, dir, max = 12) {
  const d = dirForm(dir);
  if (!d || roomDir(d)) return cleanRecent(list, max);
  return [d, ...cleanRecent(list, max + 1).filter((x) => normPath(x) !== normPath(d))].slice(0, max);
}
/** An older list, rewritten in the one form, without duplicates (first one wins) and without empty entries. */
export function cleanRecent(list, max = 12) {
  const seen = new Set(), out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const d = typeof x === 'string' ? dirForm(x) : '';
    if (!d || roomDir(d) || seen.has(normPath(d))) continue;
    seen.add(normPath(d)); out.push(d);
  }
  return out.slice(0, max);
}
/** The folders offered as one-click choices: first (the shown building), then the recent ones, each folder once. */
export function recentChoices(recent, first, max = 6) {
  return cleanRecent([first, ...(Array.isArray(recent) ? recent : [])], max);
}
