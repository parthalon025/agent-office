// Spawn safety (audit #27, C1): on Windows a bare program name is looked up in the child's folder before PATH,
// so a git.exe planted in a session folder would run with no click. The office starts every program from an
// absolute path (git.mjs resolveExe), and its entry points set NoDefaultCurrentDirectoryInExePath first.
// Offline: real git and a copy of the harmless hostname.exe, no network, no paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as git from '../git.mjs';

const { resolveExe } = git;
const win = process.platform === 'win32';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYS32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const GUARD = 'NoDefaultCurrentDirectoryInExePath';
const same = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

function scratch(prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------- resolveExe ----------

test('resolveExe gives an absolute path to a program on PATH, and caches it', () => {
  const exe = resolveExe('git');
  assert.ok(path.isAbsolute(exe), exe);
  assert.ok(fs.statSync(exe).isFile());
  if (win) assert.match(exe, /\.(exe|com)$/i);
  assert.equal(resolveExe('git'), exe);
  assert.equal(resolveExe(exe), exe, 'an absolute path comes back as is');
});

test('resolveExe throws for an unknown name and for a relative path', () => {
  assert.throws(() => resolveExe('ao-no-such-program-0f3c'), /not found on PATH/);
  assert.throws(() => resolveExe(''), /program name is required/);
  assert.throws(() => resolveExe('./git'), /program name or an absolute path/);
  assert.throws(() => resolveExe('sub/git'), /program name or an absolute path/);
  if (win) {
    assert.throws(() => resolveExe('.\\git.exe'), /program name or an absolute path/);
    assert.throws(() => resolveExe('C:git.exe'), /program name or an absolute path/);
    assert.throws(() => resolveExe('C:\\ao-no-such-folder\\git.exe'), /Program not found/);
  }
});

test('resolveExe skips the current folder and relative PATH entries', { skip: !win }, () => {
  const real = resolveExe('git');
  const s = scratch('ao-path-');
  const back = process.cwd();
  try {
    fs.copyFileSync(path.join(SYS32, 'HOSTNAME.EXE'), path.join(s.dir, 'git.exe'));
    fs.mkdirSync(path.join(s.dir, 'sub'));
    fs.copyFileSync(path.join(SYS32, 'HOSTNAME.EXE'), path.join(s.dir, 'sub', 'git.exe'));
    process.chdir(s.dir);
    // 'Path' in mixed case, as Windows writes it; '.', '' and 'sub' all point into the planted folder.
    const env = { Path: ['.', '', 'sub', `"${path.dirname(real)}"`].join(';'), SystemRoot: process.env.SystemRoot };
    assert.equal(resolveExe('git', env), real);
    assert.throws(() => resolveExe('git', { Path: '.;sub', SystemRoot: process.env.SystemRoot }), /not found on PATH/);
  } finally { process.chdir(back); s.done(); }
});

test('resolveExe reads a quoted PATH entry that has a space in it', { skip: !win }, () => {
  const s = scratch('ao-quote-');
  try {
    const dir = path.join(s.dir, 'Some Dir', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(SYS32, 'HOSTNAME.EXE'), path.join(dir, 'aoquote.exe'));
    const env = { Path: `C:\ao-no-such-folder;"${dir}"`, SystemRoot: process.env.SystemRoot };
    assert.ok(same(resolveExe('aoquote', env), path.join(dir, 'aoquote.exe')));
  } finally { s.done(); }
});

test('resolveExe takes cmd, powershell, taskkill and icacls from System32 only', { skip: !win }, () => {
  const s = scratch('ao-sys-');
  try {
    for (const n of ['cmd.exe', 'powershell.exe', 'taskkill.exe', 'icacls.exe']) fs.copyFileSync(path.join(SYS32, 'HOSTNAME.EXE'), path.join(s.dir, n));
    const env = { Path: s.dir, SystemRoot: process.env.SystemRoot };
    for (const [name, rel] of [['cmd.exe', 'cmd.exe'], ['cmd', 'cmd.exe'], ['powershell.exe', 'WindowsPowerShell\\v1.0\\powershell.exe'], ['taskkill', 'taskkill.exe'], ['icacls', 'icacls.exe'], ['ICACLS.EXE', 'icacls.exe']]) {
      assert.ok(same(resolveExe(name, env), path.join(SYS32, rel)), name);
      assert.ok(same(resolveExe(name), path.join(SYS32, rel)), name + ' (process env)');
    }
    assert.throws(() => resolveExe('cmd.exe', { Path: s.dir }), /System32/);
  } finally { s.done(); }
});

test('resolveExe refuses a .cmd shim: it cannot start without a shell', { skip: !win }, () => {
  const s = scratch('ao-shim-');
  try {
    fs.writeFileSync(path.join(s.dir, 'ao-shim-7d1e.cmd'), '@echo off\r\n');
    assert.throws(() => resolveExe('ao-shim-7d1e', { Path: s.dir, SystemRoot: process.env.SystemRoot }), /installed as a script .*ao-shim-7d1e\.cmd.*needs ao-shim-7d1e\.exe/);
  } finally { s.done(); }
});

// ---------- the planted program ----------

test('a git.exe planted in a session folder never runs from git.mjs', { skip: !win }, async () => {
  const s = scratch('ao-plant-');
  const saved = process.env[GUARD];
  try {
    const g = (...a) => execFileSync(resolveExe('git'), a, { cwd: s.dir, encoding: 'utf8', windowsHide: true });
    g('init', '-q');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
    fs.copyFileSync(path.join(SYS32, 'HOSTNAME.EXE'), path.join(s.dir, 'git.exe'));
    // The guard is off for this test (Claude Code's own shell sets it), so only absolute paths protect git.mjs.
    delete process.env[GUARD];
    const bare = 'git'; // a bare name, on purpose: the control shows what it does in this folder
    const control = spawnSync(bare, [], { cwd: s.dir, encoding: 'utf8', env: { ...process.env }, windowsHide: true });
    assert.equal(String(control.stdout).trim().toLowerCase(), os.hostname().toLowerCase(), 'control: a bare name runs the planted copy');

    const where = await git.locate(s.dir);
    assert.ok(where, 'locate gets an answer from real git');
    assert.ok(same(where.root, s.dir), `root ${where.root}`);
    assert.ok(same(where.repo, s.dir), `repo ${where.repo}`);
    assert.notEqual(where.branch, 'detached');
    assert.ok(same(await git.repoTop(s.dir), s.dir));
    const ch = await git.changes(s.dir);
    assert.ok(ch.files.some((f) => f.path === 'git.exe' && f.word === 'new'), 'real git status lists the planted file as new');
    assert.equal(ch.commits.length, 1);
    assert.deepEqual(await git.files(s.dir), []);

    // The guard the entry points set: with it, even a bare name runs the real git.
    process.env[GUARD] = '1';
    const guarded = spawnSync(bare, ['--version'], { cwd: s.dir, encoding: 'utf8', env: { ...process.env }, windowsHide: true });
    assert.match(String(guarded.stdout), /^git version/);
  } finally {
    if (saved === undefined) delete process.env[GUARD]; else process.env[GUARD] = saved;
    s.done();
  }
});

// ---------- static checks of the sources ----------

const SPAWN_RE = /(?<![\w$])(?:spawn|spawnSync|execFile|execFileSync)\s*\(/g;
const RESOLVE_RE = /(?<![\w$])(?:\w+\.)?resolveExe\s*\(/g;

/** Where the text from `from` ends: at the closing parenthesis, or (with `comma`) at the first top-level comma.
 *  Quoted text is skipped. */
function endOf(src, from, comma) {
  let depth = 0, quote = null;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) return j; depth--; }
    else if (comma && c === ',' && depth === 0) return j;
  }
  return src.length;
}
/** Program arguments of spawn calls that are, or contain, a string literal outside resolveExe(...). */
function bareSpawns(src) {
  const bad = [];
  for (const m of src.matchAll(SPAWN_RE)) {
    const from = m.index + m[0].length;
    let arg = src.slice(from, endOf(src, from, true));
    for (const r of [...arg.matchAll(RESOLVE_RE)].reverse()) {
      const close = endOf(arg, r.index + r[0].length, false);
      arg = arg.slice(0, r.index) + 'EXE' + arg.slice(close + 1);
    }
    if (/['"`]/.test(arg)) bad.push({ line: src.slice(0, m.index).split('\n').length, call: m[0] + arg.trim() });
  }
  return bad;
}

test('the source check finds a bare program name and allows resolved paths', () => {
  const flagged = (s) => bareSpawns(s).length > 0;
  assert.ok(flagged("spawn('git', ['status'])"));
  assert.ok(flagged('execFile("claude", args, opts, cb)'));
  assert.ok(flagged('cp.execFileSync(`gh`, [])'));
  assert.ok(flagged("spawn(win ? 'cmd.exe' : 'sh', a)"));
  assert.ok(flagged("execFile(resolveExe('taskkill') && 'git', [])"));
  assert.ok(!flagged("spawn(resolveExe('git'), ['x'], { cwd })"));
  assert.ok(!flagged("execFile(git.resolveExe(win ? 'cmd.exe' : 'sh'), ['/c'])"));
  assert.ok(!flagged("spawn(resolveExe('git', { Path: 'x' }), [])"));
  assert.ok(!flagged('spawn(exe, args)'));
  assert.ok(!flagged('execFileSync(process.execPath, [file])'));
  assert.ok(!flagged("x.respawn('a')"));
});

function sources() {
  const list = (dir, deep) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } // a folder may not exist on every branch
    return entries.flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return deep && e.name !== 'node_modules' ? list(p, deep) : [];
      return e.name.endsWith('.mjs') ? [p] : [];
    });
  };
  return [...list(ROOT, false), ...list(path.join(ROOT, 'providers'), true), ...list(path.join(ROOT, 'test'), true)]
    .filter((f) => f !== fileURLToPath(import.meta.url)); // this file holds the check's own samples and the control
}

test('no source starts a program by a bare name, through a shell, or with shell: true', () => {
  const files = sources();
  assert.ok(files.some((f) => path.basename(f) === 'server.mjs') && files.some((f) => path.basename(f) === 'git.mjs'));
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    for (const b of bareSpawns(src)) bad.push(`${rel}:${b.line} ${b.call}`);
    if (/\bshell\s*:\s*true\b/.test(src)) bad.push(`${rel}: shell: true`);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
      if (/\b(exec|execSync)\b/.test(m[1])) bad.push(`${rel}: imports exec or execSync (runs a shell)`);
    }
  }
  assert.deepEqual(bad, [], 'start programs with resolveExe(name) from git.mjs:\n' + bad.join('\n'));
});

test('server, hook, MCP and probe set the guard as their first statement', () => {
  for (const name of ['server.mjs', 'hook.mjs', 'mcp.mjs', 'probe.mjs']) {
    const first = fs.readFileSync(path.join(ROOT, name), 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).find((l) => l && !l.startsWith('#!') && !l.startsWith('//'));
    assert.equal(first, `process.env.${GUARD} = '1';`, name);
  }
});
