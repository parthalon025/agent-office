// Every page component the page renders with h(Name, ...) must be declared in the
// same file. A merge once brought back h(ChatHeaderButton) without its function,
// and the page went blank on load. DS components (A.Button, ...) are not checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const files = readdirSync(pub).filter((f) => f.endsWith('.js'));

for (const f of files) {
  test(`${f}: every h(Component) is declared`, () => {
    const src = readFileSync(join(pub, f), 'utf8');
    const used = new Set([...src.matchAll(/\bh\(([A-Z][A-Za-z0-9_]*)\s*[,)]/g)].map((m) => m[1]));
    const missing = [...used].filter((name) =>
      !new RegExp(`(function\\s+${name}\\b|\\b(var|let|const)\\s+${name}\\b|[,{]\\s*${name}\\s*[=,]|\\b${name}\\s*=\\s*function)`).test(src));
    assert.deepEqual(missing, [], `${f} renders components it does not declare`);
  });
}
