// The DS contract files stay in step: tokens.json, tokens.css, kit/schema.json, the schema inside components/bundle.js,
// and kit/check.py (the page checker). A drift here means a page checks against one list and the engine uses another.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');
const tokens = JSON.parse(read('tokens.json')).color.tokens;
const schema = JSON.parse(read('kit/schema.json'));
const css = read('tokens.css');

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
// kit/check.py with the given arguments. A run with no exit code (the system killed Python, or could not start it, as a machine under
// load can) says nothing about the checker: it is run again, twice at most. A real answer, pass or fail, is never run again (#98).
const py = (args) => {
  let r;
  for (let i = 0; i < 3; i++) { r = spawnSync(python, ['-I', fileUrl('kit/check.py'), ...args], { encoding: 'utf8' }); if (r.status !== null) break; }
  return r;
};

test('tokens.css has every color token of tokens.json, with the same value, in each theme', () => {
  const block = (open) => { const at = css.indexOf(open); assert.ok(at >= 0, `tokens.css has ${open}`); return css.slice(at, css.indexOf('\n}', at)); };
  // every theme of tokens.json, in its order: Day is the root block, each other theme has its own block
  const ids = JSON.parse(read('tokens.json')).color.themes.map((t) => t.id);
  assert.ok(ids.length >= 3 && new Set(ids).size === ids.length, 'tokens.json lists themes');
  assert.deepEqual(ids.slice(0, 3), ['light', 'dark', 'sublevel'], 'Day, Night and Sublevel stay first');
  const themes = Object.fromEntries(ids.map((id) => [id, block(id === 'light' ? ':root, [data-theme="light"] {' : `\n[data-theme="${id}"] {`)]));
  for (const [th, text] of Object.entries(themes)) {
    for (const t of tokens) {
      const want = t.value[th].replace(/^\{(.+)\}$/, 'var(--$1)');
      const m = text.match(new RegExp(`\\n\\s*--${t.name}: ([^;]+);`));
      assert.ok(m, `${t.name} missing in ${th}`);
      assert.equal(m[1], want, `${t.name} in ${th}`);
    }
  }
});

// The non-color groups of tokens.json. Each custom property is named after the token; type styles and families
// have a name of their own (--type-<style>-size|line|weight|tracking, --font-<family>). Only `shadow` changes per theme.
function nonColorProps() {
  const j = JSON.parse(read('tokens.json'));
  const flat = [];
  for (const g of ['spacing', 'radius', 'blur', 'opacity', 'zIndex', 'duration', 'easing', 'breakpoint', 'scene', 'light', 'fx']) {
    assert.ok(Array.isArray(j[g]?.tokens), `tokens.json has no ${g}.tokens`);
    for (const t of j[g].tokens) flat.push([t.name, t.value]);
  }
  for (const [name, value] of Object.entries(j.type.families)) flat.push([`font-${name}`, value]);
  for (const group of j.type.groups) {
    for (const s of group.styles) {
      flat.push([`type-${s.name}-size`, s.fontSize], [`type-${s.name}-line`, s.lineHeight], [`type-${s.name}-weight`, String(s.fontWeight)]);
      if (s.letterSpacing) flat.push([`type-${s.name}-tracking`, s.letterSpacing]);
    }
  }
  const perTheme = j.shadow.tokens.map((t) => [t.name, t.value]);
  return { flat, perTheme };
}
const cssBlock = (text, open) => { const at = text.indexOf(open); return text.slice(at, text.indexOf('\n}', at)); };
const cssProp = (text, name) => text.match(new RegExp(`\\n\\s*--${name}: ([^;]+);`))?.[1];

test('tokens.css has every non-color token of tokens.json, with the same value', () => {
  const { flat } = nonColorProps();
  assert.ok(flat.length > 100, `only ${flat.length} non-color tokens found`);
  const root = cssBlock(css, ':root, [data-theme="light"] {');
  for (const [name, value] of flat) {
    const got = cssProp(root, name);
    assert.ok(got !== undefined, `--${name} missing in tokens.css`);
    assert.equal(got, String(value), `--${name}`);
  }
});

test('tokens.css has every per-theme shadow token, with the same value, in each theme and in the system dark block', () => {
  const { perTheme } = nonColorProps();
  // every theme of tokens.json (Fluent and Fluent Dark too), plus the system dark block, which takes the Night value
  const ids = JSON.parse(read('tokens.json')).color.themes.map((t) => t.id);
  const blocks = Object.fromEntries(ids.map((id) => [id, cssBlock(css, id === 'light' ? ':root, [data-theme="light"] {' : `\n[data-theme="${id}"] {`)]));
  blocks.system = cssBlock(css, ':root:not([data-theme]) {');
  for (const [name, value] of perTheme) {
    assert.deepEqual(Object.keys(value), ids, `${name} has a value for every theme, in order`);
    for (const [th, text] of Object.entries(blocks)) {
      const got = cssProp(text, name);
      assert.ok(got !== undefined, `--${name} missing in ${th}`);
      assert.equal(got, value[th === 'system' ? 'dark' : th], `--${name} in ${th}`);
    }
  }
});

test('the schema lists every color token', () => {
  for (const t of tokens) assert.ok(schema.tokens.includes(t.name), `${t.name} not in kit/schema.json tokens`);
});

test('the schema inside the bundle is the one in kit/schema.json', () => {
  const b = read('components/bundle.js');
  const i = b.indexOf('/*@schema*/') + 11;
  const emb = JSON.parse(b.slice(i, b.indexOf(';AO.schema=SCHEMA', i)));
  for (const k of ['version', 'events', 'commands', 'enums', 'types']) assert.deepEqual(emb[k], schema[k], k);
});

test('the bot type lists the fields a page sends, and bot.add uses it', () => {
  assert.equal(schema.events['bot.add'].fields.bot, 'BotDef');
  const f = schema.types.BotDef.fields;
  for (const k of ['platform', 'identity', 'orchestrator', 'color', 'shape', 'role', 'status', 'task', 'word']) assert.ok(k in f, k);
  for (const t of Object.values(f)) {
    const name = t.replace(/\?$/, '');
    assert.ok(['string', 'number', 'boolean', 'object', 'Status', 'string[]'].includes(name) || name in schema.enums, `type ${t}`);
  }
});

test('the usage event can carry spend', () => {
  assert.deepEqual(schema.events.usage.fields, { percent: 'number?', bots: 'object?', cost: 'number?', costLimit: 'number?', costs: 'object?' });
});

test('the bot type lists the fields the engine reads and sets, and the .d.ts agrees with it', () => {
  const f = schema.types.BotDef.fields;
  for (const k of ['usage', 'parent', 'session']) assert.ok(k in f, k);
  assert.equal(f.name, 'string?');
  const dts = read('components/index.d.ts');
  const def = dts.match(/export interface BotDef \{([^\n]*)\}\n/)[1];
  assert.match(def, /\bname\?: string/);
  for (const k of Object.keys(f)) assert.match(def, new RegExp(`\\b${k}\\?: `), `BotDef.${k} in index.d.ts`);
  assert.match(dts, /type: "bot\.add"; roomId: string; bot: BotDef \}/);
});

// The first IIFE of the bundle holds the small components. Run it against a stand-in React that returns plain nodes.
function loadSmallComponents() {
  const b = read('components/bundle.js');
  const src = b.slice(b.indexOf('(function(){'), b.indexOf('})();') + 5);
  const h = (type, props, ...kids) => {
    const k = kids.flat(Infinity).filter((x) => x != null && x !== false);
    return typeof type === 'function' ? type({ ...(props || {}), children: k }) : { type, props: props || {}, kids: k };
  };
  const win = { React: { createElement: h } };
  vm.runInNewContext(src, { window: win });
  return win.AgentOffice;
}
const text = (n) => (n == null ? '' : typeof n !== 'object' ? String(n) : n.kids.map(text).join(''));
const find = (n, fn, out = []) => { if (n && typeof n === 'object') { if (fn(n)) out.push(n); n.kids.forEach((k) => find(k, fn, out)); } return out; };

test('UsageMeter: the title says what it shows (weekly limit, or spend when only spend is given)', () => {
  const A = loadSmallComponents();
  const title = (p) => text(find(A.UsageMeter(p), (n) => n.props.className === 'ao-ph')[0].kids[0]);
  assert.equal(title({ percent: 31, reset: 'x' }), 'Weekly limit');
  assert.equal(title({ reset: 'x' }), 'Weekly limit');
  assert.equal(title({ percent: 31, cost: 1, costLimit: 2 }), 'Weekly limit');
  assert.equal(title({ cost: 0.42 }), 'Spend');
  assert.equal(title({ cost: 0.42, costLimit: 2 }), 'Spend');
  assert.equal(title({ cost: 0.42, title: 'This run' }), 'This run');
  const meters = find(A.UsageMeter({ percent: 31, cost: 1, costLimit: 2 }), (n) => n.props.role === 'meter').map((n) => n.props['aria-label']);
  assert.deepEqual(meters, ['Weekly limit used', 'Spend limit used']);
});

test('money: UsageMeter and the shared formatter write < $0.01 and two decimals the same way', () => {
  const A = loadSmallComponents();
  assert.deepEqual([0, 0.004, 0.01, 0.256, 12].map(A.money), ['$0.00', '<$0.01', '$0.01', '$0.26', '$12.00']);
  assert.equal(A.money('about $1'), 'about $1');
  assert.equal(A.money(null), '$0.00');
  const spend = find(A.UsageMeter({ cost: 0.004, costLimit: 2 }), (n) => n.props.className === 'ao-spend')[0];
  assert.equal(text(spend), 'Used<$0.01 of $2.00');
  const b = read('components/bundle.js');
  assert.ok(!/"\$"\+\(p\.cost\|\|0\)\.toFixed\(2\)/.test(b), 'CostMeter has its own money format');
  assert.ok(!/return "\$"\+\(n\|\|0\)\.toFixed\(2\)/.test(b), 'DecisionInbox has its own money format');
  assert.match(b, /h\("b",\{className:"ao-mono"\},AO\.money\(p\.cost\)\)/);
});

test('status text in the DS CSS and StatusBubble uses the -text and -on-bubble tokens, not the raw status colors', () => {
  const css = read('components/bundle.css'), b = read('components/bundle.js');
  assert.match(css, /\.ao-err\{[^}]*color:var\(--status-error-text\)/);
  assert.match(css, /\.ao-dd-v\.do\{color:var\(--status-working-text\)\}\.ao-dd-v\.dont\{color:var\(--status-error-text\)\}/);
  assert.match(b, /function StatusBubble\(p\)\{var s=p\.status\|\|"working",col="var\(--status-"\+s\+"-on-bubble\)"/);
  const A = loadSmallComponents();
  const bub = A.StatusBubble({ status: 'waiting' });
  assert.equal(bub.props.style.color, 'var(--status-waiting-on-bubble)');
});

test('the 3D bubble sprite draws its glyph in status-*-on-bubble, with a fallback for every status', () => {
  const b = read('components/bundle.js');
  for (const s of ['working', 'waiting', 'error', 'resting', 'finished']) assert.match(b, new RegExp(`"status-${s}-on-bubble":"#[0-9a-f]{6}"`), `FALL has status-${s}-on-bubble`);
  assert.match(b, /Kit\.prototype\.bubble=[\s\S]{0,600}var ink=K\.tok\["status-"\+st\+"-on-bubble"\]\|\|col;c\.fillStyle=ink;c\.strokeStyle=ink;/);
});

test('kit/check.py: events are checked against the bot type and the usage fields', { skip: !python }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-kit-'));
  try {
    const log = path.join(dir, 'events.jsonl');
    const run = (events) => {
      fs.writeFileSync(log, events.map((e) => JSON.stringify(e)).join('\n'));
      const r = py(['--events', log]);
      return { code: r.status, out: r.stdout };
    };
    const good = run([
      { type: 'bot.add', roomId: 'r', bot: { name: 'a', shape: 'cone', platform: 'Claude Code', tools: ['x'], _live: 1 } },
      { type: 'usage', percent: 3, cost: 0.4, costLimit: 2, costs: { a: 0.1 } },
    ]);
    assert.equal(good.code, 0, good.out);
    const bad = run([{ type: 'bot.add', roomId: 'r', bot: { name: 'a', shape: 'cube', colour: '#fff', status: 'nope' } }, { type: 'usage', cost: 'x' }]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /bot\.shape must be one of blob, cone, octa, capsule/);
    assert.match(bad.out, /unknown field bot\.colour/);
    assert.match(bad.out, /bot\.status must be Status/);
    assert.match(bad.out, /usage: cost must be number/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('kit/check.py: a custom property that the checked page defines is a known token', { skip: !python }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-kit-'));
  try {
    const f = (n, s) => { const p = path.join(dir, n); fs.writeFileSync(p, s); return p; };
    const css1 = f('a.css', ':root { --page-gap: 4px; }\n.x { margin: var(--page-gap); padding: var(--space-2); }\n');
    const js1 = f('a.js', "el.style.setProperty('--page-live', '1');\nconst s = 'var(--page-live)';\n");
    const html = f('a.html', '<title>Page x0.1</title><style>:root { --page-pad: 1px; } p { margin: var(--page-pad); }</style>');
    const ok = py([css1, js1, html]);
    assert.equal(ok.status, 0, ok.stdout);
    const miss = f('b.css', '.x { margin: var(--page-nothing); }\n');
    const no = py([miss]);
    assert.equal(no.status, 1);
    assert.match(no.stdout, /unknown token --page-nothing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('kit/check.py: a name built at run time is checked by its prefix', { skip: !python }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-kit-'));
  try {
    const f = (n, s) => { const p = path.join(dir, n); fs.writeFileSync(p, s); return p; };
    const run = (p) => py([p]);
    const ok = run(f('a.js', 'el.style.color = "var(--status-" + s + ")"; h(Icon, { name: "role-" + r });\n'));
    assert.equal(ok.status, 0, ok.stdout);
    const badTok = run(f('b.js', 'el.style.color = "var(--nothing-" + s + ")";\n'));
    assert.equal(badTok.status, 1);
    assert.match(badTok.stdout, /unknown token --nothing-/);
    const badIcon = run(f('c.js', 'h(Icon, { name: "nothing-" + r });\n'));
    assert.equal(badIcon.status, 1);
    assert.match(badIcon.stdout, /unknown icon nothing-/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the DS files pass kit/check.py (the same list as CI)', { skip: !python }, () => {
  const files = ['components/bundle.css', 'components/bundle.js', 'kit/page.html'].map(fileUrl);
  const r = py([...files]);
  assert.equal(r.status, 0, r.stdout);
});

test('CI checks the DS files with kit/check.py', () => {
  const ci = read('.github/workflows/ci.yml');
  const line = ci.split('\n').find((l) => l.includes('python kit/check.py'));
  assert.ok(line, 'CI has a kit/check.py step');
  for (const f of ['components/bundle.css', 'components/bundle.js', 'kit/page.html']) assert.ok(line.split(/\s+/).includes(f), `${f} is in the CI check list`);
});

test('the DS CSS uses tokens for the overlay and the Sublevel scan lines', () => {
  const b = read('components/bundle.css');
  assert.match(b, /\.ao-overlay\{[^}]*background:color-mix\(in srgb,var\(--scrim\) 45%,transparent\)/);
  assert.match(b, /\.ao-overlay\.is-inline\{[^}]*background:color-mix\(in srgb,var\(--scrim\) 25%,transparent\)/);
  assert.match(b, /\.ao-fh\{background-image:repeating-linear-gradient\(0deg,color-mix\(in srgb,var\(--on-floor\) 6%,transparent\)/);
  assert.ok(tokens.some((t) => t.name === 'scrim'), 'scrim is in tokens.json');
});

test('the scrim usage text names the dialog and the command palette, and no doc says "welcome card"', () => {
  const t = tokens.find((x) => x.name === 'scrim');
  for (const [file, text] of [['tokens.json', t.usage], ['Reference.md', read('Reference.md')], ['Changelog.md', read('Changelog.md')]]) {
    assert.ok(!/veil behind a dialog or (a|the) welcome card/i.test(text), `${file} does not claim a welcome card uses the scrim`);
  }
  assert.match(t.usage, /dialog or the command palette/);
});

test('the checker docs say that a name ending in "-" is checked by its prefix', () => {
  for (const f of ['DS-README.md', 'Recipes.md']) {
    assert.match(read(f), /checked by its prefix: a name that ends in "-"/, `${f} explains the prefix rule`);
  }
});

test('the DS files say they are edited by hand: no header or doc claims a generator that is not in the repo (#87)', () => {
  const stamp = JSON.parse(read('tokens.json')).name.match(/x\d+(\.\d+)*$/)[0].replace(/\./g, '\\.');
  const top = read('tokens.css').split('\n')[0];
  assert.match(top, new RegExp(`^/\\* Agent Office DS ${stamp}: tokens\\.css\\. Edited by hand`), 'tokens.css header');
  assert.match(top, /tokens\.json/, 'tokens.css header names tokens.json');
  const assets = read('components/bundle.js').split('\n').find((l) => l.includes('asset strings'));
  assert.ok(assets, 'the asset block has a header');
  assert.match(assets, new RegExp(`Agent Office DS ${stamp} - asset strings\\. Edited by hand`), 'asset block header');
  for (const f of ['tokens.css', 'components/bundle.js', 'DS-README.md', 'Reference.md', 'Recipes.md', 'Concepts.md']) {
    assert.ok(!/gen_assets\.py|build\.py|Do not edit/.test(read(f)), `${f} names no generator and does not say "Do not edit"`);
  }
  assert.ok(!/Reference \(generated\)/.test(read('DS-README.md')), 'DS-README does not call Reference generated');
  assert.ok(!/`tokens\.css` \(generated/.test(read('DS-README.md')), 'DS-README does not call tokens.css generated');
});

test('bundle.js defines ModeToggle once, with an icon on every mode; the types and docs list the same modes (#87)', () => {
  const b = read('components/bundle.js');
  assert.equal(b.match(/function ModeToggle\(/g).length, 1, 'one ModeToggle definition');
  assert.ok(!/NS=\{[^}]*ModeToggle/.test(b), 'the first IIFE does not export a ModeToggle');
  const at = b.indexOf('function ModeToggle(');
  const def = b.slice(at, b.indexOf('\n', at));
  // the default options are the themes of AO.MODES (one per theme of tokens.json, Fluent too), then Tour
  assert.match(def, /var opts=p\.options\|\|AO\.MODES\.concat\(\[\{id:"tour",label:"Tour",icon:"tour"\}\]\)/, 'default options: AO.MODES, then Tour');
  const ma = b.indexOf('AO.MODES=[');
  const modes = b.slice(ma, b.indexOf('];', ma));
  const themes = JSON.parse(read('tokens.json')).color.themes;
  for (const t of themes) assert.match(modes, new RegExp(`theme:"${t.id}",label:"${t.name}",icon:"[a-z]+"`), `AO.MODES has ${t.name} with an icon`);
  assert.match(read('components/index.d.ts'), /interface ModeToggleProps \{[^}]*options\?: \{ id: string; label: string; icon\?: string \}\[\]/, 'index.d.ts: options take an icon');
  assert.match(read('components/ModeToggle/README.md'), /\| `options` \| no \| `\{ id: string; label: string; icon\?: string \}\[\]` \|/, 'component README: options take an icon');
  const list = new RegExp(`${themes.map((t) => t.name).join(', ')}\\)? and Tour`);
  for (const f of ['Reference.md', 'components/ModeToggle/README.md']) {
    assert.match(read(f), list, `${f} lists ${themes.map((t) => t.name).join(', ')} and Tour`);
  }
});

test('native scrollbars follow the theme: color-scheme in each theme block, and one token-based scrollbar-color (#97)', () => {
  const scheme = (text) => text.match(/\n\s*color-scheme: ([^;]+);/)?.[1];
  const light = cssBlock(css, ':root, [data-theme="light"] {');
  const dark = cssBlock(css, '[data-theme="dark"] {');
  const sublevel = cssBlock(css, '[data-theme="sublevel"] {');
  const system = cssBlock(css, ':root:not([data-theme]) {');
  assert.equal(scheme(light), 'light', 'Day');
  assert.equal(scheme(dark), 'dark', 'Night');
  assert.equal(scheme(sublevel), 'light', 'Sublevel has a light palette');
  assert.equal(scheme(system), 'dark', 'system dark');
  const b = read('components/bundle.css');
  const rule = b.match(/(^|\n)([^{}\n]*)\{scrollbar-color:([^;}]*)[;}]/);
  assert.ok(rule, 'bundle.css sets scrollbar-color once, on the office and the page root');
  assert.match(rule[2], /(^|,)\.ao-office(,|$)/, 'on .ao-office, where the theme is set');
  assert.match(rule[2], /(^|,):root(,|$)/, 'on the page root, for page panels and dialogs');
  assert.match(rule[3], /var\(--muted\)/, 'the thumb is a token');
  assert.doesNotMatch(rule[3], /#[0-9a-f]{3,8}\b|rgba?\(/i, 'no literal color');
  assert.equal(b.match(/scrollbar-color/g).length, 1, 'one scrollbar-color rule');
});

function fileUrl(rel) { return new URL(rel, root).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '); }

test("bundle.js defines FloorList and BotRow once; the first IIFE exports neither (#110)", () => {
  const b = read("components/bundle.js");
  assert.equal(b.match(/function FloorList\(/g).length, 1, "one FloorList definition");
  assert.equal(b.match(/function BotRow\(/g).length, 1, "one BotRow definition");
  const ns = b.match(/var NS=\{[^}]*\}/)[0];
  assert.ok(!/FloorList:/.test(ns) && !/BotRow:/.test(ns), "NS has neither FloorList nor BotRow");
});
