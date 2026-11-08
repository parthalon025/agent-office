// One test for every skin (agent-office #131). A skin (a theme) is a token set plus a component set, and every skin runs exactly
// the same checks: the skin list comes from tokens.json, and no check names a skin, keeps a list of skins or makes an exception for
// one. Adding a skin to tokens.json runs it through every part below at once. The parts are in the order of Recipes.md, "Add a
// theme"; a failure reads "<skin>: <part> missing or wrong (<owner file>)", then what is wrong.
// A value that is one skin's choice (how bright its sky is, how round its corners are) is data in its tokens: no test pins it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');
const J = JSON.parse(read('tokens.json'));
const SKINS = J.color.themes;
const css = read('tokens.css'), bundleCss = read('components/bundle.css'), bundleJs = read('components/bundle.js');
const reference = read('docs/design-system/Reference.md');

// The DS bundle in a Node VM with the vendored React (as test/rich.test.mjs does): the skin parts are its public exports.
const sb = { console, URL };
sb.window = sb.self = sb;
vm.createContext(sb);
vm.runInContext(read('public/vendor/react.production.min.js'), sb, { filename: 'react.production.min.js' });
vm.runInContext(bundleJs, sb, { filename: 'bundle.js' });
const AO = sb.AgentOffice;

// tokens.json: every token that has one value per theme, by group
const PER_THEME = [['color', J.color.tokens], ['shadow', J.shadow.tokens], ['skin', J.skin.tokens]];
const perTheme = PER_THEME.flatMap(([g, list]) => list.map((t) => ({ ...t, group: g })));
const flat = Object.fromEntries(perTheme.map((t) => [t.name, t]));
const nonColor = ['spacing', 'radius', 'blur', 'opacity', 'zIndex', 'duration', 'easing', 'breakpoint', 'scene', 'light', 'fx'].flatMap((g) => J[g].tokens.map((t) => t.name));
const valueOf = (name, th) => { let v = flat[name]?.value?.[th]; for (let i = 0; i < 9 && /^\{.+\}$/.test(v || ''); i++) v = flat[v.slice(1, -1)]?.value?.[th]; return v; };

// tokens.css: the block of a theme (the first theme is the :root block) and the system dark block
const block = (open) => { const at = css.indexOf(open); return at < 0 ? null : css.slice(at, css.indexOf('\n}', at)); };
const blockOf = (i) => block(i === 0 ? `:root, [data-theme="${SKINS[0].id}"] {` : `\n[data-theme="${SKINS[i].id}"] {`);
const prop = (text, name) => text?.match(new RegExp(`\\n\\s*--${name}: ([^;]+);`))?.[1];
const scheme = (text) => text?.match(/\n\s*color-scheme: ([^;]+);/)?.[1];

// contrast (WCAG), as test/contrast.test.mjs computes it
const rgb = (h) => { const m = h.match(/rgba?\(([^)]+)\)/); if (m) return m[1].split(',').map(Number).slice(0, 3); return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// The rules of a style sheet: { cond, sel, body } (cond is the @container or @media around the rule)
function cssRules(text) {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, ''), out = [];
  (function walk(from, to, cond) {
    for (let j = from; j < to;) {
      const open = s.indexOf('{', j);
      if (open < 0 || open >= to) break;
      let depth = 1, k = open + 1;
      for (; depth && k < to; k++) { if (s[k] === '{') depth++; else if (s[k] === '}') depth--; }
      const head = s.slice(j, open).trim().replace(/\s+/g, ' ');
      if (head.startsWith('@')) walk(open + 1, k - 1, head); else out.push({ cond, sel: head, body: s.slice(open + 1, k - 1).trim() });
      j = k;
    }
  })(0, s.length, '');
  return out;
}
const RULE_FILES = ['components/bundle.css', 'public/office.css'];
const rules = RULE_FILES.flatMap((f) => cssRules(read(f)).map((r) => ({ ...r, file: f })));
// does one selector (of a list) apply to an element in the skin? A theme selector [data-theme|="x"] applies to x and x-*.
const family = (id) => id.split('-')[0];
const themeSels = (sel) => [...sel.matchAll(/\[data-theme(\|?)="([a-z-]+)"\]/g)].map((m) => ({ family: m[1] === '|', id: m[2] }));
const appliesTo = (oneSel, id) => themeSels(oneSel).every((t) => (t.family ? id === t.id || id.startsWith(t.id + '-') : id === t.id));

// The JS files the DS and the page run
const CODE = ['components/bundle.js', ...fs.readdirSync(new URL('public/', root)).filter((f) => f.endsWith('.js')).map((f) => 'public/' + f),
  ...fs.readdirSync(new URL('kit/', root)).filter((f) => f.endsWith('.js')).map((f) => 'kit/' + f)];

const ICON_SCHEMA = JSON.parse(read('kit/schema.json')).icons;
const CONTRAST_CARD = JSON.parse(read('components/ContrastCheck/preview.html').match(/var P=(\[\[[\s\S]*?\]\]);/)[1]);
const modeOf = (id) => AO.MODES.filter((m) => m.theme === id);
const MODE_FIELDS = { id: 'string', theme: 'string', label: 'string', icon: 'string', dark: 'boolean', retro: 'boolean', wordmark: 'string', wrapper: 'string' };
const LOOK_FIELDS = Object.keys(AO.office.LOOKS[AO.MODES[0].id]);
// The declared tables of components/bundle.js: the only code that names a theme or a look id (AO.MODES, the engine's LOOKS and FX,
// the keys of AO.ICONS). Each runs from its marker to its matching bracket, and is blanked before part 15 reads the code. Nothing else
// is blanked: a named office (SublevelOffice, FluentOffice) takes its default theme from the MODES entry that names it in "wrapper".
const TABLES = ['AO.MODES=[', 'LOOKS={', 'var FX={', 'AO.ICONS = {'];
function withoutTables(text) {
  let out = text;
  for (const mark of TABLES) {
    const at = out.indexOf(mark);
    if (at < 0) continue;
    let i = at + mark.length - 1, depth = 0, q = null;
    for (; i < out.length; i++) {
      const c = out[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(at, i + 1).replace(/[^\n]/g, ' ') + out.slice(i + 1);
  }
  return out;
}
const CODE_TEXT = Object.fromEntries(CODE.map((f) => [f, withoutTables(read(f))]));
const FIELD_NAMES = new Set([...Object.keys(AO.MODES[0]), ...LOOK_FIELDS]);
// The bot colors: the colors a bot portrait has for each body color of AO.BODY_COLORS (body, shade, light), without the ink, which
// is a token. The one prop palette of the drawn parts.
const BOT_PALETTE = new Set(Array.from(AO.BODY_COLORS).flatMap((c) => Object.values(AO.PORTRAITS).flatMap((p) => p(c, { ink: 'currentColor', gloss: 1, outline: 1, eyesSquare: 1 }).match(/#[0-9a-f]{6}/g) || [])));

// A page for the drawn parts that read their theme in JS (Logo, OfficeTypeCard): plain nodes with data-theme, and the tokens that
// tokens.css gives a node. That is the block of the nearest data-theme that is a theme; with none, the system dark block (the first
// block with color-scheme dark) when <html> has no data-theme and the system scheme is dark, else the :root block (the first theme).
const SYSTEM_DARK = SKINS.find((s, i) => scheme(blockOf(i)) === 'dark')?.id;
const DISPATCHER = sb.React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
const node = (theme, parentNode = null) => ({ attrs: theme == null ? {} : { 'data-theme': theme }, parentNode, getAttribute(k) { return this.attrs[k] ?? null; } });
function cssTheme(el, html, dark) {
  for (let n = el; n; n = n.parentNode) if (SKINS.some((s) => s.id === n.attrs['data-theme'])) return n.attrs['data-theme'];
  return html.attrs['data-theme'] == null && dark && SYSTEM_DARK ? SYSTEM_DARK : SKINS[0].id;
}
// page(theme, dark): <html> with that data-theme (null: none) and that system scheme. mount(Comp, props, parent) renders one component
// with stand-in hooks (as test/rich.test.mjs does), makes a node for each of its host elements under parent, sets the refs to them,
// runs the layout effects, and renders again while an effect changes state. It gives the last tree.
function page(theme, dark) {
  const html = node(theme);
  Object.assign(sb, { document: { documentElement: html }, matchMedia: (q) => ({ matches: dark && /prefers-color-scheme: dark/.test(q) }),
    getComputedStyle: (el) => ({ getPropertyValue: (n) => valueOf(n.replace(/^--/, ''), cssTheme(el, html, dark)) }) });
  const mount = (Comp, props, parent = html) => {
    const slots = [];
    let i = 0, dirty = false, effects = [];
    const hooks = {
      useState(init) { const k = i++; if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init; return [slots[k], (v) => { v = typeof v === 'function' ? v(slots[k]) : v; if (!Object.is(v, slots[k])) { slots[k] = v; dirty = true; } }]; },
      useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
      useContext(ctx) { return ctx._currentValue; },
      useLayoutEffect(fn, deps) { const k = i++, old = slots[k]; slots[k] = deps; if (!deps || !old || deps.some((d, j) => !Object.is(d, old[j]))) effects.push(fn); },
      useEffect() { i++; },
      useMemo(f) { i++; return f(); },
      useCallback(f) { i++; return f; },
    };
    const attach = (n, parentNode) => {
      if (Array.isArray(n)) { n.forEach((c) => attach(c, parentNode)); return; }
      if (!n || typeof n !== 'object' || !n.$$typeof || typeof n.type !== 'string') return;
      const el = node(n.props['data-theme'], parentNode);
      if (n.ref && typeof n.ref === 'object') n.ref.current = el;
      attach(n.props.children, el);
    };
    for (let pass = 0; pass < 5; pass++) {
      i = 0; dirty = false; effects = [];
      const prev = DISPATCHER.current;
      DISPATCHER.current = hooks;
      let tree;
      try { tree = Comp(props); } finally { DISPATCHER.current = prev; }
      attach(tree, parent);
      effects.forEach((f) => f());
      if (!dirty) return tree;
    }
    throw new Error(`${Comp.name} renders again and again`);
  };
  return { html, mount, box: (th, parent = html) => node(th, parent) };
}
const elements = (n, out = []) => {
  if (Array.isArray(n)) { n.forEach((c) => elements(c, out)); return out; }
  if (n && typeof n === 'object' && n.$$typeof) { out.push(n); elements(n.props.children, out); }
  return out;
};
const cardPicture = (tree) => elements(tree).find((e) => e.props.className === 'ao-typecard-img')?.props.dangerouslySetInnerHTML.__html;
const wordmarkPath = (tree) => elements(tree).find((e) => e.type === 'path')?.props.d;

// ---- the parts that are not one skin's: the two lists agree, the hooks exist ----

test('tokens.json and AgentOffice.MODES list the same skins in the same order; Tour is a mode, not a theme', () => {
  assert.deepEqual(Array.from(AO.MODES, (m) => m.theme), SKINS.map((s) => s.id), 'AO.MODES (components/bundle.js) and tokens.json color.themes');
  assert.equal(new Set(SKINS.map((s) => s.id)).size, SKINS.length, 'theme ids are unique');
  assert.equal(new Set(AO.MODES.map((m) => m.id)).size, AO.MODES.length, 'look ids are unique');
  assert.ok(!AO.MODES.some((m) => m.id === 'tour'), 'Tour is not in AO.MODES');
});

test('every per-theme token has a value for exactly the skins of tokens.json, no more', () => {
  for (const t of perTheme) assert.deepEqual(Object.keys(t.value), SKINS.map((s) => s.id), `${t.name} (tokens.json ${t.group})`);
});

test('the drawn parts read their skin values from tokens and MODES, and are not files of one skin', () => {
  // portraits: one drawing, styled by the portrait-* tokens of the theme the portrait sits in
  for (const [cls, decl] of [['.ao-pt-gloss', 'opacity:var(--portrait-gloss)'], ['.ao-pt-line', 'opacity:var(--portrait-outline)'], ['.ao-pt-line', 'stroke:var(--portrait-ink)'],
    ['.ao-pt-eyes', 'fill:var(--portrait-ink)'], ['.ao-pt-shadow', 'fill:var(--portrait-ink)'], ['.ao-pt-square', 'opacity:var(--portrait-eyes-square)'], ['.ao-pt-round', 'opacity:calc(1 - var(--portrait-eyes-square))'], ['.ao-mark', 'border-radius:var(--logo-mark-radius)']]) {
    assert.ok(rules.some((r) => r.file === 'components/bundle.css' && !r.cond && r.sel === cls && r.body.split(';').includes(decl)), `bundle.css: ${cls}{${decl}}`);
  }
  for (const shape of Object.keys(AO.PORTRAITS)) {
    const svg = AO.PORTRAITS[shape]('#4f8cff');
    for (const cls of ['ao-pt-gloss', 'ao-pt-shadow', 'ao-pt-line', 'ao-pt-eyes', 'ao-pt-round', 'ao-pt-square']) assert.ok(svg.includes(`class="${cls}"`), `PORTRAITS.${shape} has ${cls}`);
  }
  assert.deepEqual(Array.from(AO.OFFICE_PICTURES), Object.keys(AO.office.TYPES), 'a picture for every office type (AO.officePicture)');
  for (const gone of ['PORTRAITS_SUBLEVEL', 'THUMBS', 'THUMBS_BY_THEME']) assert.equal(AO[gone], undefined, `AO.${gone}: a per-skin set is gone`);
  for (const [dir, re] of [['assets/Bots/', /-[a-z]+(-[a-z]+)*\.svg$/], ['assets/Offices/', /-[a-z]+(-[a-z]+)*\.svg$/], ['assets/Logos/', /-[a-z]+(-[a-z]+)*\.svg$/]]) {
    const files = fs.readdirSync(new URL(dir, root));
    const own = files.filter((f) => re.test(f) && SKINS.concat(AO.MODES.map((m) => ({ id: m.id }))).some((s) => f.endsWith('-' + s.id + '.svg')));
    assert.deepEqual(own, [], `${dir}: no hand-made file of one skin`);
  }
});

test('AO.themeOf gives the theme whose tokens an element shows, by the rules of tokens.css', () => {
  for (const dark of [false, true]) {
    const p = page(null, dark), want = dark && SYSTEM_DARK ? SYSTEM_DARK : SKINS[0].id;
    assert.equal(AO.themeOf(null), want, `no data-theme, system ${dark ? 'dark' : 'light'}: <html>`);
    assert.equal(AO.themeOf(p.box(null, p.box(null))), want, `no data-theme, system ${dark ? 'dark' : 'light'}: a nested element`);
    assert.equal(AO.themeOf(p.box('no-such-theme')), want, 'a data-theme value that is no theme is passed over');
    const q = page('no-such-theme', dark);
    assert.equal(AO.themeOf(q.box(null)), SKINS[0].id, '<html> with a data-theme that is no theme: the :root block, not the system dark block');
  }
  for (const [i, s] of SKINS.entries()) {
    const outer = SKINS[(i + 1) % SKINS.length].id, p = page(outer, true);
    assert.equal(AO.themeOf(p.html), outer, `${s.id}: <html>`);
    assert.equal(AO.themeOf(p.box(null, p.box('no-such-theme', p.box(s.id)))), s.id, `${s.id}: the nearest data-theme that is a theme`);
  }
});

test('Logo and OfficeTypeCard on a page with no data-theme draw the theme of the system scheme', () => {
  for (const dark of [false, true]) {
    const p = page(null, dark), th = dark && SYSTEM_DARK ? SYSTEM_DARK : SKINS[0].id, M = AO.modeOf(th);
    for (const type of Object.keys(AO.office.TYPES)) {
      assert.equal(cardPicture(p.mount(AO.OfficeTypeCard, { type })), AO.officePicture(type, (n) => valueOf(n, th), { dark: M.dark, retro: M.retro }), `OfficeTypeCard ${type}, system ${dark ? 'dark' : 'light'}: the ${th} picture`);
    }
    for (const variant of ['wordmark', 'lockup']) assert.equal(wordmarkPath(p.mount(AO.Logo, { variant })), AO.LOGO.wordmarks[M.wordmark].path, `Logo ${variant}, system ${dark ? 'dark' : 'light'}: the ${th} wordmark`);
  }
});

test('the system dark block holds the values of the first dark theme of AO.MODES', () => {
  const first = AO.MODES.find((m) => m.dark)?.theme;
  assert.ok(first, 'no dark theme in AO.MODES');
  const sys = block(':root:not([data-theme]) {');
  assert.ok(sys, 'tokens.css has no :root:not([data-theme]) block (the system dark block)');
  assert.equal(scheme(sys), 'dark', 'the system dark block has color-scheme dark');
  for (const t of perTheme) assert.equal(prop(sys, t.name), t.value[first].replace(/^\{(.+)\}$/, 'var(--$1)'), `system dark block --${t.name} is not the value of ${first}`);
});

// ---- the parts of a skin, in the order of Recipes.md "Add a theme" ----

for (const [index, skin] of SKINS.entries()) {
  const id = skin.id, M = modeOf(id)[0], look = M?.id;
  const part = (name, owner, fn) => test(`${id}: ${name}`, () => {
    const fail = (detail) => assert.fail(`${id}: ${name} missing or wrong (${owner})${detail ? ': ' + detail : ''}`);
    const ok = (cond, detail) => { if (!cond) fail(detail); };
    fn(ok, fail);
  });

  describe(`skin ${id}`, () => {
    part('1. theme entry', 'tokens.json color.themes', (ok) => {
      ok(/^[a-z]+(-[a-z]+)*$/.test(id), `id "${id}": lower-case words joined by "-"`);
      ok(typeof skin.name === 'string' && skin.name.trim().length > 0, 'a name');
    });

    part('2. color, shadow and skin tokens', 'tokens.json', (ok) => {
      for (const t of perTheme) {
        const v = t.value[id];
        ok(typeof v === 'string' && v.trim() !== '', `${t.name} has no value`);
        if (/^\{.+\}$/.test(v)) ok(flat[v.slice(1, -1)], `${t.name}: ${v} names no token`);
        if (t.group === 'color') ok(/^(#[0-9a-f]{6}|rgba\((\d+,){3}(0|1|0?\.\d+)\))$/.test(valueOf(t.name, id) || ''), `${t.name}: ${valueOf(t.name, id)} is not a #rrggbb or rgba() color`);
      }
      ok(/^#[0-9a-f]{6}$/.test(valueOf('portrait-ink', id) || ''), 'portrait-ink is a #rrggbb color');
      for (const n of ['portrait-gloss', 'portrait-outline', 'portrait-eyes-square']) ok(['0', '1'].includes(valueOf(n, id)), `${n} is 0 or 1`);
      ok(/^(\d|[1-4]\d|50)%$/.test(valueOf('logo-mark-radius', id) || ''), 'logo-mark-radius is 0% to 50%');
    });

    part('3. light, fx, font and radius tokens', 'tokens.json light, fx, type, radius', (ok) => {
      ok(look, 'no AO.MODES entry, so no look id');
      for (const n of [`light-${look}-sky`, `light-${look}-sun`, `light-${look}-lamp`, `fx-bloom-${look}`, `fx-threshold-${look}`, `fx-exposure-${look}`, `fx-fog-${look}`, `fx-vignette-${look}`]) {
        const t = J.light.tokens.concat(J.fx.tokens).find((x) => x.name === n);
        ok(t, `${n} is not in tokens.json`);
        ok(t && Number.isFinite(+t.value) && +t.value >= 0 && +t.value <= 2, `${n}: ${t?.value} is not a level from 0 to 2`);
      }
      // a theme that swaps faces or corners does it in a family rule; every token the rule sets must exist
      const known = new Set([...nonColor, ...Object.keys(J.type.families).map((f) => 'font-' + f), ...perTheme.map((t) => t.name)]);
      for (const r of rules.filter((x) => x.sel.split(',').some((s) => themeSels(s).length && appliesTo(s.trim(), id)))) {
        for (const m of r.body.matchAll(/--([a-z0-9-]+):var\(--([a-z0-9-]+)\)/g)) ok(known.has(m[2]), `${r.file}: ${r.sel} sets --${m[1]} from --${m[2]}, which tokens.json does not have`);
      }
    });

    part('4. tokens.css block', 'tokens.css', (ok) => {
      const text = blockOf(index);
      ok(text, `no block ${index === 0 ? ':root, [data-theme="' + id + '"]' : '[data-theme="' + id + '"]'}`);
      for (const t of perTheme) {
        const want = t.value[id]?.replace(/^\{(.+)\}$/, 'var(--$1)');
        ok(prop(text, t.name) === want, `--${t.name} is ${prop(text, t.name)}, tokens.json says ${want}`);
      }
      ok(scheme(text) === (M?.dark ? 'dark' : 'light'), `color-scheme is ${scheme(text)}; AO.MODES says dark: ${M?.dark}`);
    });

    part('5. LOOKS and FX entries', 'components/bundle.js AO.office.LOOKS, FX, WINDOWS', (ok) => {
      const L = AO.office.LOOKS[look], FX = AO.office.FX;
      ok(L, `no LOOKS.${look}`);
      ok(JSON.stringify(Object.keys(L).sort()) === JSON.stringify([...LOOK_FIELDS].sort()), `fields ${Object.keys(L).sort()} are not the fields of every look (${[...LOOK_FIELDS].sort()})`);
      for (const [k, tok] of [['hi', 'sky'], ['si', 'sun'], ['lamp', 'lamp']]) ok(L[k] === +J.light.tokens.find((t) => t.name === `light-${look}-${tok}`)?.value, `LOOKS.${look}.${k} ${L[k]} is not light-${look}-${tok}`);
      for (const k of ['hc', 'hg', 'sc']) ok(Number.isInteger(L[k]) && L[k] >= 0 && L[k] <= 0xffffff, `LOOKS.${look}.${k} is not a color number`);
      ok(Array.isArray(L.sp) && L.sp.length === 3 && L.sp.every(Number.isFinite), `LOOKS.${look}.sp is not a position`);
      ok(typeof AO.office.WINDOWS[L.win] === 'function', `LOOKS.${look}.win "${L.win}" is not a picture of WINDOWS`);
      for (const k of ['frame', 'leaf']) ok(/^#[0-9a-f]{6}$/.test(L[k] || ''), `LOOKS.${look}.${k} is not a #rrggbb color`);
      ok(Array.isArray(L.beacon) && L.beacon.length === 2 && L.beacon.every((n) => flat[n]?.group === 'color'), `LOOKS.${look}.beacon does not name two color tokens`);
      for (const k of ['clock', 'flicker', 'caps', 'term']) ok(typeof L[k] === 'boolean', `LOOKS.${look}.${k} is not true or false`);
      for (const [k, tok] of [['bloom', 'bloom'], ['thr', 'threshold'], ['exp', 'exposure'], ['fog', 'fog'], ['vig', 'vignette']]) {
        ok(FX[k][look] === +J.fx.tokens.find((t) => t.name === `fx-${tok}-${look}`)?.value, `FX.${k}.${look} ${FX[k][look]} is not fx-${tok}-${look}`);
      }
    });

    part('6. AgentOffice.MODES entry', 'components/bundle.js AO.MODES', (ok) => {
      ok(modeOf(id).length === 1, `${modeOf(id).length} entries with theme "${id}"`);
      ok(M && M.label === skin.name, `label "${M?.label}" is not the name in tokens.json, "${skin.name}"`);
      for (const [k, type] of Object.entries(MODE_FIELDS)) ok(M && typeof M[k] === type, `${k} is not a ${type}`);
      ok(M && Object.keys(M).length === Object.keys(MODE_FIELDS).length, `fields ${M && Object.keys(M)}: every entry has ${Object.keys(MODE_FIELDS)}`);
      ok(M && AO.modeOf(id) === M, 'AO.modeOf does not find it');
      ok(M && typeof AO[M.wrapper] === 'function', `wrapper "${M?.wrapper}" is not an exported component of AgentOffice`);
      ok(M && AO.LOGO.wordmarks[M.wordmark]?.path && /^0 0 [\d.]+ [\d.]+$/.test(AO.LOGO.wordmarks[M.wordmark].viewBox || ''), `wordmark "${M?.wordmark}" is not a drawing of AO.LOGO.wordmarks`);
    });

    part('7. mode icon', 'components/bundle.js AO.ICONS, kit/schema.json, assets/Icons', (ok) => {
      const icon = M?.icon;
      ok(AO.ICONS[icon], `"${icon}" is not in AO.ICONS`);
      ok(ICON_SCHEMA.includes(icon), `"${icon}" is not in kit/schema.json icons`);
      const file = new URL(`assets/Icons/${icon}.svg`, root);
      ok(fs.existsSync(file), `no assets/Icons/${icon}.svg`);
      const inner = (AO.ICONS[icon] || '').replace(/^<g[^>]*>|<\/g>$/g, '').replace(/currentColor/g, '#18212b');
      ok(fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(inner), `assets/Icons/${icon}.svg does not draw what AO.ICONS.${icon} draws`);
      ok(AO.MODES.filter((m) => m.icon === icon).length === 1, `"${icon}" is the icon of another theme too: icons only, they would look the same`);
    });

    part('8. office type pictures', 'components/bundle.js AO.officePicture, tokens.json', (ok) => {
      const read = new Set(), tok = (n) => { read.add(n); return valueOf(n, id); };
      // A color of a picture comes from a token of the skin, or it is a bot color (a color a bot portrait has for a body color of
      // AO.BODY_COLORS). To see which colors come from a token, draw the picture again with every token moved by half a channel:
      // a color that comes from a token (also darkened or lightened) moves with it, a color that comes from anywhere else does not.
      const moved = (n) => { const v = valueOf(n, id); return /^#[0-9a-f]{6}$/.test(v || '') ? '#' + [1, 3, 5].map((i) => ((parseInt(v.slice(i, i + 2), 16) + 128) % 256).toString(16).padStart(2, '0')).join('') : v; };
      const colors = (svg) => [...svg.matchAll(/(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
      const style = { dark: M?.dark, retro: M?.retro };
      for (const type of Object.keys(AO.office.TYPES)) {
        read.clear();
        const svg = AO.officePicture(type, tok, style), probe = AO.officePicture(type, moved, style);
        for (const n of read) ok(flat[n]?.group === 'color' || flat[n]?.group === 'skin', `the ${type} picture reads ${n}, which is not a color token of tokens.json`);
        ok(/^<svg [^>]*viewBox="0 0 320 200">.*<\/svg>$/s.test(svg), `no picture for ${type}`);
        ok(!/[{}]|NaN|undefined/.test(svg), `the ${type} picture has an unread slot`);
        const a = colors(svg), b = colors(probe);
        ok(a.length === b.length, `the ${type} picture draws other items when the token values change`);
        a.forEach((c, i) => {
          ok(/^(#[0-9a-f]{6}|none)$/.test(c), `the ${type} picture has a color that is not #rrggbb: ${c}`);
          if (c !== 'none' && c === b[i]) ok(BOT_PALETTE.has(c), `the ${type} picture has ${c}, which is not from a token`);
        });
        // the type's own color: type-<type>, or the type-* token the type names (tok in AO.office.TYPES: the lobby takes the team color)
        for (const n of [`type-${AO.office.TYPES[type].tok || type}`, 'scene-floor']) ok(svg.includes(`"${tok(n)}"`), `the ${type} picture does not use ${n} (${tok(n)})`);
      }
      // OfficeTypeCard reads the tokens and the style from the element it sits in: in a box of the skin on a page in another theme
      // (one with another style, if there is one), and with theme set on the card itself, it draws the picture of the skin
      const outer = (SKINS.find((s) => s.id !== id && (AO.modeOf(s.id).dark !== M?.dark || AO.modeOf(s.id).retro !== M?.retro)) || SKINS[(index + 1) % SKINS.length]).id;
      for (const dark of [false, true]) {
        const p = page(outer, dark);
        for (const type of Object.keys(AO.office.TYPES)) {
          const want = AO.officePicture(type, (n) => valueOf(n, id), style);
          ok(cardPicture(p.mount(AO.OfficeTypeCard, { type }, p.box(id))) === want, `OfficeTypeCard ${type} in a [data-theme="${id}"] box on a page in ${outer} does not draw the ${id} picture`);
          ok(cardPicture(p.mount(AO.OfficeTypeCard, { type, theme: id })) === want, `OfficeTypeCard ${type} with theme "${id}" on a page in ${outer} does not draw the ${id} picture`);
        }
      }
    });

    part('9. portraits and logo', 'tokens.json skin, components/bundle.js AO.PORTRAITS, AO.LOGO', (ok) => {
      const lk = { ink: valueOf('portrait-ink', id), gloss: valueOf('portrait-gloss', id), outline: valueOf('portrait-outline', id), eyesSquare: valueOf('portrait-eyes-square', id) };
      for (const shape of Object.keys(AO.PORTRAITS)) {
        const svg = AO.PORTRAITS[shape]('#4f8cff', lk);
        ok(svg.includes(`<g class="ao-pt-line" fill="none" stroke="${lk.ink}"`) && svg.includes(`<g class="ao-pt-eyes" fill="${lk.ink}">`) && /<ellipse class="ao-pt-shadow" [^>]*fill="([^"]*)"/.exec(svg)?.[1] === lk.ink, `the ${shape} portrait does not take portrait-ink`);
        ok(svg.includes(`<g class="ao-pt-gloss" opacity="${+lk.gloss}">`) && svg.includes(`<g class="ao-pt-square" opacity="${+lk.eyesSquare}">`), `the ${shape} portrait does not take the portrait tokens`);
      }
      const r = parseFloat(valueOf('logo-mark-radius', id)) / 100;
      ok(AO.LOGO.mark('#000000', '#ffffff', r).includes(`rx="${Math.round(64 * r * 100) / 100}"`), 'AO.LOGO.mark does not take logo-mark-radius');
      // The wordmark comes from the element the logo sits in, like the mark's corner (CSS): in a box of the skin on a page in another
      // theme (one with another wordmark, if there is one), and with theme set on the logo itself, it is the skin's wordmark
      const outer = (SKINS.find((s) => s.id !== id && AO.modeOf(s.id).wordmark !== M?.wordmark) || SKINS[(index + 1) % SKINS.length]).id, p = page(outer, false);
      for (const variant of ['wordmark', 'lockup']) {
        ok(wordmarkPath(p.mount(AO.Logo, { variant }, p.box(id))) === AO.LOGO.wordmarks[M?.wordmark]?.path, `Logo ${variant} in a [data-theme="${id}"] box on a page in ${outer} does not draw the "${M?.wordmark}" wordmark`);
        ok(wordmarkPath(p.mount(AO.Logo, { variant, theme: id })) === AO.LOGO.wordmarks[M?.wordmark]?.path, `Logo ${variant} with theme "${id}" on a page in ${outer} does not draw the "${M?.wordmark}" wordmark`);
      }
      ok(p.mount(AO.Logo, { theme: id }).props['data-theme'] === id, 'Logo with theme does not set data-theme on its mark, so the mark would take the tokens of the page');
    });

    part('10. contrast pairs', 'tokens.json, components/ContrastCheck/preview.html', (ok) => {
      for (const [fg, bg, need] of CONTRAST_CARD) {
        const a = valueOf(fg, id), b = valueOf(bg, id);
        ok(a && b, `${fg} on ${bg}: a token has no value`);
        const r = ratio(rgb(a), rgb(b));
        ok(r >= need, `${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${need}:1`);
      }
    });

    part('11. Reference column', 'docs/design-system/Reference.md', (ok) => {
      // every per-theme table has a column for the skin, with the value of tokens.json in each row
      const lines = reference.split('\n');
      const tables = [];
      lines.forEach((l, i) => { if (/^\| Token \|/.test(l) && l.includes(`| ${SKINS[0].id} |`)) tables.push(i); });
      ok(tables.length >= 2, 'the per-theme tables (color, skin)');
      for (const at of tables) {
        const head = lines[at].split('|').map((x) => x.trim()), col = head.indexOf(id);
        ok(col > 0, `the table at line ${at + 1} has no ${id} column`);
        for (let i = at + 2; /^\|/.test(lines[i] || ''); i++) {
          const cells = lines[i].split('|').map((x) => x.trim()), name = cells[1].replace(/`/g, '');
          if (!flat[name]) continue;
          ok(cells[col] === '`' + flat[name].value[id] + '`', `line ${i + 1}: ${name} is ${cells[col]}, tokens.json says ${flat[name].value[id]}`);
        }
      }
      // a source table (a theme after an outside design system: "| Token | <id> (<source>) | ... |") starts each cell of the skin
      // with the value of tokens.json in code ticks; the text after it names the source and the reason for a difference
      lines.forEach((l, at) => {
        const head = l.split('|').map((x) => x.trim()), col = head.findIndex((h) => h.startsWith(id + ' ('));
        if (!/^\| Token \|/.test(l) || col < 0) return;
        let rows = 0;
        for (let i = at + 2; /^\|/.test(lines[i] || ''); i++, rows++) {
          const cells = lines[i].split('|').map((x) => x.trim()), name = cells[1].replace(/`/g, '');
          ok(flat[name], `line ${i + 1}: ${name} is not a per-theme token of tokens.json`);
          ok(cells[col].startsWith('`' + flat[name].value[id] + '`'), `line ${i + 1}: the ${id} source cell of ${name} starts ${cells[col].slice(0, 30)}, tokens.json says ${flat[name].value[id]}`);
        }
        ok(rows > 0, `the source table at line ${at + 1} has no rows`);
      });
      ok(new RegExp('\\| `shadow-panel` \\| [^\\n]*"' + id + '": "' + flat['shadow-panel'].value[id].replace(/[()]/g, '\\$&') + '"').test(reference), 'the shadow-panel row');
      ok(lines.some((l) => l.startsWith(`| \`${look}\` | \`${id}\` | ${skin.name} | \`${M?.icon}\` | ${M?.dark ? '`true`' : ''} |`)), 'the Themes row: look, data-theme, label, icon, dark');
      for (const n of [`light-${look}-sky`, `fx-bloom-${look}`]) ok(lines.some((l) => l.startsWith(`| \`${n}\` |`)), `the ${n} row`);
    });

    part('12. screenshot lists', 'docs/design-system/DS-README.md, Recipes.md, CLAUDE.md', (ok) => {
      const line = (f, re) => read(f).split('\n').find((l) => re.test(l)) || '';
      for (const [f, re] of [['docs/design-system/DS-README.md', /^- \[ \] Screenshots in /], ['docs/design-system/Recipes.md', /^1\. Screenshots: /], ['CLAUDE.md', /then look at screenshots in /]]) {
        const l = line(f, re);
        ok(l, `${f}: no screenshot line`);
        ok(new RegExp(`(^|[^A-Za-z])${skin.name}([^A-Za-z]|$)`).test(l.replace(new RegExp(SKINS.filter((s) => s.name !== skin.name && s.name.includes(skin.name)).map((s) => s.name).join('|') || '^$', 'g'), '')), `${f}: the screenshot line does not name ${skin.name}`);
      }
    });

    part('13. family style rules', 'components/bundle.css, public/office.css', (ok) => {
      // a look rule names the theme family ([data-theme|="family"]), so a variant (family-dark) shares it and nothing is copied;
      // its colors are tokens, so a look rule holds no literal color
      for (const r of rules) for (const s of r.sel.split(',')) {
        if (themeSels(s).length && appliesTo(s.trim(), id)) ok(!/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i.test(r.body), `${r.file}: ${s.trim()} has a literal color; use a token`);
        for (const t of themeSels(s)) {
          ok(!(t.id === id && !t.family), `${r.file}: ${s.trim()} names the theme alone; use [data-theme|="${family(id)}"]`);
          if (t.family && t.id === id) ok(t.id === family(id), `${r.file}: ${s.trim()}: a family selector names the family "${family(id)}"`);
        }
      }
    });

    part('14. mode control fit', 'components/bundle.css', (ok) => {
      // The office top bar holds the brand, the mode toggle (every MODES entry, then Tour), the view toggle (Building, Floor),
      // with 16 px edges and 10 px gaps, and, when a decision waits, the "Needs you · N" button (.ao-hud-needs) between the brand and
      // the mode toggle. Below a container width the toggle shows icons only. That width must hold the bar with every label, so a
      // new theme that makes the toggle longer must raise it; the bar with the button needs its own, wider rule (a selector with
      // :has(.ao-hud-needs)), so the labels stay at the widths where nothing waits. Pinned estimate (measured on the office page
      // with the building name "agent-office"): a segment is PAD + CHAR x the label length, the button is BTN + CHAR x the length
      // of its longest text (a two digit count); caps type (a family rule that sets text-transform:uppercase on .ao-seg button)
      // is wider. MARGIN is what is left over.
      const NEEDS_TEXT = 'Needs you \u00b7 99';
      const caps = rules.some((r) => !r.cond && r.sel.split(',').some((s) => /\.ao-seg button$/.test(s.trim()) && themeSels(s).length && appliesTo(s.trim(), id)) && /text-transform:uppercase/.test(r.body));
      const T = caps ? { brand: 345, pad: 44, char: 7.8, btn: 32 } : { brand: 280, pad: 46, char: 5.2, btn: 42 }, MARGIN = 16;
      const seg = (labels) => 8 + labels.reduce((n, l) => n + T.pad + T.char * l.length, 0);
      for (const [needs, setup] of [[false, false], [true, false], [false, true], [true, true]]) {   // Set up (#238) is a second button, with its own bar rules
        const top = '.ao-hud-top' + (needs ? ':has(.ao-hud-needs)' : '') + (setup ? ':has(.ao-hud-setup)' : ''), what = 'with ' + ([needs && 'the Needs you button', setup && 'the Set up button'].filter(Boolean).join(' and ') || 'no button');
        const label = `${top} .ao-seg button:not([aria-pressed="true"]) .ao-seg-l`;
        const need = 16 + T.brand + 10 + (needs ? T.btn + T.char * NEEDS_TEXT.length + 10 : 0) + (setup ? T.btn + T.char * 'Set up · 99'.length + 10 : 0) + seg(AO.MODES.map((m) => m.label).concat('Tour')) + 10 + seg(['Building', 'Floor']) + 16 + MARGIN;
        const widths = rules.filter((r) => r.file === 'components/bundle.css' && /^@container \(max-width:(\d+)px\)$/.test(r.cond) && r.sel.split(',').some((s) => s.trim().endsWith(label) && appliesTo(s.trim(), id)) && /position:absolute/.test(r.body))
          .map((r) => +r.cond.match(/(\d+)px/)[1]);
        ok(widths.length, `no icons-only rule for the top bar ${what}`);
        const at = Math.max(...widths);
        ok(at >= need, `${what}: icons only below ${at + 1} px, but the bar with every label needs ${Math.ceil(need)} px (with ${MARGIN} px to spare)`);
      }
      // On the narrowest page (400 px, 16 px gutters) the toggle shows icons only and the pressed segment keeps its label: a
      // segment is its padding (10 + 10) and the 14 px icon, with 2 px between segments, and the label (6 px gap) of the longest name.
      const narrow = rules.some((r) => r.file === 'components/bundle.css' && /^@container \(max-width:(\d+)px\)$/.test(r.cond) && +r.cond.match(/(\d+)px/)[1] >= 400 &&
        r.sel.split(',').some((s) => /\.ao-seg button:not\(\[aria-pressed="true"\]\) \.ao-seg-l$/.test(s.trim()) && appliesTo(s.trim(), id)) && /position:absolute/.test(r.body));
      ok(narrow, 'no icons-only rule for the toggle at 400 px');
      const segs = AO.MODES.length + 1, longest = Math.max(...AO.MODES.map((m) => m.label.length), 'Tour'.length);
      const small = 8 + segs * (10 + 10 + 14) + (segs - 1) * 2 + 6 + longest * Math.max(T.char, 7);
      ok(small <= 400 - 2 * 16, `icons only, the toggle needs about ${Math.ceil(small)} px, and the 400 px page has ${400 - 2 * 16} px`);
    });

    part('15. code reads flags, not the id', 'components/bundle.js, public/*.js, kit/*.js', (ok) => {
      // Outside the declared tables, no code names the theme id, the look id or the family: not as a string (a compare, an array,
      // indexOf, includes, startsWith, a selector), not in a regular expression, not as an object key. A key that is also a field
      // name of a MODES or LOOKS entry (dark) is the flag, not the id.
      const ids = [...new Set([id, look, family(id)])].map((x) => x.replace(/-/g, '\\-')).join('|');
      // a key that is a field name of a MODES or LOOKS entry (dark) passes only with a boolean value (a literal or !!x): it is the flag, not the id
      const keys = [...new Set([id, look, family(id)])].filter((x) => /^[a-z]+$/.test(x)).map((x) => (FIELD_NAMES.has(x) ? x + String.raw`(?!\s*:\s*(?:(?:true|false|!0|!1)(?![\w$])|!!))` : x)).join('|');
      const forms = [
        ['names it in a string', new RegExp(`(['"\`])(?:${ids})\\1`, 'g')],
        ['names it in a regular expression', new RegExp(`(?:^|[(=,:!&|?{};[]|\\breturn)\\s*\\/(?:[^/\\n\\\\]|\\\\.)*\\b(?:${ids})\\b(?:[^/\\n\\\\]|\\\\.)*\\/[gimsuy]*`, 'gm')],
        ...(keys ? [['keys an object by it', new RegExp(`[{,]\\s*(?:${keys})\\s*:`, 'g')]] : []),
      ];
      for (const f of CODE) {
        const text = CODE_TEXT[f];
        for (const [what, re] of forms) {
          for (const m of text.matchAll(re)) {
            const line = text.slice(0, m.index).split('\n').length;
            ok(false, `${f} line ${line} ${what}: ${text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20).replace(/\s+/g, ' ').trim()}`);
          }
        }
      }
    });
  });
}
