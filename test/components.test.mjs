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

// #55 (after #53): office.js owns the scene height. It renders the scene again when the window changes; no page CSS
// overrides the inline height the DS sets.
const office = readFileSync(join(pub, 'office.js'), 'utf8').replace(/\r\n/g, '\n');
test('office.js: the scene height follows the window, and no CSS overrides the DS height (#55)', () => {
  assert.doesNotMatch(css, /\.ao-office[^{]*\{[^}]*height[^}]*!important/, 'no !important height on the DS scene');
  assert.match(rule('#office'), /height:\s*100vh/);
  const scene = office.match(/h\(A\.OfficeScene, \{[^\n]*\bheight: ([\w.]+)/);
  assert.ok(scene, 'the scene gets a height');
  assert.notEqual(scene[1], 'window.innerHeight', 'not the height at the first render only');
  assert.equal(scene[1], 'win.h');
  assert.match(office, /var ws = useState\(winSize\), win = ws\[0\], setWin = ws\[1\];/);
  // a resize sets the new size (once per frame), and the screen in focus is framed again after the scene has it
  const fx = office.match(/\(#55\)\.\n( +)useEffect\(function \(\) \{\n[\s\S]*?\n\1\}, \[\]\);/);
  assert.ok(fx, 'the resize effect');
  assert.match(fx[0], /window\.addEventListener\('resize', onResize\)/);
  assert.match(fx[0], /setWin\(winSize\(\)\)/);
  assert.match(fx[0], /window\.removeEventListener\('resize', onResize\)/);
  assert.match(office, /useEffect\(function \(\) \{ if \(hostRef\.current\) hostRef\.current\.refit\(\); \}, \[win\]\);/);
});

test('office.js: the welcome card waits while the Since you left card shows, and the dock holds the primary button then (#66)', () => {
  assert.match(office, /h\(A\.OfficeScene, \{[^\n]*\n(?:[^\n]*\n){0,12}?[^\n]*onSinceYouLeft: setSyl/, 'the scene reports the card');
  // It also waits while the camera looks at a screen: the Security room screens work with no session (#70).
  assert.match(office, /var welcome = !!snap && !live\.length && !p\.syl && !p\.look;/);
  assert.match(office, /h\(Controls, \{[^\n]*\blook: !!look\b/);
  assert.match(office, /welcome \? h\('div', \{ className: 'welcome' \}/);
  assert.match(office, /h\(A\.Button, \{ variant: welcome \? 'quiet' : 'primary', icon: 'add'/);
  assert.match(office, /h\(Controls, \{[^\n]*\bsyl: syl && cur2\.view === 'office'/);
});

test('office.css: at 820 px and below the empty room card gives way to the welcome card, not the inbox (#53)', () => {
  assert.match(css, /#office:has\(\.welcome\) \.ao-hud-right:not\(\.ao-hud-inbox\) \{ display: none; \}/);
  const m = css.match(/@media \(max-width: 820px\) \{[^@]*?#office:has\(\.welcome\) \.ao-hud-right/);
  assert.ok(m, 'the rule sits in the 820 px block');
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

test('office.css: the welcome card max-width includes its padding, and the wordmark shrinks to the card (Sublevel at 400 px)', () => {
  assert.match(rule('.welcome'), /box-sizing:\s*border-box/);
  assert.match(css, /\n\.welcome-logo \.ao-lockup \{ min-width: 0; max-width: 100%; \}/);
  assert.match(css, /\n\.welcome-logo \.ao-lockup svg \{ min-width: 0; max-width: 100%; height: auto; \}/);
});

test('office.css: at 820 px and below the Since you left card and the room card do not share the dock edge (#66)', () => {
  const m = css.match(/@media \(max-width: 820px\) \{[^@]*?#office:has\(\.ao-hud-syl\) \.ao-hud-right:not\(\.ao-hud-inbox\):not\(\.ao-hud-chat\) \{ display: none; \}/);
  assert.ok(m, 'the rule sits in the 820 px block');
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

// Review minor: the security office type (#70) had no picture, so OfficeTypeCard showed its badge only. Every office type has a
// flat picture in each theme, and the bundle's copy is the asset file byte for byte; the DS preview shows the security card.
test('OfficeTypeCard: every office type has a picture in Day, Night and Sublevel, the same as its file in assets/Offices', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = readFileSync(join(root, 'components', 'bundle.js'), 'utf8');
  const at = bundle.indexOf('AO.THUMBS = {'), end = bundle.indexOf('\n  };', bundle.indexOf('sublevel: {', at));
  const block = bundle.slice(at, end);
  for (const [theme, sfx] of [['light', ''], ['dark', '-night'], ['sublevel', '-sublevel']]) {
    const part = theme === 'light' ? block.slice(0, block.indexOf('AO.THUMBS_BY_THEME')) : block.slice(block.indexOf(theme + ': {'));
    for (const type of ['team', 'lab', 'studio', 'hq', 'security']) {
      const m = new RegExp('"' + type + '": ("(?:[^"\\\\]|\\\\.)*")').exec(part);
      assert.ok(m, `${type} in ${theme}`);
      assert.equal(JSON.parse(m[1]), readFileSync(join(root, 'assets', 'Offices', `${type}${sfx}.svg`), 'utf8').trim(), `${type}${sfx}.svg`);
    }
  }
  assert.match(readFileSync(join(root, 'components', 'OfficeTypeCard', 'preview.html'), 'utf8'), /\["security",/);
});
