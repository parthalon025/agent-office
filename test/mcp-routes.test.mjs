// The /mcp/* routes (office_inbox, office_room, office_ask), and the same office tools called by a local agent in-process,
// against a real server.mjs. The server runs from a throwaway copy of the code, so its state, hook files and .office-token
// stay out of this folder and a running office is never touched. A random port, a fake OpenAI server on 127.0.0.1 for the
// local provider, no model, no Claude. Sessions are opened through /api/open, which is Windows-only, so other systems skip.
// Two tokens (auth.mjs): the /mcp routes take the agent token from the copy's .office-token, the /api routes and the event
// stream take the page token from the copy's page file, which goes to the test's own LOCALAPPDATA (auth.pageFile).
// OFFICE_OPEN=0: the server opens no browser.
// Run: npm test
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';
import { pageFile, routeOf } from '../auth.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = process.platform !== 'win32' ? 'opening sessions is only implemented for Windows' : false;
const PAST_UID = 'past-claude-1';
let base, work, child, port, agentToken, pageToken, fake, log = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  s.on('error', reject);
});
const until = async (fn, what, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}\n${log.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
// auth: true sends the token of the route's group, false sends none, a string sends that token.
const tokenFor = (route) => (routeOf('POST', route) === 'agent' ? agentToken : pageToken);
const call = (route, body, { auth = true } = {}) => {
  const t = auth === true ? tokenFor(route) : auth || null;
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { 'x-office-token': t } : {}) }, body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
};
// A local agent session, opened as the page opens one. Its uid is also its office id.
async function open(name) {
  const r = await call('/api/open', { cwd: work, name, provider: 'ollama', model: 'fake-model', where: 'office' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.uid;
}
// One session with all its data (provider, budget, ...) and its feed lines: the snapshot carries only what the page reads.
const fullOf = async (uid) => { const r = await fetch(`http://127.0.0.1:${port}/api/session?uid=${encodeURIComponent(uid)}`, { headers: { 'x-office-token': pageToken } }); return r.ok ? r.json() : null; };
const sessionOf = async (uid) => (await fullOf(uid))?.session;
// The lean snapshot the page gets first on the event stream (room figures, repos, the Security room).
async function snapshot() {
  const ctl = new AbortController();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/events`, { headers: { 'x-office-token': pageToken }, signal: ctl.signal });
    const reader = r.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += Buffer.from(value).toString('utf8');
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) return JSON.parse(m[1]);
    }
  } finally { ctl.abort(); }
}

before(async () => {
  if (SKIP) return;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mcp-'));
  const copy = path.join(base, 'office');
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(copy);
  for (const f of fs.readdirSync(SRC)) {
    if (/\.(mjs|json|ps1)$/.test(f) && !['state.json', 'history.json'].includes(f) && !f.startsWith('office-')) fs.copyFileSync(path.join(SRC, f), path.join(copy, f));
  }
  for (const d of ['providers', 'public']) fs.cpSync(path.join(SRC, d), path.join(copy, d), { recursive: true });
  fake = await startFakeOpenAI({ script: [{ text: 'ok' }], models: ['fake-model'] });
  port = await freePort();
  // A claude.exe that fails before init: node.exe under that name. It answers the headless flags with "bad option" and exits
  // at once, so Reopen of a Claude Code record starts a process that never reaches init. No Claude Code, no paid call.
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  try { fs.linkSync(process.execPath, path.join(bin, 'claude.exe')); } catch { fs.copyFileSync(process.execPath, path.join(bin, 'claude.exe')); }
  // A past Claude Code session the server loads at start (history.json is read once, at start).
  fs.writeFileSync(path.join(copy, 'history.json'), JSON.stringify([{ uid: PAST_UID, sid: 'past-sid-1', provider: 'claude-code', name: 'past-claude', cwd: work, model: 'sonnet',
    cost: 0.5, turns: 2, startedAt: 1000, endedAt: 2000, worktree: null, replies: [{ id: 1, text: 'earlier answer' }], prompt: 'earlier ask', budget: null }]));
  const env = { ...process.env, PATH: bin + path.delimiter + (process.env.PATH || process.env.Path || ''), OFFICE_PORT: String(port), OFFICE_HOOKS: 'command', OFFICE_OLLAMA_URL: fake.url, OFFICE_RATE_FILE: path.join(base, 'no-rate.json'),
    OFFICE_OPEN: '0', LOCALAPPDATA: path.join(base, 'local') };
  child = spawn(process.execPath, ['server.mjs'], { cwd: copy, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).token; } catch { return null; } };
  // The server writes .office-token, then the page file, once it listens.
  agentToken = await until(() => read(path.join(copy, '.office-token')), 'the server to listen');
  pageToken = await until(() => read(pageFile(env, port)), 'the page token file');
  assert.notEqual(agentToken, pageToken);
});
after(async () => {
  if (child) child.kill();
  if (fake) await fake.close();
  await new Promise((r) => setTimeout(r, 300)); // let Windows release the folder
  if (base) try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* a temp folder may stay */ }
});

test('every /mcp route needs the agent token; the page token does not open them, and the agent token opens no /api route', { skip: SKIP }, async () => {
  for (const r of ['/mcp/inbox', '/mcp/ask', '/mcp/room', '/mcp/room/update']) {
    assert.equal((await call(r, {}, { auth: false })).status, 401, r);
    assert.equal((await call(r, {}, { auth: pageToken })).status, 401, r + ' with the page token');
  }
  for (const r of ['/api/open', '/api/history', '/api/reopen', '/api/message']) assert.equal((await call(r, {}, { auth: agentToken })).status, 401, r + ' with the agent token');
});

test('an unknown caller is told so: inbox and ask answer text, room answers 404', { skip: SKIP }, async () => {
  const inbox = await call('/mcp/inbox', { office_id: 'nobody' });
  assert.equal(inbox.status, 200);
  assert.match(inbox.json.text, /does not recognise this session/);
  const ask = await call('/mcp/ask', { office_id: 'nobody', question: 'hi?' });
  assert.equal(ask.status, 200);
  assert.match(ask.json.text, /does not recognise this session/);
  const room = await call('/mcp/room', { office_id: 'nobody' });
  assert.equal(room.status, 404);
  assert.match(room.json.error, /does not recognise this session/);
});

test('the local providers are registered, and an unknown agent kind is refused', { skip: SKIP }, async () => {
  const bad = await call('/api/open', { cwd: work, provider: 'nope', model: 'm' });
  assert.equal(bad.status, 400);
  const noModel = await call('/api/open', { cwd: work, provider: 'ollama' });
  assert.equal(noModel.status, 400);
  assert.match(noModel.json.error, /Pick a model/);
  const info = await fetch(`http://127.0.0.1:${port}/api/providers`, { headers: { 'x-office-token': pageToken } }).then((r) => r.json());
  const kinds = info.providers.map((p) => p.kind);
  assert.deepEqual(kinds.sort(), ['claude-code', 'lmstudio', 'ollama']);
  const ollama = info.providers.find((p) => p.kind === 'ollama');
  assert.equal(ollama.ready, true);
  assert.deepEqual(ollama.models.map((m) => m.id), ['fake-model']);
});

test('office_inbox returns what the user sent during a turn, once', { skip: SKIP }, async () => {
  fake.reset([{ text: 'slow answer', delayMs: 1200 }]);
  const uid = await open('inbox');
  assert.equal((await call('/mcp/inbox', { office_id: uid })).json.text, 'No new messages.');
  assert.equal((await call('/api/message', { uid, text: 'start' })).json.sent, true);
  const sent = await call('/api/message', { uid, text: 'please read me' }); // the turn is running, so it waits in the inbox
  assert.equal(sent.json.queued, 1);
  assert.equal((await call('/mcp/inbox', { office_id: uid })).json.text, '- please read me');
  assert.equal((await call('/mcp/inbox', { office_id: uid })).json.text, 'No new messages.');
  await until(async () => (await sessionOf(uid)).status === 'idle', 'the turn to end');
});

test('office_room describes the room, and office_room_update checks its arguments', { skip: SKIP }, async () => {
  const uid = await open('room');
  const room = await call('/mcp/room', { office_id: uid });
  assert.equal(room.status, 200);
  assert.match(room.json.text, /notes board/i);
  assert.equal((await call('/mcp/room/update', { office_id: uid })).status, 400);
  assert.equal((await call('/mcp/room/update', { office_id: uid, notes_append: 'a', notes_replace: 'b' })).status, 400);
  const ok = await call('/mcp/room/update', { office_id: uid, pin: 'Deploy at 5' });
  assert.equal(ok.status, 200);
  assert.match(ok.json.text, /Pinned on the blackboard: "Deploy at 5"/);
});

test('office_ask waits, and the next message the user sends is its answer', { skip: SKIP }, async () => {
  const uid = await open('ask');
  const waiting = call('/mcp/ask', { office_id: uid, question: 'Deploy now?' });
  const s = await until(async () => { const x = await sessionOf(uid); return x.questions.length ? x : null; }, 'the question to show');
  assert.equal(s.questions[0].text, 'Deploy now?');
  assert.equal((await call('/api/message', { uid, text: 'yes, go ahead' })).json.answered, true);
  const answer = await waiting;
  assert.equal(answer.status, 200);
  assert.equal(answer.json.text, 'yes, go ahead');
  assert.equal((await sessionOf(uid)).questions.length, 0);
});

test('a local agent calls office_ask in-process: the user answers, and the model gets the answer', { skip: SKIP }, async () => {
  fake.reset([{ toolCalls: [{ name: 'office_ask', args: { question: 'Ship it?' } }] }, { text: 'shipping' }]);
  const uid = await open('inproc');
  await call('/api/message', { uid, text: 'go' });
  const s = await until(async () => { const x = await sessionOf(uid); return x.questions.length ? x : null; }, 'the question to show');
  assert.equal(s.questions[0].text, 'Ship it?');
  assert.equal(s.status, 'waiting');
  assert.equal((await call('/api/message', { uid, text: 'yes' })).json.answered, true);
  await until(async () => (await sessionOf(uid)).status === 'idle', 'the turn to end');
  assert.ok(fake.requests[0].tools.some((t) => t.function.name === 'office_ask'));
  assert.equal(fake.requests[1].messages.at(-1).role, 'tool');
  assert.equal(fake.requests[1].messages.at(-1).content, 'yes');
});

test('a past local session reopens as a fresh local session in the same folder', { skip: SKIP }, async () => {
  fake.reset([{ text: 'hello there' }]);
  const uid = await open('past');
  await call('/api/message', { uid, text: 'hi' });
  await until(async () => (await sessionOf(uid)).status === 'idle', 'the turn to end');
  assert.equal((await call('/api/close', { uid })).status, 200);
  const rec = await until(async () => {
    const h = await call('/api/history', {});
    return (h.json.sessions || []).find((x) => x.uid === uid);
  }, 'the past session in the history');
  assert.ok(rec, 'the closed local session is in the history');
  const re = await call('/api/reopen', { uid });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  const s = await sessionOf(re.json.uid);
  assert.notEqual(re.json.uid, uid);
  assert.equal(s.provider, 'ollama');
  assert.equal(s.model, 'fake-model', 'the same model as the past session');
  assert.equal(s.cwd.toLowerCase(), work.toLowerCase());
  const { feed } = await fullOf(re.json.uid);
  assert.ok(feed.some((f) => /cannot resume a past session/.test(f.text || '')), 'the feed says why it is a new session');
});

// ---------- default spend limit (#33). No paid session opens here: a paid one would start claude. ----------
const info = () => fetch(`http://127.0.0.1:${port}/api/info`, { headers: { 'x-office-token': pageToken } }).then((r) => r.json());

test('a local session has no spend limit, also when the default is set or one is asked for', { skip: SKIP }, async () => {
  assert.equal((await info()).spendLimit, 2, 'the built-in default');
  const a = await open('free-a');
  assert.equal((await sessionOf(a)).budget, null);
  const b = await call('/api/open', { cwd: work, name: 'free-b', provider: 'ollama', model: 'fake-model', where: 'office', maxBudget: 9 });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal((await sessionOf(b.json.uid)).budget, null, 'a model on this machine costs nothing');
});

// The Attach sessions dialog hides the agent token until the user clicks Show (#60), so info must carry it.
test('info gives the agent token to the page token only', { skip: SKIP }, async () => {
  assert.equal((await info()).agentToken, agentToken, 'the page can show and copy the token the hooks need');
  const r = await fetch(`http://127.0.0.1:${port}/api/info`, { headers: { 'x-office-token': agentToken } });
  assert.equal(r.status, 401, 'the agent token opens no /api route');
});

test('the default spend limit shows in info, can be changed or cleared, and a bad value is refused', { skip: SKIP }, async () => {
  assert.equal((await call('/api/settings/spend', { limit: 5 })).json.spendLimit, 5);
  assert.equal((await info()).spendLimit, 5);
  // No limit is the loosest setting: it needs confirmed (the wall's painted Confirm, the dialog's Save) (#70)
  const loose = await call('/api/settings/spend', { limit: '' });
  assert.equal(loose.status, 409, 'No limit without a confirm is refused');
  assert.equal((await info()).spendLimit, 5, 'and changes nothing');
  assert.equal((await call('/api/settings/spend', { limit: '', confirmed: true })).json.spendLimit, 0, 'cleared: no default limit');
  assert.equal((await info()).spendLimit, 0);
  for (const bad of ['abc', -1, 1001]) {
    const r = await call('/api/settings/spend', { limit: bad });
    assert.equal(r.status, 400, String(bad));
    assert.match(r.json.error, /0 to 1000/);
  }
  assert.equal((await info()).spendLimit, 0, 'a refused value changes nothing');
  assert.equal((await call('/api/settings/spend', { limit: 2 })).json.spendLimit, 2);
});

test('a new schedule gets the default spend limit; the user can change or clear it', { skip: SKIP }, async () => {
  const save = async (extra) => (await call('/api/schedule/save', { name: 's', prompt: 'p', cwd: work, ...extra })).json.maxBudget;
  assert.equal(await save({}), 2, 'no limit given: the default');
  assert.equal(await save({ maxBudget: 6 }), 6);
  assert.equal(await save({ maxBudget: 0 }), 0, '0 clears it');
  await call('/api/settings/spend', { limit: 4 });
  assert.equal(await save({}), 4, 'the default the user set');
  await call('/api/settings/spend', { limit: 2 });
});

test('a Claude Code reopen that fails before init keeps the past session in history and shows the failure', { skip: SKIP }, async () => {
  const before = (await call('/api/history', {})).json.sessions.map((x) => x.uid);
  assert.ok(before.includes(PAST_UID), 'the seeded past session is listed');
  const re = await call('/api/reopen', { uid: PAST_UID });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  const s = await until(async () => { const x = await sessionOf(re.json.uid); return x && x.status === 'ended' ? x : null; }, 'the reopened session to end');
  const after = (await call('/api/history', {})).json.sessions.map((x) => x.uid);
  assert.ok(after.includes(PAST_UID), 'the past session is still in history');
  assert.ok(s.error, 'the failure shows as an error on the session');
  assert.match(s.error.text, /Past sessions/, 'the error says the past session stays');
  assert.match(s.replies.at(-1).text, /stopped before it started/, 'the reply says why');
  const again = await call('/api/reopen', { uid: PAST_UID });
  assert.equal(again.status, 200, 'the user can try again');
  // Wait for this second try to end too: on a slow machine (the CI runner) it is still starting when the next test
  // reopens the same past session, and that test then gets 409 open again.
  await until(async () => { const x = await sessionOf(again.json.uid); return x && x.status === 'ended' ? x : null; }, 'the second try to end');
});

// A claude.exe that stays alive: cmd.exe under that name ignores the headless flags and waits on stdin, like a Claude Code
// that has not got its first message yet. It never sends init, so a hook for the session stands in for "it has started".
const liveClaude = async () => {
  const exe = path.join(base, 'bin', 'claude.exe');
  await until(() => { try { fs.rmSync(exe, { force: true }); return true; } catch { return false; } }, 'the failing claude.exe to be free');
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'cmd.exe'), exe);
};
const pastUids = async () => (await call('/api/history', {})).json.sessions.map((x) => x.uid);

test('a live reopen hides its past record and cannot start twice; closing it before it starts gives the record back, with no error', { skip: SKIP }, async () => {
  await liveClaude();
  const re = await call('/api/reopen', { uid: PAST_UID });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  const live = await sessionOf(re.json.uid);
  assert.ok(live && live.status !== 'ended', 'the reopened session is live');
  assert.ok(!(await pastUids()).includes(PAST_UID), 'one session shows once: the past record is hidden while its reopen is live');
  const twice = await call('/api/reopen', { uid: PAST_UID });
  assert.equal(twice.status, 409, 'a second click does not start a second process on the same conversation');
  assert.match(twice.json.error, /open again/);
  assert.equal((await call('/api/close', { uid: re.json.uid })).status, 200);
  const s = await sessionOf(re.json.uid);
  assert.equal(s.status, 'ended');
  assert.equal(s.error, null, 'a close the user asked for is not a failed reopen');
  assert.ok((await pastUids()).includes(PAST_UID), 'the past record is back once the reopen is over');
});

test('a live reopen swaps the past record for its own as soon as it has a sid', { skip: SKIP }, async () => {
  await liveClaude();
  const re = await call('/api/reopen', { uid: PAST_UID });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  const hook = await fetch(`http://127.0.0.1:${port}/hook/http`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': agentToken, 'x-office-id': re.json.uid },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'resumed-sid-1', cwd: work, source: 'resume' }),
  });
  assert.equal(hook.status, 200);
  const h = await until(async () => { const l = await pastUids(); return l.includes(re.json.uid) ? l : null; }, 'the reopened session in Past sessions');
  assert.ok(!h.includes(PAST_UID), 'the old record is gone: the session is listed once, under its new uid');
  assert.equal((await call('/api/reopen', { uid: PAST_UID })).status, 404, 'there is no old record to reopen');
  await call('/api/close', { uid: re.json.uid });
});

// ---------- agent rooms (#69): POST /api/open makes a room for each agent ----------
test('/api/open gives each agent a worktree on the base floor; isolation "same" and a folder outside git work in the folder', { skip: SKIP }, async () => {
  const { resolveExe } = await import('../git.mjs');
  const { execFileSync } = await import('node:child_process');
  const repo = path.join(base, 'rooms-repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync(resolveExe('git'), ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8', windowsHide: true });
  g('init', '-q', '-b', 'trunk'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const openIn = async (cwd, name, extra = {}) => {
    const r = await call('/api/open', { cwd, name, provider: 'ollama', model: 'fake-model', where: 'office', ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.uid;
  };
  const placed = (uid, what) => until(async () => { const s = await sessionOf(uid); return s?.place ? s : null; }, what);
  const a = await openIn(repo, 'room-a'), b = await openIn(repo, 'room-b');
  const sa = await placed(a, 'the place of the first agent'), sb = await placed(b, 'the place of the second agent');
  for (const s of [sa, sb]) {
    assert.match(s.worktree.branch, /^agent\/room-[ab]-[0-9a-f]{4}$/);
    assert.equal(s.place.floor, 'trunk', 'the room sits on the floor of the base branch');
    assert.equal(s.place.room, s.worktree.branch, 'the sign shows the worktree branch');
    assert.ok(s.cwd.toLowerCase().includes('rooms-repo.worktrees'), s.cwd);
  }
  assert.notEqual(sa.place.roomId, sb.place.roomId, 'two agents, two rooms');
  // "Use this folder": both agents share the room of the folder
  const c = await openIn(repo, 'shared-c', { isolation: 'same' }), d = await openIn(repo, 'shared-d', { isolation: 'same' });
  const sc = await placed(c, 'the place of the third agent'), sd = await placed(d, 'the place of the fourth agent');
  assert.equal(sc.worktree, null);
  assert.equal(sc.place.roomId, sd.place.roomId);
  assert.equal((await snapshot()).figures[sc.place.noteKey].sessions, 2, 'the shared room counts two agents');
  // a folder outside git has no room to make: the agent works in the folder, and the feed says so
  const e = await openIn(work, 'no-git-e');
  const full = await until(async () => { const f = await fullOf(e); return f && f.feed.some((x) => /not in git/.test(x.text)) ? f : null; }, 'the feed line of the agent outside git');
  assert.equal(full.session.worktree, null);
  for (const u of [a, b, c, d, e]) await call('/api/close', { uid: u });
});
