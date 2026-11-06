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

// #47 and #48: the palette sits above every dialog.
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
// #1 story 26: office.js is split by concern into page files that share window.OfficePage. A rule about one part reads the file
// that holds it; a rule that holds for the whole page (a name that must not come back, a count) reads all of them.
const page = (f) => readFileSync(join(pub, f), 'utf8').replace(/\r\n/g, '\n');
const PAGE_FILES = ['page-core.js', 'dialogs.js', 'dialogs-extra.js', 'panels.js', 'needs.js', 'office.js'];
const pageAll = PAGE_FILES.map(page).join('\n');
const core = page('page-core.js'), panels = page('panels.js'), extra = page('dialogs-extra.js');

test('the page files load in order before chat-extras.js, and the server serves each one (#1 story 26)', () => {
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const at = PAGE_FILES.map((f) => html.indexOf('<script src="/' + f + '"></script>'));
  at.forEach((n, i) => assert.ok(n >= 0, PAGE_FILES[i] + ' is in index.html'));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'dependencies load first: the core, the dialogs, the panels, needs, and office.js last');
  assert.ok(at[at.length - 1] < html.indexOf('<script src="/chat-extras.js"></script>'));
  const server = readFileSync(join(pub, '..', 'src', 'server.mjs'), 'utf8');
  for (const f of PAGE_FILES) assert.ok(server.includes("['/" + f + "', 'public/" + f + "']"), f + ' is in STATIC_FILES');
});
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
  const fx = core.match(/function useKinds\(on\) \{[\s\S]*?\n  \}\r?\n/);
  assert.ok(fx, 'useKinds');
  const sh = core.match(/function fetchProviders\(fresh\) \{[\s\S]*?\n  \}\r?\n/);
  assert.ok(sh, 'fetchProviders: the one shared ask (#101)');
  assert.equal((fx[0].match(/fetchProviders\(/g) || []).length, 1, 'useKinds asks only through the shared fetch');
  assert.equal((sh[0].match(/'\/api\/providers\?fresh=1' : '\/api\/providers'/g) || []).length, 1, 'one plain ask, one fresh ask');
  assert.match(fx[0], /var fresh = wantFresh\.current; wantFresh\.current = false;/, 'the flag is read once');
  assert.match(fx[0], /recheck: function \(\) \{ wantFresh\.current = true; setRound\(round \+ 1\); \}/, 'only recheck sets it');
  assert.equal((fx[0].match(/wantFresh\.current = true/g) || []).length, 1);
  assert.equal([...pageAll.matchAll(/'\/api\/providers/g)].length, 2, 'no other page code asks for the provider status');
});

// #92: the dock goes away. Its actions are in the scene (open desks, the reception memo, the elevator) and in Ctrl+K, and the
// Reception lists the office's own actions, so a touch screen reaches them with no keyboard.
test('office.js: no dock and no welcome card; the Reception holds the office actions; the scene reports Since you left (#66, #92)', () => {
  assert.match(office, /h\(A\.OfficeScene, \{[^\n]*\n(?:[^\n]*\n){0,12}?[^\n]*onSinceYouLeft: setSyl/, 'the scene reports the card');
  assert.doesNotMatch(office, /className: 'strip'|function Controls\(|className: 'welcome'/);
  assert.doesNotMatch(css, /\.strip\b|\.welcome\b/);
  const ids = office.match(/var officeActions = actions\.filter\(function \(a\) \{ return \[([^\]]*)\]/);
  assert.ok(ids, 'the Reception actions');
  for (const id of ['page-open', 'page-needs', 'page-sessions', 'page-past', 'page-schedules', 'page-hooks', 'page-kinds', 'page-city', 'page-compact']) assert.ok(ids[1].includes(`'${id}'`), id);
  assert.match(office, /d === 'reception' \? h\(ReceptionDialog, \{ repo: shown, actions: officeActions/);
  assert.match(office, /floorsTitle: 'Elevator'/);
});

// #92 review: the dock had Needs you for every building. Without it, the scene's top bar and the city panel show the count of the
// one Notifier (officeAdapter.requests), and one tap goes to the oldest request: needs[0], as the bezel of #89 does.
test('office.js: Needs you in the scene top bar and the city panel: the Notifier count, and one tap goes to the oldest request', () => {
  assert.match(office, /waitingCount: needs\.length, onWaiting: goOldest,/, 'the scene: the page total and the oldest request');
  assert.match(office, /h\(A\.Notifier, \{ enabled: alertsOn\(\), count: needs\.length,/, 'the same count as the tab title');
  assert.match(office, /function goOldest\(\) \{\s+openQueueItem\(queue && queue\.oldest\);/, 'the oldest request of the one queue (#146)');
  assert.match(office, /if \(deskRef\.current && way\.id && cur2\.view === 'office' && deskRef\.current\.show\(way\.id, false\)\) return;\s+openDesk\(way\.uid, 'chat'\);/, 'the camera looks at its paper or note (#90), else the scene goes to its desk (#89)');
  assert.match(office, /if \(way\.via === 'list'\) \{ setDlg\(\{ name: 'needs' \}\); return; \}/, 'a Ready to merge decision with no desk opens the Needs you list (#93)');
  assert.match(office, /h\(CityView, \{ key: 'city', shown: shown, onEnter: enter, needs: needs\.length, onNeeds: goOldest, onHq: function \(\) \{ setDlg\(\{ name: 'hq' \}\); \} \}\)/, 'the city too');
  assert.match(office, /p\.needs > 0 \? h\(A\.Button, \{ variant: 'emphasis', icon: 'waiting', className: 'city-needs',[^\n]*onClick: p\.onNeeds \}, 'Needs you · ' \+ p\.needs\)/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.city-needs \{ min-height: 44px; \} \}/);
});

// #92 review: one button ends the tour on each stop. The last stop had Close and Done, both onDone.
test('office.js: the lobby tour has one way to end it on each stop: Skip the tour, then Done on the last stop', () => {
  const card = extra.match(/function TourCard\(p\) \{[\s\S]*?\n  \}\n/);
  assert.ok(card, 'TourCard');
  assert.equal((card[0].match(/onClick: p\.onDone/g) || []).length, 2, 'two places end the tour');
  assert.match(card[0], /last \? null : h\(A\.Button, \{ variant: 'quiet', onClick: p\.onDone \}, 'Skip the tour'\)/, 'Skip only before the last stop');
  assert.match(card[0], /last \? h\(A\.Button, \{ variant: 'primary', onClick: p\.onDone \}, 'Done'\)/, 'Done only on the last stop');
  assert.doesNotMatch(card[0], /'Close'/);
});

// #92: the lobby tour card centres with translate (not transform, #47), only fades, fits a phone, and leaves the look bar free.
test('office.css: the tour card centres with translate, only fades and fits the viewport (#47, #92)', () => {
  const r = (css.match(/\n\.tour-card \{\n([\s\S]*?)\n\}/) || [])[1] || '';
  assert.match(r, /z-index:\s*var\(--z-sheet\)/);
  assert.match(r, /translate:\s*-50%\s+0/);
  assert.doesNotMatch(r, /transform:/);
  assert.match(r, /width:\s*min\(440px, calc\(100vw - 2 \* var\(--space-4\)\)\)/);
  assert.match(r, /box-sizing:\s*border-box/);
  assert.match(css, /\n\.tour-card \{ animation: page-fade /);
});

test('office.css: the page fade holds no fill, so .ao-office is no stacking context (#47 #48)', () => {
  const m = css.match(/\n\.view > \* \{([^}]*)\}/);
  assert.ok(m, '.view > * rule');
  assert.match(m[1], /animation:[^;]*\bbackwards\b/);
  assert.doesNotMatch(m[1], /\b(both|forwards)\b/);
});

test('office.css: at 820 px and below the Since you left card and the room card do not share the dock edge (#66)', () => {
  const m = css.match(/@media \(max-width: 820px\) \{[^@]*?#office:has\(\.ao-hud-syl\) \.ao-hud-right:not\(\.ao-hud-inbox\):not\(\.ao-hud-chat\) \{ display: none; \}/);
  assert.ok(m, 'the rule sits in the 820 px block');
});

// The asset files are the parts of the first theme (the :root block of tokens.css), for use as files: each office type picture and
// each bot portrait is the DS drawing with those tokens, byte for byte. The other themes draw theirs from their tokens (#131).
test('assets/Offices and assets/Bots: each file is the DS drawing in the first theme of tokens.json', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const vm = await import('node:vm');
  const sb = { console, URL }; sb.window = sb.self = sb; vm.createContext(sb);
  vm.runInContext(readFileSync(join(root, 'public', 'vendor', 'react.production.min.js'), 'utf8'), sb);
  vm.runInContext(readFileSync(join(root, 'components', 'bundle.js'), 'utf8'), sb);
  const AO = sb.AgentOffice, J = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8')), first = J.color.themes[0].id;
  const all = Object.fromEntries([...J.color.tokens, ...J.skin.tokens].map((t) => [t.name, t.value]));
  const tok = (n) => { let v = all[n][first]; while (/^\{/.test(v)) v = all[v.slice(1, -1)][first]; return v; };
  const M = AO.MODES[0];
  for (const type of AO.OFFICE_PICTURES) {
    assert.equal(readFileSync(join(root, 'assets', 'Offices', type + '.svg'), 'utf8').trim(), AO.officePicture(type, tok, { dark: M.dark, retro: M.retro }), `assets/Offices/${type}.svg`);
  }
  const look = { ink: tok('portrait-ink'), gloss: tok('portrait-gloss'), outline: tok('portrait-outline'), eyesSquare: tok('portrait-eyes-square') };
  for (const shape of Object.keys(AO.PORTRAITS)) assert.equal(readFileSync(join(root, 'assets', 'Bots', shape + '.svg'), 'utf8').trim(), AO.PORTRAITS[shape](undefined, look), `assets/Bots/${shape}.svg`);
  assert.match(readFileSync(join(root, 'components', 'OfficeTypeCard', 'preview.html'), 'utf8'), /\["security",/);
});

// #89: the terminal and changes side panels are gone; the desk monitor and the room's wall screen are pinned screens. No
// approval can hide: every screen in focus shows the bezel count, and the desk screen shows the requests of its session.
test('office.js: pinned screens replace the terminal and changes panels, and every screen in focus has the bezel count (#89)', () => {
  const js = office, css = readFileSync(join(pub, 'office.css'), 'utf8');
  assert.doesNotMatch(pageAll, /TerminalPanel|terminal-panel/, 'no terminal side panel');
  assert.doesNotMatch(css, /\.terminal-panel/, 'no terminal side panel style');
  const fn = (name) => { const at = panels.indexOf('function ' + name + '('); assert.ok(at >= 0, name); return panels.slice(at, panels.indexOf('\n  }\n', at)); };
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
  const js = office, css = readFileSync(join(pub, 'office.css'), 'utf8');
  const at = panels.indexOf('function DeskScreen('), desk = panels.slice(at, panels.indexOf('\n  }\n', at));
  const head = desk.indexOf("h('div', { className: 'pin-head' }"), tabs = desk.indexOf('h(A.Tabs, {');
  assert.ok(head >= 0 && tabs > head, 'head, then the tabs (DOM order is the reading and focus order)');
  assert.doesNotMatch(pageAll, /RequestBar/, 'the request bar is gone (#90): a request is a paper or a note on the desk');
  assert.match(desk, /className: 'pin pin-desk' \+ \(small \? ' is-small' : ''\), hidden/, 'small is React state');
  assert.doesNotMatch(pageAll, /classList\.toggle\('is-small'/, 'no class set by hand: a render that changes className would drop it');
  assert.doesNotMatch(css, /\.pin-desk\.is-small \.pin-head \{ flex-wrap: nowrap; \}/, 'a head too narrow wraps, never clips Back');
  assert.match(css, /\.pin-desk\.is-small \.pin-head > \* \{ flex: none; \}/, 'its buttons keep their size; the name gives way');
  assert.match(desk, /h\(Bezel, \{ inline: true, count: p\.waiting, onGo: p\.onGo, compact: small \}\)/, 'a small head shows the count, not the words');
  assert.match(panels, /compact \? 'Needs you · ' \+ p\.count \+ '\. Go to the oldest request' : null/, 'the compact bezel keeps its whole name as its label');
  assert.match(js, /\.term-input, \.term-note, \.bezel, \.board-b > \.inline-actions,/, 'the toast stack keeps off the terminal note, the bezel and the room panel actions');
});

// Review M6: at 400 px the Security wall was a 172 px strip between the floor list and the room card. While a Security screen
// is in focus at 820 px and below, the page hides those two (as has-panel hides the right column; the Decisions inbox stays),
// frames the screen again, and the look bar shows the open requests, so an approval never hides.
test('office.js and office.css: a Security screen in focus at 820 px and below gets the floor list and the room card out of the way (M6)', () => {
  const js = office;
  assert.match(js, /useLayoutEffect\(function \(\) \{ var el = document\.getElementById\('office'\); if \(el\) el\.classList\.toggle\('sec-look', hideHud\)/, 'set in the commit, before the look bar places itself');
  assert.match(js, /layout: secLook/);
  assert.match(js, /\[hideHud\]\);/, 'the screen is framed again when the class changes');
  assert.match(panels, /var askKey = String\(useQueueCount\(\)\);/, 'the look bar counts the one queue');
  const m = /@media \(max-width: 820px\) \{\s*#office\.sec-look \.ao-hud-left, #office\.sec-look \.ao-hud-right:not\(\.ao-hud-inbox\) \{ visibility: hidden; pointer-events: none; \}/.exec(css);
  assert.ok(m, 'the rule in office.css');
});

// From 1100 px down to 821 px the dock sits on the left edge; the left menu (floors, rooms, queue) stops above it, so no Approve button sits under the dock.
test('the left menu stops above the dock from 1100 px down to 821 px', () => {
  assert.match(css, /@media \(min-width: 821px\) and \(max-width: 1100px\) \{\s*\.ao-hud-left \{ max-height: calc\(100% - 68px - var\(--strip-clear, 200px\)\); \}\s*\}/);
});

test('office.js: the screen waits are deadlines in time, a pinned screen hides the floor list, the first request takes focus, the bezel stays in the free part (review 89)', () => {
  const js = office;
  assert.doesNotMatch(pageAll, /\+\+w\.n > 300/, 'no count of frames');
  assert.equal((pageAll.match(/Date\.now\(\) > w\.until/g) || []).length, 1, 'the changes wait ends on a deadline');
  assert.match(js, /wantClock\(w, Date\.now\(\)/, 'the desk wait ends on a deadline in time (wantClock, #189)');
  assert.match(js, /var hideHud = secLook \|\| pinned;/, 'a pinned screen takes the same columns away as a Security screen');
  assert.match(panels, /el\.querySelector\('#pin-chat-input, \.term-field'\)/, 'the message box takes focus');
  assert.match(panels, /bezelAt\(r, p\.host\.free\(\), 18\)/, 'the bezel is kept inside host.free()');
});
