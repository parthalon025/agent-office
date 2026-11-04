// The DS contract files stay in step: tokens.json, tokens.css, kit/schema.json, the schema inside components/bundle.js,
// and kit/check.py (the page checker). A drift here means a page checks against one list and the engine uses another.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');
const tokens = JSON.parse(read('tokens.json')).color.tokens;
const schema = JSON.parse(read('kit/schema.json'));
const css = read('tokens.css');

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('tokens.css has every color token of tokens.json, with the same value, in each theme', () => {
  const block = (open) => { const at = css.indexOf(open); return css.slice(at, css.indexOf('\n}', at)); };
  const themes = { light: block(':root, [data-theme="light"] {'), dark: block('[data-theme="dark"] {'), sublevel: block('[data-theme="sublevel"] {') };
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

function fileUrl(rel) { return new URL(rel, root).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '); }
