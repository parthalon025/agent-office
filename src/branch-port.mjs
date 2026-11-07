// Branch port module (#170): the port sequence of a checkout, apart from the git module. Pure apart from the injected isFree / isOwn.
// Interface: branchPorts, branchPort, pickBranchPort, checkoutName (and the range constants). The start-up code in server.mjs
// reads it for OFFICE_PORT=branch (range 4330-4399). branchPorts(name, count) is the fixed sequence (12 by default),
// branchPort(name) its first, checkoutName(loc) the branch or, on a detached HEAD, the worktree folder name.
// Tested in test/branch-port.test.mjs.
import path from 'node:path';

// ---------- ports ----------
// Each checkout gets its own port for browser tests, so worktrees never share one and never touch the owner's office
// on 4317. The first port comes from the branch name alone (FNV-1a, 32 bit, over the UTF-8 bytes), so it is the same on
// every machine and every run. The range is reserved: 4330 to 4399. Two names can share a first port (70 ports), so a
// name has a short fixed sequence: its first port, then the next ones in order (wrapping at the end of the range). The
// office takes the first port of the sequence that is free and says which one it took. It never leaves the sequence,
// never starts when an office of the same checkout holds any port of it (a checkout never runs two), and never takes over a port that is busy (#96, #106).
export const BRANCH_PORT_MIN = 4330;
export const BRANCH_PORT_MAX = 4399;
export const BRANCH_PORT_TRIES = 12;
const BRANCH_PORT_SPAN = BRANCH_PORT_MAX - BRANCH_PORT_MIN + 1;
/** The fixed sequence of ports of a name: `count` ports, the first one is `branchPort(name)`. */
export function branchPorts(name, count = BRANCH_PORT_TRIES) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(String(name), 'utf8')) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  const n = Math.max(1, Math.min(BRANCH_PORT_SPAN, Math.trunc(count) || 1));
  return Array.from({ length: n }, (_, i) => BRANCH_PORT_MIN + ((h + i) % BRANCH_PORT_SPAN));
}
export const branchPort = (name) => branchPorts(name, 1)[0];
/**
 * Picks the port of a name: the first one of its sequence that is free. `isFree(port)` and `isOwn(port)` are injected
 * (async). Every busy port of the sequence is asked, not only those before the first free one: an office of this
 * checkout may hold a later port (it started while an earlier port was busy), and a second office of one checkout is
 * never started. Such a port ends the search: `{ port: null, own: <port>, busy }`. When every port is busy:
 * `{ port: null, busy }`. Else `{ port, busy }`, where `busy` lists the ports before `port` that were skipped.
 */
export async function pickBranchPort(name, { isFree, isOwn }, count = BRANCH_PORT_TRIES) {
  const busy = [];
  let port = null;
  let skipped = 0;
  for (const p of branchPorts(name, count)) {
    if (await isFree(p)) { if (port === null) { port = p; skipped = busy.length; } continue; }
    busy.push(p);
    if (await isOwn(p)) return { port: null, own: p, busy: port === null ? busy : busy.slice(0, skipped) };
  }
  return port === null ? { port: null, busy } : { port, busy: busy.slice(0, skipped) };
}
/** The name a checkout's port comes from: its branch, or the worktree folder name when HEAD is detached. `loc` is what `locate` returns. */
export function checkoutName(loc) {
  if (!loc) throw new Error('This folder is not in a git repository, so it has no branch to take a port from.');
  // Windows rules on every host, so Linux CI reads a Windows folder name the same way
  return loc.branch === 'detached' ? path.win32.basename(loc.root) : loc.branch;
}
