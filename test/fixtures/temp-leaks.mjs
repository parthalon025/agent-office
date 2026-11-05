// Temp folder guard for the tests. `npm test` loads this file in every test process (node --import).
// It notes each folder the process makes with fs.mkdtempSync in the system temp folder. When the
// process ends, every folder that still exists is a leak: the guard removes it, names it on stderr
// and fails the process. A test that makes a folder must remove it in a finally block (issue #124).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = new Set();
const real = fs.mkdtempSync;
const tmp = path.resolve(os.tmpdir());

fs.mkdtempSync = function mkdtempSync(prefix, ...rest) {
  const dir = real.call(fs, prefix, ...rest);
  // A folder made with a Buffer prefix, or outside the temp folder, is not ours to judge.
  if (typeof dir === 'string' && path.resolve(dir).startsWith(tmp + path.sep)) made.add(path.resolve(dir));
  return dir;
};

process.on('exit', () => {
  const left = [...made].filter((d) => fs.existsSync(d));
  for (const d of left) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the name below is the report */ }
  }
  if (!left.length) return;
  fs.writeSync(2, `temp folder leak: ${process.argv[1] || 'test'} left ${left.length} folder(s):\n${left.map((d) => `  ${d}\n`).join('')}`);
  process.exitCode = 1;
});
