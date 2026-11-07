// Temp folder guard for the tests. `npm test` loads this file in every test process (node --import).
// It notes each folder the process makes with fs.mkdtempSync, fs.mkdtemp or fs.promises.mkdtemp in the system temp folder. When the
// process ends, every folder that still exists is a leak: the guard removes it, names it on stderr
// and fails the process. A test that makes a folder must remove it in a finally block (issue #124), or, for a rig that many tests
// share, in the file's after() list (test/floors.test.mjs and test/acp-provider.test.mjs do). A process that ends with a temp
// folder still there has it removed, named on stderr, and fails.
// The guard wraps fs.mkdtempSync, fs.mkdtemp and fs.promises.mkdtemp and syncs the ESM named exports, so a named import is caught
// too. To count leaks by hand, run the suite with a private TEMP and read the folder after.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const made = new Set();
const tmp = path.resolve(os.tmpdir());

// A folder made with a Buffer prefix, or outside the temp folder, is not ours to judge.
const note = (dir) => {
  if (typeof dir === 'string' && path.resolve(dir).startsWith(tmp + path.sep)) made.add(path.resolve(dir));
  return dir;
};

// Every way to make one: fs.mkdtempSync, the callback fs.mkdtemp and fs.promises.mkdtemp (the same object as node:fs/promises).
const realSync = fs.mkdtempSync;
const realCallback = fs.mkdtemp;
const realPromise = fs.promises.mkdtemp;
fs.mkdtempSync = function mkdtempSync(...args) { return note(realSync.apply(this, args)); };
fs.mkdtemp = function mkdtemp(...args) {
  const done = args.at(-1);
  if (typeof done === 'function') args[args.length - 1] = (err, dir, ...more) => done(err, err ? dir : note(dir), ...more);
  return realCallback.apply(this, args);
};
fs.promises.mkdtemp = async function mkdtemp(...args) { return note(await realPromise.apply(this, args)); };
// `import { mkdtempSync } from 'node:fs'` reads the ESM named exports, which are copies until they are synced.
syncBuiltinESMExports();

// Rooms of floors (git.mjs WORKTREE_ROOT) stand in the real home folder by default, and a test left 147 there. Every test process gets
// its own empty rooms folder (OFFICE_ROOMS_DIR, inherited by the offices it starts) and must leave it empty. As a second line, the
// guard also fails the process when a new entry shows up under the real ~/.agent-office, wherever it came from.
const realHome = path.join(os.homedir(), '.agent-office');
const listing = (d) => { try { return new Set(fs.readdirSync(d)); } catch { return new Set(); } };
const homeBefore = new Map([[realHome, listing(realHome)], [path.join(realHome, 'worktrees'), listing(path.join(realHome, 'worktrees'))]]);
const roomsDir = realSync(path.join(tmp, 'ao-rooms-'));
process.env.OFFICE_ROOMS_DIR = roomsDir;

process.on('exit', () => {
  const roomsLeft = listing(roomsDir);
  try { fs.rmSync(roomsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* reported below */ }
  const homeLeft = [];
  for (const [dir, before] of homeBefore) for (const n of listing(dir)) if (!before.has(n)) homeLeft.push(path.join(dir, n));
  if (roomsLeft.size || homeLeft.length) {
    const lines = [...[...roomsLeft].map((n) => path.join(roomsDir, n)), ...homeLeft.map((n) => `${n} (real home folder, not removed)`)];
    fs.writeSync(2, `room leak: ${process.argv[1] || 'test'} left ${lines.length} room folder(s):
${lines.map((d) => `  ${d}
`).join('')}`);
    process.exitCode = 1;
  }
  const left = [...made].filter((d) => fs.existsSync(d));
  for (const d of left) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the name below is the report */ }
  }
  if (!left.length) return;
  fs.writeSync(2, `temp folder leak: ${process.argv[1] || 'test'} left ${left.length} folder(s):\n${left.map((d) => `  ${d}\n`).join('')}`);
  process.exitCode = 1;
});
