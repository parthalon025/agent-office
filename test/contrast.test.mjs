// Readable in every theme: the text and ink pairs that the page and the 3D scripts draw, from tokens.json.
// Each pair needs 4.5:1 (text) or 3:1 (a dot or another mark) in every theme of tokens.json, with no exception for one theme. The CSS checks pin the rules
// that use those pairs, so a later edit cannot put a status color back on text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');
const tokens = JSON.parse(read('tokens.json')).color.tokens;
const TH = JSON.parse(read('tokens.json')).color.themes.map((t) => t.id);   // every theme: a new one is checked at once
const val = (name, th) => { let v = tokens.find((t) => t.name === name).value[th]; while (/^\{/.test(v)) v = tokens.find((t) => t.name === v.slice(1, -1)).value[th]; return v; };
const rgb = (h) => {
  const m = h.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
};
const mix = (a, b, w) => [0, 1, 2].map((i) => a[i] * w + b[i] * (1 - w)).concat(1);   // w of a, rest of b (CSS color-mix)
const over = (a, b) => [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function each(fn) { for (const th of TH) { const T = (n) => rgb(val(n, th)); fn(T, th, over(T('panel'), T('bg'))); } }
function atLeast(label, min, a, b, th) { const r = ratio(a, b); assert.ok(r >= min, `${th}: contrast pair ${label} missing or wrong (tokens.json): ${r.toFixed(3)} < ${min}`); }

test('notes editor: ink and placeholder on the whiteboard face', () => each((T, th) => {
  const ink = mix(T('scene-dark'), T('status-finished'), 0.7), hint = mix(T('scene-dark'), T('bubble'), 0.82);
  atLeast('notes ink', 4.5, ink, T('bubble'), th);
  atLeast('notes placeholder', 4.5, hint, T('bubble'), th);
}));

test('City label card: ink and muted on bg', () => each((T, th) => {
  atLeast('label name', 4.5, T('ink'), T('bg'), th);
  atLeast('label sub', 4.5, T('muted'), T('bg'), th);
}));

test('status words: ink on the panel, the chip and the page', () => each((T, th, panel) => {
  for (const bg of [['panel', panel], ['chip', T('chip')], ['bg', T('bg')]]) atLeast('ink on ' + bg[0], 4.5, T('ink'), bg[1], th);
}));

// A dot also sits on a chip (status chips, inbox rows), and ContrastCheck checks it there (agent-office #115).
test('status dots next to the words read at 3:1 on the panel and on chip', () => each((T, th, panel) => {
  for (const [name, bg] of [['panel', panel], ['chip', T('chip')]]) {
    for (const s of ['working', 'waiting', 'error', 'resting', 'finished']) atLeast(`dot ${s} on ${name}`, 3, T('status-' + s), bg, th);
    atLeast('dot emphasis on ' + name, 3, T('emphasis'), bg, th);
  }
}));

// The other pairs of the ContrastCheck card (components/ContrastCheck/preview.html): the label of a primary button, the
// text of a floor header (Reference.md promises 4.9:1 for on-floor), and the type and accent marks.
test('on-accent on accent: 4.5:1; on-floor on every floor-* fill: 4.9:1', () => each((T, th) => {
  atLeast('on-accent on accent', 4.5, T('on-accent'), T('accent'), th);
  for (const f of ['ops', 'sales', 'research', 'content', 'hq']) atLeast(`on-floor on floor-${f}`, 4.9, T('on-floor'), T('floor-' + f), th);
}));

// Accent is text in the DS too: the More link of a decision card sits on chip when the card is selected or focused
// (.ao-dec-more, .ao-dec.is-sel), and a ghost button can sit on a chip row. Raw accent is 4.21:1 on chip in Day, so text
// takes accent-text (#117); accent stays the fill, the focus ring and the 3D scene color.
test('accent-text on chip: 4.5:1 in every theme', () => each((T, th) => {
  atLeast('accent-text on chip', 4.5, T('accent-text'), T('chip'), th);
}));

test('accent-text on card and bg: 4.5:1', () => each((T, th, panel) => {
  atLeast('accent-text on bg', 4.5, T('accent-text'), T('bg'), th);
  atLeast('accent-text on card', 4.5, T('accent-text'), panel, th);
}));

test('accent text rules use accent-text, never raw accent', () => {
  const css = read('components/bundle.css');
  const rule = (sel) => { const i = css.indexOf(sel + '{'); assert.ok(i >= 0, sel); return css.slice(i, css.indexOf('}', i)); };
  for (const sel of ['.ao-dec-more', '.ao-btn-ghost', '.ao-hud-zoom button[aria-pressed="true"]', '.ao-toast-info .ao-toast-i', '.ao-cmdk-o-i[aria-selected="true"] .ao-cmdk-ic', '.ao-cmdk-o-i.is-ask .ao-cmdk-ic', '.ao-notify-b[aria-pressed="true"] .ao-icon']) {
    const r = rule(sel);
    assert.match(r, /(^|[;{])color:var\(--accent-text\)/, sel + ' colors text with accent-text');
    assert.ok(!/(^|[;{ ])color:var\(--accent\)/.test(r), sel + ' uses raw accent as text');
  }
});

// The check mark of the finished bubble is a cut-out of the bubble face, drawn in bubble on the status-finished-on-bubble
// disk (StatusBubble and Kit.prototype.bubble). It is a glyph: 3:1. on-status is for text on a raw status fill and is
// dark in Fluent Dark, where it was 2.77:1 on the disk.
test('finished bubble: the check (bubble) on its disk (status-finished-on-bubble), 3:1', () => each((T, th) => {
  atLeast('check on the finished disk', 3, T('bubble'), T('status-finished-on-bubble'), th);
}));

test('the finished check is drawn in bubble, in 2D and in 3D', () => {
  const b = read('components/bundle.js');
  assert.ok(/h\("path",\{d:"M6\.5 11\.5l3 3 6-6",style:\{stroke:"var\(--bubble\)"\}/.test(b), 'StatusBubble draws the check in bubble');
  assert.ok(/if\(st==="finished"\)\{c\.beginPath\(\);c\.arc\(64,64,40,0,7\);c\.fill\(\);c\.strokeStyle=K\.tok\.bubble;/.test(b), 'Kit.prototype.bubble draws the check in bubble');
});

test('type colors on chip and accent on bg: 3:1', () => each((T, th) => {
  for (const t of ['team', 'lab', 'studio', 'hq', 'security']) atLeast(`type-${t} on chip`, 3, T('type-' + t), T('chip'), th);
  atLeast('accent on bg', 3, T('accent'), T('bg'), th);
}));

// The DS contrast pairs for status text (Reference.md, "Contrast pairs the DS checks"). The raw status-* colors fail
// these on purpose: they are fills and dots. Text uses status-*-text (surfaces) or status-*-on-bubble (bubble faces).
test('status text tokens: 4.5:1 on bg, panel (card) and chip; on-bubble tokens: 4.5:1 on bubble', () => each((T, th, panel) => {
  for (const s of ['working', 'waiting', 'error', 'resting', 'finished']) {
    for (const bg of [['bg', T('bg')], ['card', panel], ['chip', T('chip')]]) atLeast(`status-${s}-text on ${bg[0]}`, 4.5, T(`status-${s}-text`), bg[1], th);
    atLeast(`status-${s}-on-bubble on bubble`, 4.5, T(`status-${s}-on-bubble`), T('bubble'), th);
  }
}));

// Reference.md lists muted at 4.5:1 on bg, card and chip. Pin each of the three.
test('muted text: 4.5:1 on bg, panel (card) and chip', () => each((T, th, panel) => {
  for (const bg of [['bg', T('bg')], ['card', panel], ['chip', T('chip')]]) atLeast('muted on ' + bg[0], 4.5, T('muted'), bg[1], th);
}));

// The terminal panel is a scene-dark face in every theme: status-*-text is for theme surfaces and fails there, so the
// tones are a status color mixed into bubble (office.css, .term-line).
test('terminal tones: 4.5:1 on the scene-dark face', () => each((T, th) => {
  for (const s of ['status-working', 'status-finished', 'status-error', 'emphasis']) atLeast('terminal ' + s, 4.5, mix(T(s), T('bubble'), 0.55), T('scene-dark'), th);
  atLeast('terminal muted', 4.5, mix(T('bubble'), T('scene-dark'), 0.55), T('scene-dark'), th);
}));

test('diff: ink on the chip, and on the added and removed lines', () => each((T, th) => {
  const add = over([...T('status-working').slice(0, 3), 0.16], T('chip')), del = over([...T('status-error').slice(0, 3), 0.16], T('chip'));
  const hunk = over([...T('accent').slice(0, 3), 0.12], T('chip'));
  for (const bg of [T('chip'), add, del, hunk]) atLeast('diff ink', 4.5, T('ink'), bg, th);
}));

test('the CSS keeps status colors off text and uses the ink pairs above', () => {
  const css = read('public/office.css');
  const NL = String.fromCharCode(10);
  const rule = (sel) => {   // every declaration block of the selector
    let out = '', at = css.indexOf(NL + sel + ' {');
    while (at >= 0) { out += css.slice(at, css.indexOf('}', at)); at = css.indexOf(NL + sel + ' {', at + 1); }
    assert.ok(out, 'rule ' + sel);
    return out;
  };
  assert.match(rule('.notes-text'), /color: color-mix\(in srgb, var\(--scene-dark\) 70%, var\(--status-finished\)\)/);
  assert.match(css, /\.notes-text::placeholder \{ color: color-mix\(in srgb, var\(--scene-dark\) 82%, var\(--bubble\)\)/);
  assert.match(rule('.ext-err'), /color: var\(--status-error-text\)/);
  assert.match(rule('.city-wait'), /color: var\(--ink\)/);
  assert.match(rule('.dl.hunk'), /color: var\(--ink\)/);
  assert.match(rule('.dl.meta'), /color: var\(--ink\)/);
  assert.match(rule('.board-tree li.is-hot span:nth-child(2)'), /color: var\(--ink\)/);
  assert.match(rule('.fcode'), /color: var\(--muted\)|color: var\(--ink\)/);
  assert.match(css, /\.fc-M \{ color: var\(--status-waiting-text\); \} \.fc-A, \.fc-\\\? \{ color: var\(--status-working-text\); \} \.fc-D \{ color: var\(--status-error-text\); \}/);
  // Text takes status-*-text or status-*-on-bubble. A raw status-* token (a fill and a dot) is on text only in the
  // mixes pinned above: the notes ink and the terminal tones.
  const MIXES = new Set(['color-mix(in srgb, var(--scene-dark) 70%, var(--status-finished))']
    .concat(['working', 'finished', 'error'].map((s) => `color-mix(in srgb, var(--status-${s}) 55%, var(--bubble))`)));
  let words = 0;
  for (const m of css.matchAll(/(?:^|[;{\s])(?:caret-)?color: ([^;}]+)/g)) {
    const v = m[1].trim();
    for (const t of v.matchAll(/var\(--(status-[a-z-]+)\)/g)) {
      if (/^status-(working|waiting|error|resting|finished)-(text|on-bubble)$/.test(t[1])) { words++; continue; }
      if (!MIXES.has(v)) assert.fail('text colored with ' + t[1] + ': ' + v);
    }
  }
  assert.ok(words >= 4, 'the status words use the text tokens');
});

test('the City label draws on bg, not a bubble', () => {
  const city = read('public/city.js');
  assert.match(city, /g\.fillStyle = tok\['bg'\]/);
  assert.doesNotMatch(city, /g\.fillStyle = tok\['bubble'\]/);
});

// Review minor: the Security room's wall screens (public/security.js) paint canvas text on token colors and token mixes. Every
// text item of every screen state, on the fill drawn under it, reads at 4.5:1 in every theme. The colors come from
// the table the page paints with (OfficeSecurity.pure.TONES, resolved by toneColors as THREE.Color.lerp does in three r147:
// sRGB, legacy color management), so a new tone or a new pair cannot slip past.
test('Security room wall: every canvas text reads at 4.5:1 on the fill under it, in every theme', async () => {
  await import('../src/vocab.mjs'); await import('../public/format.js'); await import('../public/screen-kit.js'); await import('../public/security.js');
  const P = globalThis.OfficeSecurity.pure;
  const NS = { reason: 'The office has no provider for this agent kind yet. The rule applies when it has one.', rows: {} };
  const enforce = { 'claude-code': { reason: '', rows: {}, asks: { shell: 'The agent asks only when its own allow rules and permission mode say so.' }, unset: { 'read-inside': 'The agent decides until you click the cell: then the office makes it ask.' } },
    hermes: { reason: '', rows: { 'read-inside': 'This agent reads files without asking the office.' }, partly: { shell: 'Commands that Hermes rates dangerous come to the office.' } }, dsh: NS, openclaw: NS, local: { reason: '', rows: {} } };
  const rules = { office: { 'shell|claude-code': 'deny', 'web|claude-code': 'allow', 'edit-inside|claude-code': 'ask' }, buildings: { b: { 'mcp|claude-code': 'deny' } } };
  const data = { sec: { rules, enforce, spend: { limit: 2, month: '2026-11', byColumn: { 'claude-code': 1.5 } } }, building: 'b', buildingName: 'repo' };
  const views = [];
  for (const s of globalThis.OfficeVocab.security.screens) {
    for (const paged of [false, true]) for (const scope of ['office', 'building']) for (const focused of [false, true]) {
      const v = { screen: s.id, w: 1280, h: paged ? 1100 : 738, focused, paged, page: 0, scope, pending: null, edit: null, hover: 'cell:shell|claude-code', busy: false, note: null };
      views.push(v, { ...v, note: 'The office did not take the change.' }, { ...v, face: 'back' });
      if (s.id === 'spend') views.push({ ...v, pending: { spend: 0 } }, { ...v, edit: { text: '12' } });
      else views.push({ ...v, pending: { row: s.rows[0], col: 'claude-code', to: s.id === 'agents' ? 'on' : 'allow', office: null } });
    }
  }
  const pairs = new Set();
  for (const v of views) {
    const p = P.plan(v, data), fills = p.items.filter((i) => i.t === 'fill');
    for (const t of p.items.filter((i) => i.t === 'text')) {
      const x = t.align === 'center' ? t.x : t.align === 'right' ? t.x - 2 : t.x + 2, y = t.y - t.s * 0.35;
      const under = fills.filter((f) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h).pop();
      pairs.add(t.c + ' on ' + (under ? under.c : 'face'));
    }
  }
  assert.ok(pairs.has('ink on pending') || pairs.has('onPending on pending'), 'the Confirm cell is checked: ' + [...pairs].join(', '));
  const lerp = (a, b, k) => [0, 1, 2].map((i) => a[i] * (1 - k) + b[i] * k);
  for (const th of TH) {
    const tok = (n) => (tokens.some((t) => t.name === n) ? rgb(val(n, th)).slice(0, 3) : null);
    const C = P.toneColors(tok, lerp);
    for (const pr of pairs) {
      const [a, b] = pr.split(' on ');
      assert.ok(C[a] && C[b], `${pr}: both tones are in the table`);
      atLeast('wall ' + pr, 4.5, C[a].concat(1), C[b].concat(1), th);
    }
  }
});

// #118: on-status could not reach 4.5:1 on all five status fills in any theme, so nothing is drawn with it. The three
// places that did use it draw pairs the DS already checks.
test('danger button: bg on status-error-text, 4.5:1', () => each((T, th) => {
  atLeast('danger label', 4.5, T('bg'), T('status-error-text'), th);
  const css = read('components/bundle.css');
  assert.match(css, /\.ao-btn-danger\{background:var\(--status-error-text\);color:var\(--bg\)/);
}));

test('terminal status word: scene-dark on the status mixed into bubble (55%), 4.5:1', () => each((T, th) => {
  for (const s of ['working', 'waiting', 'error', 'resting', 'finished']) atLeast('terminal word ' + s, 4.5, T('scene-dark'), mix(T('status-' + s), T('bubble'), 0.55), th);
  const js = read('public/terminal.js');
  assert.ok(!/on-status|onStatus/.test(js), 'terminal.js does not draw with on-status');
}));

test('door sign count: bg on status-working-text, 4.5:1', () => each((T, th) => {
  atLeast('door count', 4.5, T('bg'), T('status-working-text'), th);
  assert.ok(!/on-status/.test(read('public/board.js')), 'board.js does not draw with on-status');
}));

// #92 review: the lobby's painted faces (public/lobby.js FACES): the reception memo and the directory board are paper, the desk
// nameplate is the reverse. Every text at 4.5:1 on its face, the lighter lines (a wing name, a nameplate's lane and cost) with the
// alpha they are painted at; a directory state dot at 3:1 on the paper (its row also says the state in words). The paint code
// takes every color from FACES, so these are the pairs on screen.
test('lobby: the memo, the directory board and the nameplate read in every theme (lobby.js FACES)', async () => {
  await import('../src/vocab.mjs'); await import('../public/format.js'); await import('../public/screen-kit.js'); await import('../public/lobby.js');
  const L = globalThis.OfficeLobby.pure, F = L.FACES;
  each((T, th) => {
    atLeast('memo text', 4.5, T(F.memo.ink), T(F.memo.face), th);
    atLeast('memo band', 3, T(F.memo.band), T(F.memo.face), th);
    atLeast('directory text', 4.5, T(F.directory.ink), T(F.directory.face), th);
    atLeast('directory wing name', 4.5, mix(T(F.directory.ink), T(F.directory.face), F.directory.wingAlpha), T(F.directory.face), th);
    const tok = Object.fromEntries(tokens.map((t) => [t.name, val(t.name, th)]));
    for (const s of ['error', 'waiting', 'review', 'working', 'finished', 'resting']) atLeast('directory dot ' + s, 3, rgb(L.dotOf(tok, s)), T(F.directory.face), th);
    atLeast('pipeline text', 4.5, T(F.pipeline.ink), T(F.pipeline.face), th);
    atLeast('pipeline No data and foot', 4.5, mix(T(F.pipeline.ink), T(F.pipeline.face), F.pipeline.mutedAlpha), T(F.pipeline.face), th);
    atLeast('pipeline bar', 3, mix(T(F.pipeline.ink), T(F.pipeline.face), F.pipeline.barAlpha), T(F.pipeline.face), th);
    atLeast('nameplate name', 4.5, T(F.plate.ink), T(F.plate.face), th);
    atLeast('nameplate lane and cost', 4.5, mix(T(F.plate.ink), T(F.plate.face), F.plate.detailAlpha), T(F.plate.face), th);
    atLeast('clock line', 4.5, T(F.clock.ink), T(F.clock.face), th);
  });
  // every color of the paint functions comes from FACES (or dotOf), never a raw token name
  const src = read('public/lobby.js');
  for (const fn of ['paintMemo', 'paintDirectory', 'paintPipeline', 'paintPlate', 'paintClock']) {
    const body = src.slice(src.indexOf('function ' + fn + '('), src.indexOf('\n    }\n', src.indexOf('function ' + fn + '(')));
    assert.ok(body.length > 40, fn);
    assert.doesNotMatch(body, /tok\[['"]|tok\.[a-z]|#[0-9a-f]{3}\b/i, fn + ' paints with FACES only');
    assert.match(body, /FACES\.(memo|directory|pipeline|plate|clock)/, fn);
  }
});

// #90: the desk objects' painted faces (public/desk.js FACES): the approval paper, its Approve stamp, the question note and the
// pause key. Every text at 4.5:1 on its face, the bands (the strip on top of a paper) at 3:1.
test('desk: the approval paper, the stamps, the question note and the pause key read in every theme (desk.js FACES)', async () => {
  await import('../public/scene-host.js'); await import('../public/screen-kit.js'); await import('../public/desk.js');
  const F = globalThis.OfficeDesk.pure.FACES;
  each((T, th) => {
    atLeast('paper text', 4.5, T(F.paper.ink), T(F.paper.face), th);
    atLeast('paper band', 3, T(F.paper.band), T(F.paper.face), th);
    atLeast('paper high-risk band', 3, T(F.paper.high), T(F.paper.face), th);
    atLeast('Approve stamp', 4.5, T(F.stamp.ink), T(F.stamp.face), th);
    atLeast('note text', 4.5, T(F.note.ink), T(F.note.face), th);
    atLeast('note band', 3, T(F.note.band), T(F.note.face), th);
    atLeast('pause key', 4.5, T(F.key.ink), T(F.key.face), th);
  });
  const src = read('public/desk.js');
  for (const fn of ['stamp', 'paintPaper', 'paintNote', 'paintKey']) {
    const at = src.indexOf('function ' + fn + '('), body = src.slice(at, src.indexOf('\n    }\n', at));
    assert.ok(body.length > 40, fn);
    assert.doesNotMatch(body, /tok\[['"]|tok\.[a-z]|#[0-9a-f]{3}\b/i, fn + ' paints with FACES only');
  }
});

test('agent character: the accessory and arm marks read on every bot body color a persona can pick, in the better of scene-dark and bubble', async () => {
  const { loadBundle } = await import('./fixtures/ds-bundle.mjs');
  await import('../src/vocab.mjs');
  const P = globalThis.OfficeVocab.persona;
  const bodies = Array.from(loadBundle().AO.BODY_COLORS).slice(0, 8);
  assert.equal(bodies.length, 8, 'the eight persona colors');
  const hex = (n, th) => val(n, th);
  each((T, th) => {
    for (const b of bodies) {
      const pick = P.markOn(b, hex('scene-dark', th), hex('bubble', th));
      atLeast('persona mark (' + pick + ') on body ' + b, 3, T(pick), rgb(b), th);
    }
  });
});

test('agent character: persona.js draws with scene-dark and bubble only, no literal color and no status color', () => {
  const js = read('public/persona.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b|rgba?\(/.test(js), 'no literal color');
  assert.ok(!/status-/.test(js), 'no status color');
});
