// npm run test:junction (Windows only): the room and floor tests with TEMP and TMP behind a junction.
// GitHub's Windows runner has an 8.3 short TEMP path (RUNNER~1), and room matching broke on it once (git.mjs roomFolder, realpathSync.native).
// The junction gives the same trouble on any machine: the temp path the tests see is not the real path git reports.
// The test processes get TEMP and TMP through a junction to a fresh folder; the junction and the folder go when they end.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Every test that compares a worktree, room or folder path.
const TESTS = ['campus', 'floors', 'floors-routes', 'layout-routes', 'merge-routes', 'place', 'recent', 'git-hardening', 'rituals-routes', 'building'];

if (process.platform !== 'win32') {
  console.log('test:junction runs on Windows only; skipped.');
  process.exit(0);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-junction-'));
const real = path.join(base, 'real');
const link = path.join(base, 'link');
fs.mkdirSync(real);
fs.symlinkSync(real, link, 'junction');
let code = 1;
try {
  const env = { ...process.env, TEMP: link, TMP: link };
  const args = ['--import', './test/fixtures/temp-leaks.mjs', '--test', ...TESTS.map((t) => `test/${t}.test.mjs`)];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  code = r.status ?? 1;
  const left = fs.readdirSync(real);
  if (left.length) { console.error(`test:junction: ${left.length} entry(ies) left in the junction target: ${left.join(', ')}`); code = 1; }
} finally {
  try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* removed with the folder below */ } }
  fs.rmSync(base, { recursive: true, force: true });
}
console.log(code === 0 ? 'test:junction: pass' : 'test:junction: FAIL');
process.exit(code);
