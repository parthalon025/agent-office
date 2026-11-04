import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalTools, TOOL_DEFINITIONS, killTree } from '../providers/local-tools.mjs';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';

function scratch() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tools-'));
  const root = path.join(base, 'work'), outside = path.join(base, 'secret');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'const needle = 1;\n');
  fs.writeFileSync(path.join(outside, 'key.txt'), 'top secret');
  return { base, root, outside, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const SLEEP = 'node -e "setTimeout(()=>{},60000)"';

test('definitions use the Claude Code tool names that risk.mjs knows', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.function.name), ['Read', 'LS', 'Grep', 'Edit', 'Write', 'Bash']);
});

test('Read, LS and Grep work inside the folder', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    assert.match((await t.run('Read', { file_path: 'a.txt' })).text, /1\tone\n2\ttwo/);
    assert.equal((await t.run('Read', { file_path: 'a.txt', offset: 2, limit: 1 })).text, '2\ttwo');
    assert.equal((await t.run('LS', {})).text, 'a.txt\nsrc/');
    assert.match((await t.run('Grep', { pattern: 'NEEDLE' })).text, /^src\/b\.js:1: const needle/);
    assert.equal((await t.run('Grep', { pattern: 'absent' })).text, 'No matches.');
  } finally { s.done(); }
});

test('Edit needs one match, and Write makes folders', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    assert.equal((await t.run('Edit', { file_path: 'a.txt', old_string: 'two', new_string: '2' })).ok, true);
    assert.equal(fs.readFileSync(path.join(s.root, 'a.txt'), 'utf8'), 'one\n2\nthree\n');
    assert.equal((await t.run('Edit', { file_path: 'a.txt', old_string: 'nope', new_string: 'x' })).ok, false);
    fs.writeFileSync(path.join(s.root, 'dup.txt'), 'x x');
    const dup = await t.run('Edit', { file_path: 'dup.txt', old_string: 'x', new_string: 'y' });
    assert.equal(dup.ok, false);
    assert.match(dup.text, /2 times/);
    assert.equal((await t.run('Edit', { file_path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true })).ok, true);
    assert.equal(fs.readFileSync(path.join(s.root, 'dup.txt'), 'utf8'), 'y y');
    assert.equal((await t.run('Write', { file_path: 'new/deep/c.txt', content: 'hi' })).ok, true);
    assert.equal(fs.readFileSync(path.join(s.root, 'new', 'deep', 'c.txt'), 'utf8'), 'hi');
  } finally { s.done(); }
});

test('paths outside the folder are refused: .., absolute, and a prefix look-alike', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    for (const p of ['../secret/key.txt', path.join(s.outside, 'key.txt'), path.join(s.root + '-evil', 'x.txt')]) {
      for (const [tool, args] of [['Read', { file_path: p }], ['Write', { file_path: p, content: 'x' }], ['Edit', { file_path: p, old_string: 'a', new_string: 'b' }], ['LS', { path: p }], ['Grep', { pattern: 'a', path: p }]]) {
        const r = await t.run(tool, args);
        assert.equal(r.ok, false, `${tool} ${p}`);
        assert.match(r.text, /outside the working folder/);
      }
    }
    assert.equal(fs.existsSync(path.join(s.outside, 'x.txt')), false);
  } finally { s.done(); }
});

test('a link inside the folder that leads out is refused', async (c) => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    try { fs.symlinkSync(s.outside, path.join(s.root, 'link'), 'junction'); } catch { c.skip('links are not allowed here'); return; }
    for (const [tool, args] of [['Read', { file_path: 'link/key.txt' }], ['Write', { file_path: 'link/new.txt', content: 'x' }], ['Write', { file_path: 'link/sub/new.txt', content: 'x' }], ['LS', { path: 'link' }]]) {
      const r = await t.run(tool, args);
      assert.equal(r.ok, false, tool);
      assert.match(r.text, /leads outside/);
    }
    assert.equal(fs.existsSync(path.join(s.outside, 'new.txt')), false);
    assert.doesNotMatch((await t.run('Grep', { pattern: 'secret' })).text, /key\.txt/); // a search does not follow the link
  } finally { s.done(); }
});

test('bad calls answer with text and never throw', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    assert.match((await t.run('Nope', {})).text, /Unknown tool/);
    assert.match((await t.run('Read', '{bad json')).text, /not valid JSON/);
    assert.match((await t.run('Read', [])).text, /must be an object/);
    assert.match((await t.run('Read', { file_path: 'missing.txt' })).text, /No such file/);
    assert.match((await t.run('Grep', { pattern: '(' })).text, /regular expression/);
    assert.equal((await t.run('Read', JSON.stringify({ file_path: 'a.txt' }))).ok, true); // arguments may arrive as a JSON string
  } finally { s.done(); }
});

test('Bash runs in the folder and reports the exit code', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    const ok = await t.run('Bash', { command: 'node -e "console.log(process.cwd())"' });
    assert.equal(ok.ok, true);
    assert.ok(ok.text.toLowerCase().includes(path.basename(s.root).toLowerCase()));
    assert.match(ok.text, /\[exit 0\]/);
    const bad = await t.run('Bash', { command: 'node -e "process.exit(3)"' });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /\[exit 3\]/);
  } finally { s.done(); }
});

test('Bash stops at the time limit and kills the whole tree', async () => {
  const s = scratch(); const killed = [];
  const t = createLocalTools(s.root, { kill: (pid) => { killed.push(pid); killTree(pid); } });
  try {
    const t0 = Date.now();
    const r = await t.run('Bash', { command: SLEEP, timeout_ms: 400 });
    assert.equal(r.ok, false);
    assert.match(r.text, /ran longer than 400 ms/);
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(killed.length, 1);
  } finally { s.done(); }
});

test('stop() kills a command that still runs', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    const p = t.run('Bash', { command: SLEEP, timeout_ms: 60_000 });
    await new Promise((r) => setTimeout(r, 300));
    t.stop();
    assert.equal((await p).ok, false);
  } finally { s.done(); }
});

test('the fake OpenAI server streams text, tool calls and usage, and lists models', async () => {
  const fake = await startFakeOpenAI({ script: [{ toolCalls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'done' }], models: ['m1', 'm2'] });
  try {
    const models = await (await fetch(fake.url + '/models')).json();
    assert.deepEqual(models.data.map((m) => m.id), ['m1', 'm2']);
    const post = (body) => fetch(fake.url + '/chat/completions', { method: 'POST', body: JSON.stringify(body) });
    const first = await (await post({ model: 'm1', messages: [] })).json();
    assert.equal(first.choices[0].message.tool_calls[0].function.name, 'Read');
    const sse = await (await post({ model: 'm1', stream: true, messages: [] })).text();
    assert.match(sse, /"content":"do"/);
    assert.match(sse, /"total_tokens":15/);
    assert.match(sse, /\[DONE\]/);
    assert.equal(fake.requests.length, 2);
  } finally { await fake.close(); }
});
