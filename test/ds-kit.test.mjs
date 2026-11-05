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

test('tokens.css has every color token of tokens.json, with the same value, in each theme', () => {
  const block = (open) => { const at = css.indexOf(open); assert.ok(at >= 0, `tokens.css has ${open}`); return css.slice(at, css.indexOf('\n}', at)); };
  // every theme of tokens.json, in its order: Day is the root block, each other theme has its own block
  const ids = JSON.parse(read('tokens.json')).color.themes.map((t) => t.id);
  assert.deepEqual(ids, ['light', 'dark', 'sublevel', 'fluent']);
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
  const log = path.join(dir, 'events.jsonl');
  const run = (events) => {
    fs.writeFileSync(log, events.map((e) => JSON.stringify(e)).join('\n'));
    const r = spawnSync(python, ['-I', fileUrl('kit/check.py'), '--events', log], { encoding: 'utf8' });
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
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kit/check.py: a custom property that the checked page defines is a known token', { skip: !python }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-kit-'));
  const f = (n, s) => { const p = path.join(dir, n); fs.writeFileSync(p, s); return p; };
  const css1 = f('a.css', ':root { --page-gap: 4px; }\n.x { margin: var(--page-gap); padding: var(--space-2); }\n');
  const js1 = f('a.js', "el.style.setProperty('--page-live', '1');\nconst s = 'var(--page-live)';\n");
  const html = f('a.html', '<title>Page x0.1</title><style>:root { --page-pad: 1px; } p { margin: var(--page-pad); }</style>');
  const ok = spawnSync(python, ['-I', fileUrl('kit/check.py'), css1, js1, html], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  const miss = f('b.css', '.x { margin: var(--page-nothing); }\n');
  const no = spawnSync(python, ['-I', fileUrl('kit/check.py'), miss], { encoding: 'utf8' });
  assert.equal(no.status, 1);
  assert.match(no.stdout, /unknown token --page-nothing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kit/check.py: a name built at run time is checked by its prefix', { skip: !python }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-kit-'));
  const f = (n, s) => { const p = path.join(dir, n); fs.writeFileSync(p, s); return p; };
  const run = (p) => spawnSync(python, ['-I', fileUrl('kit/check.py'), p], { encoding: 'utf8' });
  const ok = run(f('a.js', 'el.style.color = "var(--status-" + s + ")"; h(Icon, { name: "role-" + r });\n'));
  assert.equal(ok.status, 0, ok.stdout);
  const badTok = run(f('b.js', 'el.style.color = "var(--nothing-" + s + ")";\n'));
  assert.equal(badTok.status, 1);
  assert.match(badTok.stdout, /unknown token --nothing-/);
  const badIcon = run(f('c.js', 'h(Icon, { name: "nothing-" + r });\n'));
  assert.equal(badIcon.status, 1);
  assert.match(badIcon.stdout, /unknown icon nothing-/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the DS files pass kit/check.py (the same list as CI)', { skip: !python }, () => {
  const files = ['components/bundle.css', 'components/bundle.js', 'kit/page.html'].map(fileUrl);
  const r = spawnSync(python, ['-I', fileUrl('kit/check.py'), ...files], { encoding: 'utf8' });
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

function fileUrl(rel) { return new URL(rel, root).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '); }
