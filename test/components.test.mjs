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

// #47 and #48: the palette sits above every dialog, and the welcome card sits below both and fits a narrow screen.
const css = readFileSync(join(pub, 'office.css'), 'utf8').replace(/\r\n/g, '\n');
const rule = (sel) => {
  const at = css.indexOf(`\n${sel} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('\n}', at) + 2);
};

test('office.css: the palette overlay is above the dialog layer (#48)', () => {
  assert.match(rule('.ao-cmdk-o'), /z-index:\s*calc\(var\(--z-dialog\)\s*\+\s*1\)/);
});

test('office.css: the page fade holds no fill, so .ao-office is no stacking context (#47 #48)', () => {
  const m = css.match(/\n\.view > \* \{([^}]*)\}/);
  assert.ok(m, '.view > * rule');
  assert.match(m[1], /animation:[^;]*\bbackwards\b/);
  assert.doesNotMatch(m[1], /\b(both|forwards)\b/);
});

test('office.css: the welcome card centres with translate (not transform), only fades and fits the viewport (#47)', () => {
  const r = rule('.welcome');
  assert.match(r, /z-index:\s*var\(--z-(hud|sheet|tag)\)/);
  assert.match(r, /max-width:/);
  assert.match(r, /translate:\s*-50%\s+-50%/);
  assert.doesNotMatch(r, /transform:/);
  assert.match(css, /\n\.welcome \{ animation: page-fade /);
});

test('office.css: at 820 px and below the welcome card centres in the screen, between the top tools and the dock (#52)', () => {
  const m = css.match(/@media \(max-width: 820px\) \{[^\n]*\.welcome \{([^}]*)\}/);
  assert.ok(m, 'narrow .welcome rule');
  assert.match(m[1], /top:\s*50%/);
  assert.match(m[1], /left:\s*50%/);
});

test('office.css: short windows shrink the welcome card, and landscape drops it into the band above the dock (#52 follow-up)', () => {
  const tier = css.match(/@media \(max-height: 760px\) \{([\s\S]*?)\n\}/);
  assert.ok(tier, 'max-height 760 query');
  assert.match(tier[1], /\.welcome \{[^}]*padding:/);
  assert.match(tier[1], /\.welcome-logo \.ao-lockup \{[^}]*zoom:/);
  const tight = css.match(/@media \(max-height: 640px\) \{([\s\S]*?)\n\}/);
  assert.ok(tight, 'max-height 640 query');
  assert.match(tight[1], /\.welcome-logo \{ display: none/);
  const land = css.match(/@media \(max-height: 460px\) \{\s*\.welcome \{([^}]*)\}/);
  assert.ok(land, 'max-height 460 .welcome rule');
  assert.match(land[1], /top:\s*calc\(50% \+ var\(--space-4\)\)/);
  // none of the short rules touches the centring, z-index or animation (#47)
  for (const m of [tier[1], tight[1], land[1]]) { assert.doesNotMatch(m, /z-index|animation|transform|translate/); }
});
