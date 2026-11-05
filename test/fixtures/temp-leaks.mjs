// Temp folder guard for the tests. `npm test` loads this file in every test process (node --import).
// It notes each folder the process makes with fs.mkdtempSync, fs.mkdtemp or fs.promises.mkdtemp in the system temp folder. When the
// process ends, every folder that still exists is a leak: the guard removes it, names it on stderr
// and fails the process. A test that makes a folder must remove it in a finally block (issue #124).
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

process.on('exit', () => {
  const left = [...made].filter((d) => fs.existsSync(d));
  for (const d of left) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the name below is the report */ }
  }
  if (!left.length) return;
  fs.writeSync(2, `temp folder leak: ${process.argv[1] || 'test'} left ${left.length} folder(s):\n${left.map((d) => `  ${d}\n`).join('')}`);
  process.exitCode = 1;
});
