// npm run check:merge: the merge checklist as one script. Windows first; Linux is left to the ubuntu job of CI.
//   1. node --check on the .mjs and .js files changed against a base ref
//   2. kit/check.py with the exact file list of .github/workflows/ci.yml (one source of truth)
//   3. npm test, twice (a flaky test shows on the second run)
//   4. npm run test:junction
//   5. npm run gate:jobs
// One summary line per step; exit 1 when any step fails. Usage: node test/check-merge.mjs [--base <ref>]
// Programs start by the absolute path of resolveExe; npm starts as node + npm-cli.js (npm.cmd is refused).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExe } from '../src/launch.mjs';
import { npmCli } from '../src/paperclip-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (file, args, { quiet = false } = {}) =>
  spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'inherit', 'inherit'], maxBuffer: 64 << 20 });
const git = (args) => run(resolveExe('git'), args, { quiet: true });

// ---------- steps ----------
function baseRef(arg) {
  if (arg) return arg;
  for (const ref of ['origin/main', 'main']) {
    const r = git(['merge-base', 'HEAD', ref]);
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('no merge-base with origin/main or main; pass --base <ref>');
}

function syntaxStep(base) {
  const names = new Set();
  const lists = [['diff', '--name-only', '--diff-filter=d', `${base}...HEAD`], ['diff', '--name-only', '--diff-filter=d', 'HEAD'], ['ls-files', '--others', '--exclude-standard']];
  for (const args of lists) {
    const r = git(args);
    if (r.status !== 0) return { ok: false, text: `git ${args[0]} failed: ${r.stderr.trim()}` };
    for (const n of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) names.add(n);
  }
  const files = [...names].filter((n) => /\.(mjs|js)$/.test(n) && !n.startsWith('public/vendor/') && fs.existsSync(path.join(ROOT, n)));
  const bad = [];
  for (const f of files) {
    const r = run(process.execPath, ['--check', f], { quiet: true });
    if (r.status !== 0) bad.push(`${f}: ${(r.stderr || '').split('\n').find((l) => l.includes('Error')) || 'failed'}`);
  }
  return { ok: !bad.length, text: bad.length ? bad.join('; ') : `${files.length} file(s) changed vs ${base.slice(0, 9)}` };
}

function kitStep() {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const m = ci.match(/^\s*run:\s*python kit\/check\.py\s+(.+?)\s*$/m);
  if (!m) return { ok: false, text: 'no "python kit/check.py" line in .github/workflows/ci.yml' };
  const files = m[1].split(/\s+/);
  let py;
  try { py = resolveExe('python'); } catch (e) { return { ok: false, text: e.message }; }
  const r = run(py, ['-I', 'kit/check.py', ...files], { quiet: true });
  return { ok: r.status === 0, text: r.status === 0 ? `${files.length} files` : (r.stdout + r.stderr).trim().split('\n').slice(-5).join(' | ') };
}

const npmRun = (script) => () => {
  const r = run(process.execPath, [npmCli(), 'run', script, '--silent'], { quiet: true });
  const tail = (r.stdout + r.stderr).trim().split('\n');
  const count = tail.filter((l) => /^ℹ (pass|fail) /.test(l)).map((l) => l.slice(2)).join(', ');
  return { ok: r.status === 0, text: r.status === 0 ? count || 'ok' : `${count} ${tail.slice(-3).join(' | ')}`.trim() };
};

// ---------- main ----------
const i = process.argv.indexOf('--base');
let base;
try { base = baseRef(i > 0 ? process.argv[i + 1] : null); } catch (e) { console.error(`FAIL base ref: ${e.message}`); process.exit(1); }
const steps = [
  ['node --check', () => syntaxStep(base)],
  ['kit/check.py', kitStep],
  ['npm test (1/2)', npmRun('test')],
  ['npm test (2/2)', npmRun('test')],
  ['test:junction', npmRun('test:junction')],
  ['gate:jobs', npmRun('gate:jobs')],
];
let failed = 0;
for (const [name, fn] of steps) {
  const t = Date.now();
  let r;
  try { r = fn(); } catch (e) { r = { ok: false, text: e.message }; }
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} ${((Date.now() - t) / 1000).toFixed(0).padStart(4)}s  ${r.text}`);
}
console.log(failed ? `check:merge: ${failed} step(s) failed` : 'check:merge: all steps passed');
process.exit(failed ? 1 : 0);
