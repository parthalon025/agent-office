// The ACP file and terminal service (#176, providers/acp-files.mjs) with a fake ask module and fake tools: refusal outside the
// root before anyone is asked, a grant is used once, a declined file is not written another way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFiles } from '../src/providers/acp-files.mjs';
import { REFUSED } from '../src/providers/acp-rpc.mjs';
import { fileKey } from '../src/risk.mjs';

function rig({ verdict = 'allow', outside = false } = {}) {
  const held = [], feed = [], ran = [];
  const asks = { hold: (s, st, req, done, opts) => { held.push([req, opts]); done(verdict, verdict === 'deny' ? 'Denied by the Security room.' : ''); return 'r1'; } };
  const events = { feed: (s, k, t) => feed.push(t) };
  const files = createFiles({ events, asks, emit: (st, fn) => fn(), makeId: () => 'id1' });
  const tools = {
    guard: () => (outside ? 'outside' : null),
    readText: () => ({ ok: true, text: 'hello' }),
    run: async (n, i) => { ran.push([n, i]); return { ok: true }; },
    start: (line) => { ran.push(['start', line]); return { output: () => 'out', truncated: () => false, exit: () => null, kill() {}, done: Promise.resolve({ exitCode: 0, signal: null }) }; },
  };
  const st = { root: 'E:\\r', closed: false, interrupted: false, tools, grants: new Map(), denied: new Set(), askFirst: new Set(), wrote: new Set(), deniedVague: false, terminals: new Map(), terminalIds: new Set() };
  return { files, st, s: { uid: 'u' }, held, feed, ran };
}

test('handles names the file and terminal methods and nothing else', () => {
  const { files } = rig();
  for (const m of ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output', 'terminal/release']) assert.equal(files.handles(m), true);
  for (const m of ['session/update', 'toString', '__proto__']) assert.equal(files.handles(m), false);
});

test('a read outside the root is refused unasked, with a feed line', async () => {
  const r = rig({ outside: true });
  await assert.rejects(r.files.serve(r.s, r.st, 'fs/read_text_file', { path: 'C:\\x' }), (e) => e.code === REFUSED);
  assert.equal(r.held.length, 0);
  assert.match(r.feed[0], /refused a read outside/);
});

test('a write asks the office, runs, and is recorded; a Deny refuses with its reason', async () => {
  const r = rig();
  await r.files.serve(r.s, r.st, 'fs/write_text_file', { path: 'E:\\r\\a.txt', content: 'x' });
  assert.equal(r.ran[0][0], 'Write');
  assert.equal(r.st.wrote.size, 1);
  const d = rig({ verdict: 'deny' });
  await assert.rejects(d.files.serve(d.s, d.st, 'fs/write_text_file', { path: 'E:\\r\\a.txt', content: 'x' }), /Denied by the Security room/);
});

test('a grant from an approved request runs once without a question; a declined file is not written', async () => {
  const r = rig();
  r.st.grants.set('Bash\necho hi', 'call1');
  const t = await r.files.serve(r.s, r.st, 'terminal/create', { command: 'echo', args: ['hi'], cwd: 'E:\\r' });
  assert.equal(t.terminalId, 'term_id1');
  assert.equal(r.held.length, 0);
  assert.equal(r.st.grants.size, 0);
  assert.deepEqual(await r.files.serve(r.s, r.st, 'terminal/wait_for_exit', { terminalId: t.terminalId }), { exitCode: 0, signal: null });
  await r.files.serve(r.s, r.st, 'terminal/create', { command: 'echo', args: ['hi'] });
  assert.equal(r.held.length, 1);
  r.st.denied.add(fileKey(r.st.root, 'E:\\r\\no.txt'));
  await assert.rejects(r.files.serve(r.s, r.st, 'fs/write_text_file', { path: 'E:\\r\\no.txt', content: 'x' }), /declined the edit/);
});

test('a turn with a vague declined edit makes every write ask firm', async () => {
  const r = rig();
  r.st.deniedVague = true;
  await r.files.serve(r.s, r.st, 'fs/write_text_file', { path: 'E:\\r\\a.txt', content: 'x' });
  assert.equal(r.held[0][1].firm, true);
});
