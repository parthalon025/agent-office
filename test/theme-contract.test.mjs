// The theme contract (agent-office #131). A theme is one checklist (Recipes.md, "Add a theme"), and this file checks every part of
// it for every theme. It has no theme list of its own: the list is color.themes of tokens.json, so a new theme is checked as soon
// as it is there. A failure names the theme, the missing part and the file that owns it, for example
// "fluent-dark: no office type picture for security (owner: components/bundle.js, AgentOffice.THUMBS_BY_THEME)".
// The parts, in recipe order: 1 theme entry, 2 colors and shadow, 3 light and fx tokens (and family faces and corners),
// 4 tokens.css block, 5 LOOKS and FX, 6 MODES entry, 7 icon, 8 office type pictures, 9 portraits and logos, 10 contrast,
// 11 Reference, 12 docs and the fit of the mode control.
// Tests that pin one theme's own behavior (for example "Fluent Dark sky is between Night and Fluent") stay in their files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { root, read, tokens, schema, bundleCss, themes, AO, rootVals, themeBlock, looksAndFx } from './fixtures/ds-theme.mjs';

const ids = themes.map((t) => t.id);
const colors = tokens.color.tokens;
const modes = Array.from(AO.MODES);
const modeOf = (id) => modes.find((m) => m.theme === id);
const family = (id) => id.split('-')[0];
const officeTypes = colors.filter((t) => /^type-/.test(t.name)).map((t) => t.name.slice(5));
const lines = bundleCss.split('\n');
const darkCss = (() => {
  const rule = lines.filter((l) => /\{color-scheme:dark\}$/.test(l) && l.startsWith('[data-theme='));
  return rule.length === 1 ? [...rule[0].matchAll(/\[data-theme="([a-z-]+)"\]/g)].map((m) => m[1]) : null;
})();
const OWN = {
  tokens: 'tokens.json', css: 'tokens.css', bundle: 'components/bundle.js', bundleCss: 'components/bundle.css', ref: 'Reference.md',
};

/** Collect gaps, then fail once with all of them, so a new theme shows every missing part in one run. */
function check(fn) {
  const gaps = [];
  fn((id, what, owner) => gaps.push(`${id}: ${what} (owner: ${owner})`));
  assert.deepEqual(gaps, [], '\n' + gaps.join('\n'));
}

// A table of a Markdown file: the rows after the heading line, as arrays of cells (backticks kept).
function table(text, heading) {
  const at = text.indexOf(heading);
  assert.ok(at >= 0, `${heading} is in the docs`);
  const rows = [];
  for (const l of text.slice(at + heading.length).split('\n').slice(1)) {
    if (!l.startsWith('|')) { if (rows.length) break; continue; }
    rows.push(l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  }
  return rows.slice(2);   // the header row and the rule row are the first two lines after the blank one
}
const ref = read('Reference.md');
const bare = (c) => c.replace(/`/g, '');
const list = (c) => bare(c).split(',').map((x) => x.trim()).filter(Boolean);

test('1. theme entry: ids are unique data-theme values with a name; Tour is a mode, not a theme', () => {
  assert.ok(themes.length >= 3, 'tokens.json lists themes');
  assert.deepEqual(ids.slice(0, 3), ['light', 'dark', 'sublevel'], 'Day, Night and Sublevel stay first, in that order');
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const t of themes) { assert.match(t.id, /^[a-z]+(-[a-z]+)*$/, `${t.id}: id is a data-theme value`); assert.ok(t.name, `${t.id}: name`); }
  assert.ok(!ids.includes('tour'), 'Tour is not a theme');
});

test('2. colors and shadow: every color token and shadow-panel has a value in every theme, and an alias names a token', () => {
  const names = new Set(colors.map((t) => t.name));
  const shadow = tokens.shadow.tokens.find((t) => t.name === 'shadow-panel');
  check((gap) => {
    for (const id of ids) {
      for (const t of colors) {
        const v = t.value[id];
        if (typeof v !== 'string' || !v) gap(id, `no value for color token ${t.name}`, OWN.tokens);
        else if (/^\{/.test(v) && !names.has(v.slice(1, -1))) gap(id, `${t.name} is an alias of ${v}, which is no color token`, OWN.tokens);
      }
      if (!shadow || typeof shadow.value[id] !== 'string' || !shadow.value[id]) gap(id, 'no value for shadow-panel', OWN.tokens);
    }
    for (const t of colors) for (const k of Object.keys(t.value)) if (!ids.includes(k)) gap(k, `${t.name} has a value for a theme that is not listed`, OWN.tokens);
  });
});

test('3. light and fx tokens for the look; font and radius tokens of a family have their rule in bundle.css', () => {
  const light = new Set(tokens.light.tokens.map((t) => t.name)), fx = new Set(tokens.fx.tokens.map((t) => t.name));
  check((gap) => {
    for (const id of ids) {
      const m = modeOf(id);
      if (!m) continue;   // part 6 names it
      for (const k of ['sky', 'sun', 'lamp']) if (!light.has(`light-${m.id}-${k}`)) gap(id, `no light-${m.id}-${k} token`, OWN.tokens);
      for (const k of ['bloom', 'threshold', 'exposure', 'fog', 'vignette']) if (!fx.has(`fx-${k}-${m.id}`)) gap(id, `no fx-${k}-${m.id} token`, OWN.tokens);
    }
    for (const f of new Set(ids.map(family))) {
      const faces = Object.keys(tokens.type.families).filter((n) => n.startsWith(f + '-')).map((n) => `font-${n}`);
      const corners = tokens.radius.tokens.filter((t) => t.name.startsWith(`radius-${f}-`)).map((t) => t.name);
      if (!faces.length && !corners.length) continue;
      const rule = lines.find((l) => l.startsWith(`[data-theme="${f}"]{`) || l.startsWith(`[data-theme|="${f}"]{`));
      if (!rule) { gap(f, `has ${[...faces, ...corners].join(', ')} but no [data-theme="${f}"] or [data-theme|="${f}"] rule sets them`, OWN.bundleCss); continue; }
      for (const n of [...faces, ...corners]) if (!rule.includes(`var(--${n})`)) gap(f, `the family rule does not use --${n}`, OWN.bundleCss);
    }
  });
});

test('4. tokens.css: a block for each theme with the token values of tokens.json and the right color-scheme', () => {
  assert.ok(darkCss, 'bundle.css has one rule that lists the dark themes');
  check((gap) => {
    for (const id of ids) {
      const block = themeBlock(id);
      if (!block) { gap(id, `no [data-theme="${id}"] block`, OWN.css); continue; }
      for (const t of [...colors, tokens.shadow.tokens.find((s) => s.name === 'shadow-panel')]) {
        const m = block.match(new RegExp(`\\n\\s*--${t.name}: ([^;]+);`)), v = t.value[id];
        if (!m) gap(id, `--${t.name} is missing`, OWN.css);
        else if (m[1] !== String(v).replace(/^\{(.+)\}$/, 'var(--$1)')) gap(id, `--${t.name} is ${m[1]}, tokens.json says ${v}`, OWN.css);
      }
      const dark = modeOf(id)?.dark === true;
      if (dark !== darkCss.includes(id)) gap(id, dark ? 'is dark in MODES but not in the color-scheme:dark rule' : 'is in the color-scheme:dark rule but not dark in MODES', OWN.bundleCss);
    }
    for (const t of [...tokens.light.tokens, ...tokens.fx.tokens]) if (rootVals[t.name] !== String(t.value)) gap('all', `--${t.name} is ${rootVals[t.name]}, tokens.json says ${t.value}`, OWN.css);
  });
});

test('5. engine tables: LOOKS and FX have the look, read from its light and fx tokens', () => {
  const { LOOKS, FX } = looksAndFx();
  check((gap) => {
    for (const id of ids) {
      const m = modeOf(id);
      if (!m) continue;
      const L = LOOKS[m.id];
      if (!L) { gap(id, `no LOOKS.${m.id}`, 'components/bundle.js, LOOKS'); continue; }
      for (const [k, tok] of [['hi', 'sky'], ['si', 'sun'], ['lamp', 'lamp']]) if (L[k] !== parseFloat(rootVals[`light-${m.id}-${tok}`])) gap(id, `LOOKS.${m.id}.${k} is not light-${m.id}-${tok}`, 'components/bundle.js, LOOKS');
      for (const k of ['hc', 'hg', 'sc']) if (typeof L[k] !== 'number') gap(id, `LOOKS.${m.id}.${k} is not a number`, 'components/bundle.js, LOOKS');
      if (!Array.isArray(L.sp) || L.sp.length !== 3) gap(id, `LOOKS.${m.id}.sp is not a sun position`, 'components/bundle.js, LOOKS');
      for (const [k, tok] of [['bloom', 'bloom'], ['thr', 'threshold'], ['exp', 'exposure'], ['fog', 'fog'], ['vig', 'vignette']]) {
        if (FX[k]?.[m.id] !== parseFloat(rootVals[`fx-${tok}-${m.id}`])) gap(id, `FX.${k}.${m.id} is not fx-${tok}-${m.id}`, 'components/bundle.js, FX');
      }
    }
  });
});

test('6. MODES: one entry per theme and one theme per entry, each with a look, a label, an icon of its own and a dark flag', () => {
  check((gap) => {
    for (const t of themes) {
      const m = modeOf(t.id);
      if (!m) { gap(t.id, 'no AgentOffice.MODES entry', 'components/bundle.js, AO.MODES'); continue; }
      if (!m.id) gap(t.id, 'MODES entry has no look id', 'components/bundle.js, AO.MODES');
      if (m.label !== t.name) gap(t.id, `MODES label ${m.label} is not the tokens.json name ${t.name}`, 'components/bundle.js, AO.MODES');
      if (!m.icon) gap(t.id, 'MODES entry has no icon', 'components/bundle.js, AO.MODES');
      if (!(m.dark === true || m.dark === undefined)) gap(t.id, 'MODES dark is true or not set', 'components/bundle.js, AO.MODES');
    }
    for (const m of modes) if (!ids.includes(m.theme)) gap(m.theme, 'a MODES entry has no theme in tokens.json', OWN.tokens);
    for (const k of ['id', 'icon', 'theme']) if (new Set(modes.map((m) => m[k])).size !== modes.length) gap('all', `two MODES entries share a ${k}: below 520 px the toggle shows icons only`, 'components/bundle.js, AO.MODES');
  });
  assert.deepEqual(modes.map((m) => m.theme), ids, 'MODES lists the themes of tokens.json, in order');
  assert.deepEqual(modes.slice(0, 3).map((m) => m.id), ['day', 'night', 'sublevel']);
});

test('7. icon: each MODES icon is in AO.ICONS, kit/schema.json and assets/Icons, and draws the same shapes', () => {
  check((gap) => {
    for (const m of modes) {
      if (!AO.ICONS[m.icon]) { gap(m.theme, `icon ${m.icon} is not in AO.ICONS`, 'components/bundle.js, AO.ICONS'); continue; }
      if (!schema.icons.includes(m.icon)) gap(m.theme, `icon ${m.icon} is not in kit/schema.json`, 'kit/schema.json');
      const file = join(root, 'assets', 'Icons', m.icon + '.svg');
      if (!fs.existsSync(file)) { gap(m.theme, `no assets/Icons/${m.icon}.svg`, 'assets/Icons'); continue; }
      const inner = AO.ICONS[m.icon].replace(/^<g[^>]*>|<\/g>$/g, '').replace(/currentColor/g, '#18212b');
      if (!fs.readFileSync(file, 'utf8').includes(inner)) gap(m.theme, `assets/Icons/${m.icon}.svg does not draw the shapes of the bundle icon`, 'assets/Icons');
    }
  });
});

// The shared-assets list: Reference.md, "Shared assets". One row per asset: its own sets and the themes on the default set.
const shared = Object.fromEntries(table(ref, '#### Shared assets').map(([asset, own, dflt]) => [asset, { own: own === 'every theme' ? ids : list(own), dflt: list(dflt).filter((x) => x !== 'none') }]));

test('Shared assets: the list covers every asset, names real themes, and puts each theme in one column', () => {
  assert.deepEqual(Object.keys(shared), ['Office type pictures', 'Bot portraits', 'Logo mark and wordmark']);
  check((gap) => {
    for (const [asset, { own, dflt }] of Object.entries(shared)) {
      for (const id of [...own, ...dflt]) if (!ids.includes(id)) gap(id, `${asset}: the Shared assets list names a theme that tokens.json does not have`, OWN.ref);
      for (const id of ids) {
        const n = own.includes(id) + dflt.includes(id);
        if (n === 0) gap(id, `${asset}: in neither column of the Shared assets list`, OWN.ref);
        if (n === 2) gap(id, `${asset}: in both columns of the Shared assets list`, OWN.ref);
      }
    }
  });
});

test('8. office type pictures: every office type has a picture in every theme, or the theme is listed as sharing the default set', () => {
  assert.ok(officeTypes.length >= 5, 'the office types come from the type-* tokens');
  check((gap) => {
    for (const id of ids) {
      const set = AO.THUMBS_BY_THEME[id];
      if (!set) {
        if (!shared['Office type pictures'].dflt.includes(id)) gap(id, 'no THUMBS_BY_THEME set and not listed as sharing one', 'components/bundle.js, AgentOffice.THUMBS_BY_THEME');
        continue;
      }
      for (const type of officeTypes) if (typeof set[type] !== 'string' || !set[type].startsWith('<svg')) gap(id, `no office type picture for ${type}`, 'components/bundle.js, AgentOffice.THUMBS_BY_THEME');
    }
    for (const id of Object.keys(AO.THUMBS_BY_THEME)) if (!ids.includes(id)) gap(id, 'THUMBS_BY_THEME has a set for a theme that tokens.json does not have', 'components/bundle.js');
  });
});

test('9. portraits and logos: each theme has its own set that works, or is listed as on the default set', () => {
  const ownPortraits = (id) => AO['PORTRAITS_' + id.toUpperCase().replace(/-/g, '_')];
  const ownLogo = (id) => AO.LOGO && AO.LOGO[id];
  check((gap) => {
    for (const id of ids) {
      for (const [asset, own, owner] of [['Bot portraits', ownPortraits(id), 'components/bundle.js, AgentOffice.PORTRAITS'], ['Logo mark and wordmark', ownLogo(id), 'components/bundle.js, AgentOffice.LOGO']]) {
        const { own: ownList, dflt } = shared[asset];
        if (own && !ownList.includes(id)) gap(id, `${asset}: has its own set but the Shared assets list does not say so`, OWN.ref);
        if (!own && ownList.includes(id)) gap(id, `${asset}: the Shared assets list says it has its own set, the bundle has none`, owner);
        if (!own && !dflt.includes(id)) gap(id, `${asset}: no own set and not listed as on the default set`, OWN.ref);
        if (own && dflt.includes(id)) gap(id, `${asset}: listed as on the default set but has its own`, OWN.ref);
      }
      const p = ownPortraits(id);
      if (p) for (const shape of Object.keys(AO.PORTRAITS)) if (typeof p[shape] !== 'function') gap(id, `its own portraits have no ${shape}`, 'components/bundle.js, AgentOffice.PORTRAITS');
      const l = ownLogo(id);
      if (l && !(l.wordmarkPath && l.wordmarkViewBox)) gap(id, 'its own logo has no wordmark path and view box', 'components/bundle.js, AgentOffice.LOGO');
    }
  });
});

test('10. contrast: test/contrast.test.mjs runs the pairs in every theme of tokens.json, with no theme list of its own', () => {
  const src = read('test/contrast.test.mjs');
  assert.match(src, /color\.themes\.map\(/, 'it reads the themes from tokens.json');
  assert.doesNotMatch(src, /'fluent(-dark)?'/, 'it types no theme id beyond the pinned first three');
});

test('11. Reference: a column for every theme in the color table, a value in the shadow, a row in Themes, and a row for every light and fx token', () => {
  check((gap) => {
    const head = ref.split('\n').find((l) => l.startsWith('| Token | '));
    const cols = head.split('|').slice(2, -2).map((c) => c.trim());
    if (cols.join() !== ids.join()) gap('all', `the color table has the columns ${cols.join(', ')}, tokens.json has ${ids.join(', ')}`, OWN.ref);
    const themesTable = table(ref, '### Themes').filter((r) => r.length >= 6);
    for (const m of modes) {
      const row = themesTable.find((r) => bare(r[1]) === m.theme);
      if (!row) gap(m.theme, 'no row in the Themes table', OWN.ref);
      else if (bare(row[0]) !== m.id || row[2] !== m.label || bare(row[3]) !== m.icon || (bare(row[4]) === 'true') !== (m.dark === true)) gap(m.theme, 'its Themes row does not match its MODES entry', OWN.ref);
    }
    const sh = ref.split('\n').find((l) => l.startsWith('| `shadow-panel` |')) || '';
    for (const id of ids) if (!sh.includes(`"${id}"`)) gap(id, 'the shadow-panel row has no value', OWN.ref);
    for (const t of [...tokens.light.tokens, ...tokens.fx.tokens]) if (!ref.includes(`| \`${t.name}\` |`)) gap('all', `no row for ${t.name}`, OWN.ref);
    for (const t of colors) {
      const row = ref.split('\n').find((l) => l.startsWith(`| \`${t.name}\` | `) && l.split('|').length > ids.length + 3);
      if (!row) { gap('all', `no row for ${t.name} in the color table`, OWN.ref); continue; }
      const cells = row.split('|').slice(2, 2 + ids.length).map((c) => bare(c.trim()));
      // an alias may be shown as the alias or as the value it resolves to
      const resolved = (id) => { let v = t.value[id]; while (/^\{/.test(v)) v = colors.find((c) => c.name === v.slice(1, -1)).value[id]; return v; };
      ids.forEach((id, i) => { if (cells[i] !== t.value[id] && cells[i] !== resolved(id)) gap(id, `the Reference value of ${t.name} is ${cells[i]}, tokens.json says ${t.value[id]}`, OWN.ref); });
    }
  });
});

test('11. Reference: the Fluent 2 provenance table has a row for every color token and each cell names its source or its reason', () => {
  const fluent = ids.filter((id) => id.startsWith('fluent'));
  const rows = table(ref, '#### Fluent 2 provenance').filter((r) => r.length === 3 && r[0].startsWith('`'));
  const head = ref.split('\n').find((l) => l.startsWith('| Token | Fluent source'));
  assert.equal(head.split('|').length - 2 - 1, fluent.length, `one source column for each of ${fluent.join(', ')}`);
  check((gap) => {
    for (const t of colors) {
      const row = rows.find((r) => bare(r[0]) === t.name);
      if (!row) { gap('fluent', `no provenance row for ${t.name}`, OWN.ref); continue; }
      fluent.forEach((id, i) => {
        const cell = row[1 + i], v = t.value[id];
        if (/^\{/.test(v)) { if (cell !== `alias of \`${v.slice(1, -1)}\``) gap(id, `${t.name} is an alias of ${v}, the provenance cell says: ${cell}`, OWN.ref); }
        else if (!/^`color[A-Za-z0-9]+` \(matches\)$/.test(cell) && !/^own: .*; .{8,}$/.test(cell)) gap(id, `${t.name}: the provenance cell is neither a source token "(matches)" nor "own: <nearest>; <reason>": ${cell}`, OWN.ref);
      });
    }
  });
});

test('12. docs: the Definition of done, "Test your page" and the CLAUDE.md screenshot line name every theme and the count', () => {
  const names = themes.map((t) => t.name);
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const items = (s) => s.split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
  const dod = read('DS-README.md').match(/Screenshots in all (\w+) themes \(([^)]*)\)/);
  const test1 = read('Recipes.md').match(/Screenshots: ([^;]*);/);
  const claude = read('CLAUDE.md').match(/look at screenshots in ([^\n]*?) at 1360/);
  check((gap) => {
    if (!dod) gap('all', 'the Definition of done has no "Screenshots in all <n> themes (...)" line', 'DS-README.md');
    else {
      if (dod[1] !== words[themes.length]) gap('all', `the Definition of done says ${dod[1]} themes, tokens.json has ${words[themes.length]}`, 'DS-README.md');
      for (const n of names) if (!items(dod[2]).includes(n)) gap(n, 'not in the Definition of done screenshot line', 'DS-README.md');
    }
    if (!test1) gap('all', 'Recipes "Test your page" has no "Screenshots: ..." line', 'Recipes.md');
    else for (const n of names) if (!items(test1[1]).includes(n)) gap(n, 'not in the Recipes "Test your page" screenshot line', 'Recipes.md');
    if (!claude) gap('all', 'CLAUDE.md has no "look at screenshots in ... at 1360" line', 'CLAUDE.md');
    else for (const n of names) if (!items(claude[1]).includes(n)) gap(n, 'not in the CLAUDE.md screenshot line', 'CLAUDE.md');
  });
});

// Fit rule (story 23): under 520 px of office width the segments with an icon show the icon only, and the pressed one keeps its
// label. Each icon segment is its padding (10 + 10) and the 14 px icon; the pressed one adds its label at about 7 px a letter
// (12 px type); the control adds its padding (4 + 4) and a 2 px gap between segments. Tour is one more segment. The control
// must fit the narrowest phone page, 400 px with the 16 px side gutters, so a theme that would not fit fails here.
test('the mode control fits 400 px with the current number of MODES entries and Tour', () => {
  assert.match(bundleCss, /@container \(max-width:520px\)\{\.ao-seg button:not\(\[aria-pressed="true"\]\) \.ao-seg-l\{/, 'the icon-only breakpoint is 520 px');
  assert.match(bundleCss, /\.ao-seg button\{[^}]*padding:6px 10px/, 'the segment padding is the one this budget assumes');
  const segs = modes.length + 1;
  const longest = Math.max(...modes.map((m) => m.label.length), 'Tour'.length);
  const width = 8 + segs * (10 + 10 + 14) + (segs - 1) * 2 + longest * 7;
  const room = 400 - 2 * 16;
  assert.ok(width <= room, `${modes.length} modes and Tour need about ${width} px, the 400 px page has ${room} px: show fewer labels or stack the control, then update this budget`);
});
