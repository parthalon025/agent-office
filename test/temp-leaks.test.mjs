// The temp folder guard (test/fixtures/temp-leaks.mjs): a test process that leaves a folder fails (issue #124).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const guard = new URL('./fixtures/temp-leaks.mjs', import.meta.url).href;
const run = (body) => spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e',
  `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; ${body}`], { encoding: 'utf8' });

test('temp guard: a folder the process leaves fails it, is named, and is removed', () => {
  const r = run(`const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-leak-')); fs.writeFileSync(path.join(d, 'x'), '1'); console.log(d);`);
  const dir = r.stdout.trim();
  try {
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /temp folder leak/);
    assert.ok(r.stderr.includes(dir), 'the report names the folder');
    assert.equal(fs.existsSync(dir), false, 'the guard removes it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('temp guard: a folder removed in a finally block passes, also when the code in it throws', () => {
  const ok = run(`const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-leak-')); try { fs.writeFileSync(path.join(d, 'x'), '1'); } finally { fs.rmSync(d, { recursive: true, force: true }); }`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, '');
  const thrown = run(`const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-leak-')); try { try { throw new Error('boom'); } finally { fs.rmSync(d, { recursive: true, force: true }); } } catch {}`);
  assert.equal(thrown.status, 0, thrown.stderr);
  assert.equal(thrown.stderr, '');
});

// Every way to make a temp folder reaches the guard (review of #124: a named import and fs.promises slipped past it).
const ways = {
  'a named import of mkdtempSync': `const { mkdtempSync } = await import('node:fs'); return mkdtempSync(path.join(os.tmpdir(), 'ao-named-'))`,
  'the callback fs.mkdtemp': `return await new Promise((ok, no) => fs.mkdtemp(path.join(os.tmpdir(), 'ao-cb-'), (e, d) => e ? no(e) : ok(d)))`,
  'fs.promises.mkdtemp': `return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ao-prom-'))`,
  'fs/promises mkdtemp': `const { mkdtemp } = await import('node:fs/promises'); return await mkdtemp(path.join(os.tmpdir(), 'ao-fsp-'))`,
};
for (const [name, make] of Object.entries(ways)) {
  test(`temp guard: a folder made with ${name} that is left fails the process`, () => {
    const r = run(`const d = await (async () => { ${make} })(); console.log(d);`);
    const dir = r.stdout.trim();
    try {
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /temp folder leak/);
      assert.equal(fs.existsSync(dir), false, 'the guard removes it');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
