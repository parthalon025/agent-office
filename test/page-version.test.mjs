// #29: the page version is x0.2 in the title, the README heading and the header of each page file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the page version is x0.2 everywhere it is named', () => {
  assert.match(read('public/index.html'), /<title>Agent Office x0\.2<\/title>/);
  assert.match(read('README.md'), /^# Agent Office for Claude Code x0\.2\r?\n/);
  for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter((n) => /\.(js|css)$/.test(n))) {
    assert.doesNotMatch(read('public/' + f).split('\n')[0], /x0\.1/, f + ' header');
  }
});
