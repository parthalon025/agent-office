// Smoke test for the office server. Needs the office running (npm start) and Claude Code logged in.
// It opens real sessions on Haiku (a few cents), works in a throwaway git repo, and cleans up after itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', '.office-token'), 'utf8'));
const S = path.join(os.tmpdir(), 'agent-office-smoke').split(path.sep).join('/');
fs.mkdirSync(S, { recursive: true });
const api = async (route, body) => { const r = await fetch(`http://127.0.0.1:${cfg.port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': cfg.token }, body: JSON.stringify(body || {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) j._status = r.status; return j; };
const snap = () => new Promise((res) => { fetch(`http://127.0.0.1:${cfg.port}/events?t=${cfg.token}`).then(async (r) => { const rd = r.body.getReader(); const { value } = await rd.read(); rd.cancel(); res(JSON.parse(new TextDecoder().decode(value).split('\n')[0].slice(6))); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(700); } return null; };
const me = async (uid) => (await snap()).sessions.find((x) => x.uid === uid);
const ok = (name, cond, extra = '') => console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''));

// a scratch git repo
const repo = S + '/repo1';
fs.rmSync(repo, { recursive: true, force: true });
fs.mkdirSync(repo, { recursive: true });
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
fs.writeFileSync(repo + '/hello.txt', 'line one\n'); g('add', '-A'); g('commit', '-qm', 'init');

// 1) open with worktree, budget; first prompt makes an edit
const o = await api('/api/open', { cwd: repo, name: 'wt test', model: 'haiku', where: 'office', isolation: 'worktree', maxBudget: 1, permissionMode: 'default', prompt: 'Append the line "line two" to hello.txt using the Edit or Write tool, then say done.' });
ok('open with worktree', !!o.uid, JSON.stringify(o));
const uid = o.uid;
let s = await me(uid);
ok('worktree recorded', s?.worktree?.branch?.startsWith('office/wt-test-'), s?.worktree?.branch);
ok('cwd is the worktree', s?.cwd?.replace(/\\/g, '/').includes('.agent-office/worktrees'), s?.cwd);
ok('budget recorded', s?.budget === 1);

// 2) permission request with preview (edit needs permission in default mode)
const pend = await until(async () => { const x = await me(uid); return x?.pending?.length ? x : null; }, 60000);
ok('permission pending with preview', !!pend && /line two/.test(pend.pending[0].preview || ''), pend && JSON.stringify(pend.pending[0]).slice(0, 260));
if (pend) {
  const id = pend.pending[0].id;
  // Claude only offers an "always allow" rule for some tools (WebFetch, Bash). For Edit it offers a mode switch, so none is expected here.
  console.log('   always-allow rule offered:', pend.pending[0].always || '(none for Edit)');
  const a = await api('/api/answer', { id, allow: true, always: false });
  ok('approve', a.ok === true, JSON.stringify(a));
}
const done = await until(async () => { const x = await me(uid); return x && x.status === 'idle' && x.turns >= 1 && x.replies.length ? x : null; }, 80000);
ok('turn finished with reply', !!done, done && done.replies.map((r) => r.text.slice(0, 60)).join(' / '));
ok('cost tracked', typeof done?.cost === 'number', String(done?.cost));

// 3) changes in worktree
const ch = await api('/api/changes', { uid });
ok('changes show hello.txt diff', ch.files?.some((f) => f.path.includes('hello.txt')) && /line two/.test(ch.diff || ''), JSON.stringify({ branch: ch.branch, files: ch.files, stat: ch.stat }));

// 4) control: mode, model, interrupt
let r = await api('/api/control', { uid, action: 'mode', value: 'plan' }); await wait(1500);
s = await me(uid); ok('mode switched', s?.mode === 'plan', 'mode=' + s?.mode);
r = await api('/api/control', { uid, action: 'model', value: 'sonnet' }); await wait(1500);
s = await me(uid); ok('model switched', /sonnet/.test(s?.model || ''), 'model=' + s?.model);
r = await api('/api/control', { uid, action: 'mode', value: 'default' }); await wait(800);
await api('/api/message', { uid, text: 'Count from 1 to 80, one number per line, nothing else.' });
const live = await until(async () => { const x = await me(uid); return x && x.status === 'working' ? x : null; }, 30000);
ok('turn running', !!live);
await wait(1800);
const sawLive = (await me(uid))?.live || '';
await api('/api/interrupt', { uid });
const idle = await until(async () => { const x = await me(uid); return x && x.status === 'idle' ? x : null; }, 20000);
ok('interrupt returns to idle', !!idle);
console.log('   live text seen mid-turn:', JSON.stringify(sawLive.slice(-40)));
ok('no error reply after interrupt', !(idle?.replies || []).some((x) => /Stopped with an error/.test(x.text)));

// 5) image attachment
const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const before = (await me(uid)).replies.length;
const m = await api('/api/message', { uid, text: 'Reply with the single word: pixel', attachments: [{ name: 'dot.png', mime: 'image/png', data: px }, { name: 'n.txt', mime: 'text/plain', data: Buffer.from('hello file').toString('base64') }] });
ok('attachment accepted', m.ok === true, JSON.stringify(m));
const bad = await api('/api/message', { uid, text: 'x', attachments: [{ name: 'a.exe', mime: 'application/octet-stream', data: 'AAAA' }] });
ok('binary attachment refused', bad._status === 415, JSON.stringify(bad));
const got = await until(async () => { const x = await me(uid); return x && x.status === 'idle' && x.replies.length > before ? x : null; }, 60000);
ok('reply after attachment', !!got, got && got.replies[got.replies.length - 1].text.slice(0, 50));

// 6) close, history, search, reopen
await api('/api/close', { uid }); await wait(1500);
const hist = await api('/api/history', {});
const rec = hist.sessions.find((x) => x.uid === uid);
ok('session in past list', !!rec, rec && JSON.stringify({ name: rec.name, turns: rec.turns, branch: rec.branch }));
const sr = await api('/api/search', { q: 'pixel' });
ok('search finds reply', sr.results.some((x) => x.uid === uid), JSON.stringify(sr.results.slice(0, 1)));
const re = await api('/api/reopen', { uid });
ok('reopen', !!re.uid, JSON.stringify(re));
if (re.uid) {
  const back = await until(async () => { const x = await me(re.uid); return x && x.sid ? x : null; }, 40000);
  ok('reopened has history replies', (back?.replies?.length || 0) >= 2, 'replies=' + back?.replies?.length);
  await api('/api/message', { uid: re.uid, text: 'What word did I ask you to reply with last time? One word.' });
  const ans = await until(async () => { const x = await me(re.uid); return x && x.status === 'idle' && x.replies.length > (back?.replies?.length || 0) ? x : null; }, 60000);
  ok('resumed context', /pixel/i.test(ans?.replies?.slice(-1)[0]?.text || ''), ans && ans.replies.slice(-1)[0].text.slice(0, 60));
  await api('/api/close', { uid: re.uid }); await wait(1200);
}

// 7) remove worktree
const hist2 = await api('/api/history', {});
const lastUid = hist2.sessions[0]?.uid;
const rm = await api('/api/worktree/remove', { uid: lastUid, force: true });
ok('worktree removed', rm.removed === true, JSON.stringify(rm));

// 8) templates + schedules CRUD
const t = await api('/api/template/save', { name: 'Review', text: 'Review the open changes.' });
ok('template saved', !!t.id);
const sc = await api('/api/schedule/save', { name: 'Nightly', cwd: repo, prompt: 'Say hi', kind: 'daily', at: '03:00' });
ok('schedule saved', !!sc.id, JSON.stringify({ id: sc.id, kind: sc.kind, at: sc.at }));
await api('/api/template/delete', { id: t.id }); await api('/api/schedule/delete', { id: sc.id });
console.log('done');

fs.rmSync(S, { recursive: true, force: true });
