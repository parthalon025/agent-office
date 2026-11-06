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
  // + 2 since #79: the toast stack is the dialog layer + 1, and the palette stands above it too (test/toasts.test.mjs)
  assert.match(rule('.ao-cmdk-o'), /z-index:\s*calc\(var\(--z-dialog\)\s*\+\s*[1-9]\d*\)/);
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

test('office.js: only Check again asks the server for a fresh provider round; opening a dialog reads the kept answer (#104)', () => {
  const fx = office.match(/function useKinds\(on\) \{[\s\S]*?\n  \}\r?\n/);
  assert.ok(fx, 'useKinds');
  const sh = office.match(/function fetchProviders\(fresh\) \{[\s\S]*?\n  \}\r?\n/);
  assert.ok(sh, 'fetchProviders: the one shared ask (#101)');
  assert.equal((fx[0].match(/fetchProviders\(/g) || []).length, 1, 'useKinds asks only through the shared fetch');
  assert.equal((sh[0].match(/'\/api\/providers\?fresh=1' : '\/api\/providers'/g) || []).length, 1, 'one plain ask, one fresh ask');
  assert.match(fx[0], /var fresh = wantFresh\.current; wantFresh\.current = false;/, 'the flag is read once');
  assert.match(fx[0], /recheck: function \(\) \{ wantFresh\.current = true; setRound\(round \+ 1\); \}/, 'only recheck sets it');
  assert.equal((fx[0].match(/wantFresh\.current = true/g) || []).length, 1);
  assert.equal([...office.matchAll(/'\/api\/providers/g)].length, 2, 'no other page code asks for the provider status');
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

// #112: every theme of tokens.json has a set, and the type stripe in each picture (its third and fourth path) is the theme's type-* color.
test('OfficeTypeCard: each theme has a thumbnail set whose type stripe equals its type-* token (#112)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = readFileSync(join(root, 'components', 'bundle.js'), 'utf8');
  const tokens = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8'));
  const flat = []; (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.name && o.value) flat.push(o); Object.values(o).forEach(walk); } })(tokens);
  const themes = Object.keys(flat.find((t) => t.name === 'type-team').value);
  assert.deepEqual(themes.sort(), ['dark', 'fluent', 'fluent-dark', 'light', 'sublevel']);
  const sfx = { light: '', dark: '-night', sublevel: '-sublevel', fluent: '-fluent', 'fluent-dark': '-fluent-dark' };
  for (const theme of themes) {
    assert.ok(bundle.includes(`${/^[a-z]+$/.test(theme) ? theme : '"' + theme + '"'}: ${theme === 'light' ? 'AO.THUMBS' : '{'}`), `set for ${theme}`);
    for (const type of ['team', 'lab', 'studio', 'hq', 'security']) {
      const svg = readFileSync(join(root, 'assets', 'Offices', `${type}${sfx[theme]}.svg`), 'utf8');
      const fills = [...svg.matchAll(/<path d="[^"]*" fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
      assert.equal(fills[2], flat.find((t) => t.name === 'type-' + type).value[theme], `${type} stripe in ${theme}`);
    }
  }
});

// #89: the terminal and changes side panels are gone; the desk monitor and the room's wall screen are pinned screens. No
// approval can hide: every screen in focus shows the bezel count, and the desk screen shows the requests of its session.
test('office.js: pinned screens replace the terminal and changes panels, and every screen in focus has the bezel count (#89)', () => {
  const js = readFileSync(join(pub, 'office.js'), 'utf8'), css = readFileSync(join(pub, 'office.css'), 'utf8');
  assert.doesNotMatch(js, /TerminalPanel|terminal-panel/, 'no terminal side panel');
  assert.doesNotMatch(css, /\.terminal-panel/, 'no terminal side panel style');
  const fn = (name) => { const at = js.indexOf('function ' + name + '('); assert.ok(at >= 0, name); return js.slice(at, js.indexOf('\n  }\n', at)); };
  assert.match(fn('DeskScreen'), /h\(RequestBar, \{ session: s/, 'the desk screen shows the requests of its session');
  assert.match(fn('DeskScreen'), /h\(Bezel, \{ inline: true, count: p\.waiting/, 'the desk screen has the bezel count');
  assert.match(fn('ChangesScreen'), /h\(Bezel, \{ inline: true, count: p\.waiting/, 'the changes screen has the bezel count');
  assert.match(js, /layer && !pinned && hostRef\.current \? h\(Bezel, \{ host: hostRef\.current/, 'a screen that is not pinned has the bezel count too');
  assert.match(js, /waiting: function \(\) \{ return needsRef\.current; \}/, 'the count is every request of every building');
  assert.match(fn('ChangesScreen'), /h\(ChangesConfirm, \{ c: c \}\)/, 'pull request and worktree removal keep their confirm dialog');
  assert.match(fn('putBox'), /setProperty\('--pin-x'/, 'the box is set with setProperty, never a style attribute');
  assert.doesNotMatch(fn('DeskScreen') + fn('ChangesScreen') + fn('Bezel'), /style:/, 'no style prop on a pinned layer');
});

// Review 89, B2: at 400 px an open request pushed Approve and Decline below the desk screen (the bar sat under the tabs, capped
// at 40%, and the head took two rows). The requests come first, under the head; on a small screen the head is one row, and while
// a request is open the bar takes the screen under the head with no cap and the tabs wait. The browser check measures it.
test('office.js and office.css: on the desk screen the requests come first, and on a small screen they take the screen (review 89)', () => {
  const js = readFileSync(join(pub, 'office.js'), 'utf8'), css = readFileSync(join(pub, 'office.css'), 'utf8');
  const at = js.indexOf('function DeskScreen('), desk = js.slice(at, js.indexOf('\n  }\n', at));
  const head = desk.indexOf("h('div', { className: 'pin-head' }"), bar = desk.indexOf('h(RequestBar, { session: s'), tabs = desk.indexOf('h(A.Tabs, {');
  assert.ok(head >= 0 && bar > head && tabs > bar, 'head, then the requests, then the tabs (DOM order is the reading and focus order)');
  assert.match(desk, /className: 'pin pin-desk' \+ \(small \? ' is-small' : ''\) \+ \(asks \? ' has-asks' : ''\)/, 'small and has-asks are React state');
  assert.doesNotMatch(js, /classList\.toggle\('is-small'/, 'no class set by hand: a render that changes className would drop it');
  assert.doesNotMatch(css, /\.pin-desk\.is-small \.pin-head \{ flex-wrap: nowrap; \}/, 'a head too narrow wraps, never clips Back');
  assert.match(css, /\.pin-desk\.is-small \.pin-head > \* \{ flex: none; \}/, 'its buttons keep their size; the name gives way');
  assert.match(desk, /h\(Bezel, \{ inline: true, count: p\.waiting, onGo: p\.onGo, compact: small \}\)/, 'a small head shows the count, not the words');
  assert.match(js, /compact \? 'Needs you · ' \+ p\.count \+ '\. Go to the oldest request' : null/, 'the compact bezel keeps its whole name as its label');
  assert.match(css, /\.pin-desk\.is-small\.has-asks \.asks \{ flex: 1 1 auto; min-height: 0; max-height: none; border-bottom: 0; \}/, 'no cap on a small screen');
  assert.match(css, /\.pin-desk\.is-small\.has-asks \.ao-tabs \{ display: none; \}/, 'the tabs wait while a request is open');
  assert.match(js, /\.term-input, \.term-note, \.bezel, \.board-b > \.inline-actions,/, 'the toast stack keeps off the terminal note, the bezel and the room panel actions');
});

// Review M6: at 400 px the Security wall was a 172 px strip between the floor list and the room card. While a Security screen
// is in focus at 820 px and below, the page hides those two (as has-panel hides the right column; the Decisions inbox stays),
// frames the screen again, and the look bar shows the open requests, so an approval never hides.
test('office.js and office.css: a Security screen in focus at 820 px and below gets the floor list and the room card out of the way (M6)', () => {
  const js = readFileSync(join(pub, 'office.js'), 'utf8');
  assert.match(js, /useLayoutEffect\(function \(\) \{ var el = document\.getElementById\('office'\); if \(el\) el\.classList\.toggle\('sec-look', hideHud\)/, 'set in the commit, before the look bar places itself');
  assert.match(js, /layout: secLook/);
  assert.match(js, /\[hideHud\]\);/, 'the screen is framed again when the class changes');
  assert.match(js, /h\(LookBar, \{[^}]*asks:/, 'the look bar gets the open requests');
  const m = /@media \(max-width: 820px\) \{\s*#office\.sec-look \.ao-hud-left, #office\.sec-look \.ao-hud-right:not\(\.ao-hud-inbox\) \{ visibility: hidden; pointer-events: none; \}/.exec(css);
  assert.ok(m, 'the rule in office.css');
});

// From 1100 px down to 821 px the dock sits on the left edge; the left menu (floors, rooms, queue) stops above it, so no Approve button sits under the dock.
test('the left menu stops above the dock from 1100 px down to 821 px', () => {
  assert.match(css, /@media \(min-width: 821px\) and \(max-width: 1100px\) \{\s*\.ao-hud-left \{ max-height: calc\(100% - 68px - var\(--strip-clear, 200px\)\); \}\s*\}/);
});

test('office.js: the screen waits are deadlines in time, a pinned screen hides the floor list, the first request takes focus, the bezel stays in the free part (review 89)', () => {
  const js = readFileSync(join(pub, 'office.js'), 'utf8');
  assert.doesNotMatch(js, /\+\+w\.n > 300/, 'no count of frames');
  assert.equal((js.match(/Date\.now\(\) > w\.until/g) || []).length, 2, 'the changes and the desk wait end on a deadline');
  assert.match(js, /var hideHud = secLook \|\| pinned;/, 'a pinned screen takes the same columns away as a Security screen');
  assert.match(js, /el\.querySelector\('\.asks button'\) \|\| el\.querySelector\('#pin-chat-input/, 'an open request takes focus before the message box');
  assert.match(js, /bezelAt\(r, p\.host\.free\(\), 18\)/, 'the bezel is kept inside host.free()');
});
