import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalTools, TOOL_DEFINITIONS, killTree, LIMITS } from '../providers/local-tools.mjs';
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

test('a broken link that points outside is refused, and nothing is created there', async (c) => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    const gone = path.join(s.base, 'gone');
    fs.mkdirSync(gone);
    try { fs.symlinkSync(gone, path.join(s.root, 'dead'), 'junction'); } catch { c.skip('links are not allowed here'); return; }
    fs.rmSync(gone, { recursive: true }); // the link now points at nothing, outside the folder
    for (const args of [{ file_path: 'dead/new.txt', content: 'x' }, { file_path: 'dead/sub/new.txt', content: 'x' }, { file_path: 'dead', content: 'x' }]) {
      const r = await t.run('Write', args);
      assert.equal(r.ok, false, JSON.stringify(args));
    }
    assert.equal(fs.existsSync(gone), false, 'the missing folder was not made again through the link');
  } finally { s.done(); }
});

test('a broken file link that points outside is refused for Write', async (c) => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    const target = path.join(s.base, 'planted.txt');
    try { fs.symlinkSync(target, path.join(s.root, 'fl.txt'), 'file'); } catch { c.skip('file links are not allowed here'); return; }
    const r = await t.run('Write', { file_path: 'fl.txt', content: 'x' });
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(target), false);
  } finally { s.done(); }
});

test('Grep never reads secret or settings files, in a search of the whole folder or of one of them', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    fs.writeFileSync(path.join(s.root, '.env'), 'API_KEY=needle-secret');
    fs.writeFileSync(path.join(s.root, '.office-token'), 'needle-token');
    fs.writeFileSync(path.join(s.root, 'server.pem'), 'needle-pem');
    fs.mkdirSync(path.join(s.root, '.ssh'));
    fs.writeFileSync(path.join(s.root, '.ssh', 'id_rsa'), 'needle-ssh');
    fs.mkdirSync(path.join(s.root, '.claude'));
    fs.writeFileSync(path.join(s.root, '.claude', 'settings.json'), 'needle-settings');
    const all = await t.run('Grep', { pattern: 'needle' });
    assert.match(all.text, /src\/b\.js:1/, 'normal files are still searched');
    assert.doesNotMatch(all.text, /secret|token|pem|ssh|settings/);
    for (const p of ['.env', '.office-token', '.ssh', '.claude', 'server.pem']) {
      assert.equal((await t.run('Grep', { pattern: 'needle', path: p })).text, 'No matches.', p);
    }
  } finally { s.done(); }
});

test('a root under a settings folder still searches its own files', async () => {
  const s = scratch();
  const inner = path.join(s.base, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'f.txt'), 'findme');
  const t = createLocalTools(inner);
  try { assert.match((await t.run('Grep', { pattern: 'findme' })).text, /f\.txt:1/); } finally { s.done(); }
});

// ---------- the same tools for an ACP agent (#71): raw file text, a refusal before any approval, and terminals ----------

test('readText gives the raw text (no line numbers), a line range, and refuses binary, missing, large and outside files', () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    assert.deepEqual(t.readText(path.join(s.root, 'a.txt')), { ok: true, text: 'one\ntwo\nthree\n' });
    assert.deepEqual(t.readText('a.txt', { line: 2, limit: 1 }), { ok: true, text: 'two' });
    assert.deepEqual(t.readText('a.txt', { line: 3 }), { ok: true, text: 'three\n' });
    fs.writeFileSync(path.join(s.root, 'bin.dat'), Buffer.from([1, 0, 2]));
    assert.match(t.readText('bin.dat').text, /Not a text file/);
    assert.match(t.readText('nope.txt').text, /No such file/);
    assert.match(t.readText(path.join(s.outside, 'key.txt')).text, /outside the working folder/);
    fs.writeFileSync(path.join(s.root, 'big.txt'), 'x'.repeat(LIMITS.textBytes + 1));
    const big = t.readText('big.txt');
    assert.equal(big.ok, false, 'never a cut file: an agent that writes it back would lose the rest');
    assert.match(big.text, /larger than/);
  } finally { s.done(); }
});

test('guard refuses a path outside the folder without running anything; a path inside passes', () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    assert.equal(t.guard('Write', { file_path: path.join(s.root, 'new.txt') }), null);
    assert.match(t.guard('Write', { file_path: path.join(s.outside, 'x.txt') }), /outside the working folder/);
    assert.match(t.guard('Read', { file_path: '../secret/key.txt' }), /outside the working folder/);
    assert.match(t.guard('LS', { path: s.outside }), /outside the working folder/);
    assert.equal(fs.existsSync(path.join(s.outside, 'x.txt')), false);
  } finally { s.done(); }
});

test('start runs one command in the background: output while it runs, the exit, kill, and a folder inside the root only', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    const h = t.start('node -e "console.log(\'hi\'); setTimeout(() => process.exit(4), 300)"', { cwd: path.join(s.root, 'src') });
    assert.match(await waitFor(() => (/hi/.test(h.output()) ? h.output() : null)), /hi/);
    assert.equal(h.exit(), null, 'still running');
    assert.deepEqual(await h.done, { exitCode: 4, signal: null, timedOut: false });
    assert.deepEqual(h.exit(), { exitCode: 4, signal: null });
    const long = t.start(SLEEP);
    long.kill();
    const end = await long.done;
    assert.ok(end.exitCode !== 0 || end.signal, 'killed');
    assert.throws(() => t.start('echo x', { cwd: s.outside }), /outside the working folder/);
    assert.throws(() => t.start('  '), /command is empty/);
  } finally { s.done(); }
});

test('start keeps the end of the output under a byte limit, cut at a character, and says it was cut', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    const h = t.start('node -e "process.stdout.write(String.fromCharCode(97).repeat(5000) + String.fromCharCode(233, 233) + \'END\')"', { keep: 'end', limitBytes: 100 });
    await h.done;
    const out = h.output();
    assert.ok(out.endsWith('ééEND'), JSON.stringify(out.slice(-20)));
    assert.ok(Buffer.byteLength(out) <= 100);
    assert.ok(!out.includes('�'), 'no half character at the cut');
    assert.equal(h.truncated(), true);
  } finally { s.done(); }
});

test('stop() also kills commands that start() began', async () => {
  const s = scratch(); const t = createLocalTools(s.root);
  try {
    const h = t.start(SLEEP);
    await new Promise((r) => setTimeout(r, 200));
    t.stop();
    const end = await h.done;
    assert.ok(end.exitCode !== 0 || end.signal);
  } finally { s.done(); }
});

async function waitFor(fn, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}
