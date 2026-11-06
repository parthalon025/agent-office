// DS scene engine rules in components/bundle.js: reduced-motion camera cuts (#36), the zoom step (#56), seeded events
// and Since you left (#35), unread and Activity of seeded events (#61), the Needs you source of Since you left (#62),
// the frame inset clamp (#65), GPU memory on dispose, clear and theme change (#84), and the schema copy in
// kit/schema.json. The bundle needs WebGL and React, so each test takes the one function it checks out of the bundle
// text and runs it on plain stand-ins (no THREE, no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = readFileSync(join(root, 'components', 'bundle.js'), 'utf8').replace(/\r\n/g, '\n');

// The source of one function: from its start to the end of the line where it closes ("};" or "}" at line end).
function source(start, end = '}\n') {
  const at = bundle.indexOf(start);
  assert.ok(at >= 0, `bundle has ${start}`);
  assert.equal(bundle.indexOf(start, at + 1), -1, `${start} is in the bundle once`);
  const stop = bundle.indexOf(end, at);
  assert.ok(stop > at, `end of ${start}`);
  return bundle.slice(at, stop + end.length);
}

class V {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new V(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  setFromMatrixColumn(m, i) { return this.copy(m.cols[i]); }
}
function Stage() {}
new Function('T', 'Stage', 'DUR',
  source('Stage.prototype.frame=function', '};\n') + source('Stage.prototype.goalStep=function', '};\n') + source('Stage.prototype.zoom=function', '};\n')
)({ Vector3: V }, Stage, { camera: 600 });

function stage(rm) {
  const s = Object.create(Stage.prototype);
  Object.assign(s, {
    rm, D: 11, goal: null, sunOff: null, ext: null,
    ctl: { target: new V(), minZoom: 0.4, maxZoom: 4 },
    cam: { position: new V(10, 10, 10), zoom: 1, updateProjectionMatrix() {} },
    sun: { position: new V(), target: { position: new V() } },
    shadowFit() {}, resize() {}, fitD() { return 7; }
  });
  return s;
}
const xyz = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e6);

test('frame glides without reduced motion: a goal, and each goal step moves part of the way (#36)', () => {
  const s = stage(false);
  s.frame([1, 2, 3], 9, 1.5);
  assert.ok(s.goal, 'a camera goal');
  assert.deepEqual(xyz(s.ctl.target), [0, 0, 0]);
  assert.equal(s.D, 11);
  s.goalStep(0.016);
  assert.ok(s.goal, 'one frame does not finish the glide');
  assert.ok(s.ctl.target.x > 0 && s.ctl.target.x < 1);
  assert.ok(s.D < 11 && s.D > 9);
});

test('frame under reduced motion: the move is still a goal, and the first goal step cuts to it (#36)', () => {
  const s = stage(true);
  s.frame([1, 2, 3], 9, 1.5);
  assert.ok(s.goal, 'a goal, so a page can hold the move back');
  assert.deepEqual(xyz(s.ctl.target), [0, 0, 0], 'nothing moves before the next frame');
  s.goalStep(0.016);
  assert.equal(s.goal, null, 'one frame ends the goal');
  assert.deepEqual(xyz(s.ctl.target), [1, 2, 3]);
  assert.deepEqual(xyz(s.cam.position), [11, 12, 13], 'the camera moves with the target');
  assert.equal(s.D, 9);
  assert.equal(s.cam.zoom, 1.5);
  s.frame([0, 0, 0], 0, 1, false, [4, 4, 4]);
  s.goalStep(0.016);
  assert.equal(s.goal, null);
  assert.equal(s.D, 7, 'ext fits D');
  s.frame([5, 5, 5], 9, 1, true);
  assert.equal(s.goal, null, 'now still cuts at once');
  assert.deepEqual(xyz(s.ctl.target), [5, 5, 5]);
});

test('reduced motion: a goal held back while it is set (the page keeps an item in focus) moves nothing (#36)', () => {
  const s = stage(true);
  let held = null, val = null, focus = true;
  Object.defineProperty(s, 'goal', { configurable: true, get: () => val, set: (v) => { if (v && focus) { held = v; return; } val = v; } });
  s.frame([4, 0, 0], 9, 2);   // a bot joins or the HUD inset changes: frameFloor()
  assert.equal(s.goal, null, 'held');
  if (s.goal) s.goalStep(0.016);   // the stage loop runs the goal step only for a goal
  assert.deepEqual(xyz(s.ctl.target), [0, 0, 0], 'the camera stays on the item in focus');
  assert.equal(s.D, 11);
  assert.equal(s.cam.zoom, 1);
  focus = false; s.goal = held;   // the focus lets go because the floor changed: the held goal runs
  s.goalStep(0.016);
  assert.deepEqual(xyz(s.ctl.target), [4, 0, 0]);
  assert.equal(s.cam.zoom, 2);
  assert.equal(s.goal, null);
});

test('the stage loop runs camera goals through goalStep; frame never forces a cut (#36)', () => {
  assert.match(source('var loop=function(){', 'requestAnimationFrame(loop);};loop();}\n'), /if\(s\.goal\)s\.goalStep\(dt\);/);
  assert.doesNotMatch(source('Stage.prototype.frame=function', '};\n'), /this\.rm/);
});

test('no floor slide starts under reduced motion, so the slide step has no reduced-motion branch (#36)', () => {
  assert.equal((bundle.match(/fx=\{/g) || []).length, 3, 'three places start a slide');
  assert.match(source(' function setFloor('), /if\(changed&&!s\.rm\)\{if\(pv==="floor"&&pf!==id&&floorG\[pf\]\)\{[^}]*fx=\{[^}]*\};[^}]*\}else fx=\{g:floorG\[id\],t:0\};\}/);
  assert.match(source(' function setView('), /if\(!s\.rm\)fx=\{/);
  assert.match(bundle, /if\(fx\)\{fx\.t=Math\.min\(1,/);
});

test('zoom: + never zooms out when a framed view is past maxZoom (#56)', () => {
  const s = stage(false);
  s.cam.zoom = 6;
  assert.equal(s.zoom(1.2), 6, '+ keeps the zoom');
  assert.equal(s.cam.zoom, 6);
  assert.equal(s.zoom(1 / 1.2), 5, '- zooms out from there');
  s.cam.zoom = 0.3;
  assert.equal(s.zoom(1 / 1.2), 0.3, '- below minZoom keeps the zoom');
  assert.ok(Math.abs(s.zoom(1.2) - 0.36) < 1e-9, '+ below minZoom steps in');
});

test('zoom: steps stay inside the controls limits, also when the page widens them (#56)', () => {
  const s = stage(false);
  s.cam.zoom = 3.5;
  assert.equal(s.zoom(1.2), 4, 'clamped to maxZoom 4');
  s.ctl.maxZoom = 9;
  s.cam.zoom = 6;
  assert.ok(Math.abs(s.zoom(1.2) - 7.2) < 1e-9, 'a widened maxZoom lets + zoom in');
  s.ctl.minZoom = 1;
  s.cam.zoom = 1.1;
  assert.equal(s.zoom(1 / 1.2), 1, 'clamped to the controls minZoom');
});

test('zoom: without controls the limits are 0.4 and 4, as before (#56)', () => {
  const s = stage(false);
  s.ctl = null;
  s.cam.zoom = 3.9;
  assert.equal(s.zoom(1.2), 4);
  s.cam.zoom = 0.41;
  assert.equal(s.zoom(1 / 1.2), 0.4);
});

// The history rules of mountOffice, on a plain store.
function historyRules(newsAfter, list = []) {
  const st = { history: list.slice() }, saves = { n: 0 };
  const fns = new Function('st', 'HMAX', 'hsoon', 'seedKeys', 'newsAfter',
    source(' function recordAt(') + source(' function recordSeeded(') + 'return { recordAt: recordAt, recordSeeded: recordSeeded };'
  )(st, 5, () => { saves.n++; }, {}, newsAfter);
  return Object.assign(fns, { st, saves });
}
const ev = (type, extra = {}) => ({ type, bot: 'Ada', ...extra });

test('a seeded event without at, or with at before the last visit, is not recorded (#35)', () => {
  const r = historyRules(1000);
  assert.equal(r.recordSeeded(ev('tool.call', { id: 'c1', seeded: true })), false);
  assert.equal(r.recordSeeded(ev('tool.call', { id: 'c1', seeded: true, at: 900 })), false);
  assert.equal(r.recordSeeded(ev('tool.call', { id: 'c1', seeded: true, at: 1000 })), false, 'at the same time is not news');
  assert.equal(r.st.history.length, 0);
  assert.equal(r.saves.n, 0);
});

test('a seeded event with at after the last visit is news: recorded once, in time order (#35)', () => {
  const r = historyRules(1000, [{ t: 500, ev: ev('status') }, { t: 3000, ev: ev('status') }]);
  assert.equal(r.recordSeeded(ev('tool.call', { id: 'c1', seeded: true, at: 2000 })), true);
  assert.deepEqual(r.st.history.map((h) => h.t), [500, 2000, 3000]);
  assert.equal(r.recordSeeded(ev('tool.call', { id: 'c1', seeded: true, at: 2000 })), false, 'the same event twice is one entry');
  assert.equal(r.recordSeeded(ev('tool.call', { id: 'c2', seeded: true, at: 2000 })), true, 'another call at the same time is its own entry');
  assert.equal(r.st.history.length, 4);
});

test('seeded events without an id for one bot at one time are each recorded; only an exact copy is skipped (#35)', () => {
  const r = historyRules(1000);
  assert.equal(r.recordSeeded(ev('message', { text: 'Tests pass.', seeded: true, at: 2000 })), true);
  assert.equal(r.recordSeeded(ev('message', { text: 'Opened a pull request.', seeded: true, at: 2000 })), true, 'another message');
  assert.equal(r.recordSeeded(ev('status', { status: 'working', task: 'Run tests', seeded: true, at: 2000 })), true);
  assert.equal(r.recordSeeded(ev('status', { status: 'waiting', task: 'Run tests', seeded: true, at: 2000 })), true, 'another status');
  assert.equal(r.recordSeeded(ev('status', { status: 'waiting', task: 'Push', seeded: true, at: 2000 })), true, 'another task');
  assert.equal(r.recordSeeded(ev('message', { text: 'Tests pass.', seeded: true, at: 2000 })), false, 'the same message again');
  assert.equal(r.st.history.length, 5);
  const f = historyRules(1000), far = Date.now() + 3600e3;
  assert.equal(f.recordSeeded(ev('status', { status: 'done', seeded: true, at: far })), true);
  assert.equal(f.recordSeeded(ev('status', { status: 'done', seeded: true, at: far })), false, 'a copy from the future is skipped too, though both are recorded at now');
  assert.equal(f.st.history.length, 1);
});

test('a seeded event from the future is recorded at now, and history keeps HMAX entries (#35)', () => {
  const r = historyRules(0);
  const before = Date.now();
  r.recordSeeded(ev('status', { seeded: true, at: before + 3600e3 }));
  assert.ok(r.st.history[0].t <= Date.now() && r.st.history[0].t >= before);
  for (let i = 1; i <= 6; i++) r.recordSeeded(ev('tool.call', { id: 'c' + i, seeded: true, at: i }));
  assert.equal(r.st.history.length, 5, 'HMAX');
  assert.equal(r.st.history[r.st.history.length - 1].ev.type, 'status', 'the newest entry stays');
});

test('applyEvent: seeded events skip record(), and apply with sound, toasts and notifications off (#35)', () => {
  const log = [];
  const run = new Function('record', 'recordSeeded', 'emit', 'log',
    'var rp=null,seeding=false,seedNews=false,newsEv=new WeakSet();' +
    'function applyEv0(ev){log.push([ev.type, seeding]);}' +
    source(' function applyEvent(') + source(' function applyEv(') +
    'return { applyEvent: applyEvent, seeding: function () { return seeding; } };'
  )((e) => log.push(['record', e.type]), (e) => log.push(['seeded', e.type]), () => {}, log);
  run.applyEvent(ev('status'));
  run.applyEvent(ev('request', { seeded: true }));
  assert.deepEqual(log, [['record', 'status'], ['status', false], ['seeded', 'request'], ['request', true]]);
  assert.equal(run.seeding(), false, 'the flag is off again after a seeded event');
});

test('sound, notify and every toast check the seeding flag (#35)', () => {
  assert.match(source(' function snd('), /!seeding/);
  assert.match(source(' function notify('), /\|\|seeding\|\|/);
  assert.equal((bundle.match(/&&!rp&&o\.onToast\)/g) || []).length, 0, 'no toast without the seeding check');
  assert.equal((bundle.match(/&&!rp&&!seeding&&o\.onToast\)/g) || []).length, 3);
});

test('dispose marks the building as seen and saves; while the page is hidden it keeps the time the page was hidden (#35)', () => {
  const src = source('dispose:function(){if(adapter&&adapter.dispose)adapter.dispose();', 's.dispose();}');
  const run = (visibilityState) => {
    const log = [], st = { lastSeen: 100 };
    const doc = { visibilityState, removeEventListener: () => log.push('off') };
    const o = new Function('adapter', 'document', 'window', 'onVis', 'onHide', 'st', 'seenNow', 'hsave', 's',
      'var rp={};return {' + src + '};'
    )({ dispose: () => log.push('adapter') }, doc, { removeEventListener: () => log.push('off') }, null, null, st,
      () => 5000, () => log.push('save:' + st.lastSeen), { dispose: () => log.push('stage') });
    o.dispose();
    return { st, log };
  };
  const shown = run('visible');
  assert.equal(shown.st.lastSeen, 5000, 'a shown page: the building is seen now');
  assert.deepEqual(shown.log, ['adapter', 'off', 'off', 'save:5000', 'stage']);
  const hidden = run('hidden');
  assert.equal(hidden.st.lastSeen, 100, 'a hidden page: events that came while it was hidden stay news');
  assert.deepEqual(hidden.log, ['adapter', 'off', 'off', 'save:100', 'stage']);
});

test('seen time is after every recorded event, also one in the same ms (#35)', () => {
  const seenNow = (history) => new Function('st', source(' function seenNow(', '}') + 'return seenNow;')({ history })();
  const now = Date.now();
  assert.ok(seenNow([]) >= now);
  assert.equal(seenNow([{ t: now + 5000 }]), now + 5001);
  assert.ok(seenNow([{ t: 10 }]) >= now);
});

// ---------- the saved history has a size cap (agent-office #30) ----------
// A localStorage stand-in with a quota in characters (keys and values), like the browser's.
function storage(quota, init = {}) {
  const m = new Map(Object.entries(init));
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    m, sets: 0,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      this.sets++;
      const old = m.get(k);
      m.set(k, String(v));
      if (used() > quota) { if (old === undefined) m.delete(k); else m.set(k, old); const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
    },
    removeItem: (k) => { m.delete(k); },
  };
}
function saver(store, { HBYTES = 4000, HTEXT = 40, history = [] } = {}) {
  const st = { history, lastSeen: 500 };
  return Object.assign(new Function('st', 'HKEY', 'HBYTES', 'HTEXT', 'window', 'hsz',
    'var saveT=null,lastSave=0;' + source(' function hslim(') + source(' function hfit(') + source(' function hevict(') + source(' function hsave(') +
    'return { hsave: hsave, hfit: hfit, hslim: hslim };'
  )(st, 'ao-history:Here', HBYTES, HTEXT, { localStorage: store }, new WeakMap()), { st });
}
const entries = (n, text = 'ok') => Array.from({ length: n }, (_, i) => ({ t: 1000 + i, ev: { type: 'message', bot: 'Ada', text: text + ' ' + i } }));

test('saved history: the newest entries that fit the size cap, in time order; long text is cut in the saved copy only', () => {
  const store = storage(1e9);
  const long = 'x'.repeat(500) + ' end';
  const h = entries(400);
  h[399].ev.text = long;
  h[399].ev.attachments = [{ name: 'a.png', url: 'data:image/png;base64,' + 'A'.repeat(900) }];
  const s = saver(store, { history: h });
  s.hsave();
  const raw = store.m.get('ao-history:Here');
  assert.ok(raw.length <= 4000 + 60, `${raw.length} characters saved`);
  const d = JSON.parse(raw);
  assert.equal(d.v, 1); assert.equal(d.lastSeen, 500);
  assert.ok(d.history.length > 10 && d.history.length < 400, `${d.history.length} entries kept`);
  assert.deepEqual(d.history.map((x) => x.t), h.slice(-d.history.length).map((x) => x.t), 'the newest ones, in order');
  const last = d.history.at(-1).ev;
  assert.equal(last.text.length, 40, 'a long text is cut');
  assert.ok(last.text.endsWith('…'));
  assert.equal(last.attachments[0].url, '', 'a long data URL is dropped, not cut');
  assert.equal(last.attachments[0].name, 'a.png');
  assert.equal(h[399].ev.text, long, 'the history in memory keeps the whole text (replay shows it until reload)');
  assert.equal(s.st.history.length, 400);
});

test('saved history: when the browser is full, the building seen longest ago goes first, then the oldest half', () => {
  const old = JSON.stringify({ v: 1, lastSeen: 10, history: entries(30) }), newer = JSON.stringify({ v: 1, lastSeen: 900, history: entries(30) });
  const store = storage(old.length + newer.length + 1500, { 'ao-history:Old': old, 'ao-history:Newer': newer, 'ao-view': 'office' });
  const s = saver(store, { HBYTES: 2500, history: entries(200) });
  s.hsave();
  assert.ok(store.m.has('ao-history:Here'), 'this building is saved');
  assert.ok(!store.m.has('ao-history:Old'), 'the building seen longest ago is gone');
  assert.ok(store.m.has('ao-history:Newer'), 'a building seen later stays');
  assert.equal(store.m.get('ao-view'), 'office', 'other keys stay');
  const kept = JSON.parse(store.m.get('ao-history:Here')).history.length;
  // no other building to remove: the oldest half of this one goes, until it fits
  const tight = storage(2200);
  const t = saver(tight, { HBYTES: 100000, history: entries(200) });
  t.hsave();
  const d = JSON.parse(tight.m.get('ao-history:Here'));
  assert.ok(d.history.length > 0 && d.history.length < 200, `${d.history.length} entries`);
  assert.equal(d.history.at(-1).t, 1199, 'the newest entry stays');
  assert.ok(kept > 0);
  // nothing fits at all: no throw, nothing saved, and it stops trying
  const none = storage(10);
  const n = saver(none, { history: entries(50) });
  assert.doesNotThrow(() => n.hsave());
  assert.ok(none.sets <= 8, `${none.sets} tries`);
});

test('a plan keeps its own copy of the steps, so plan.step does not change the recorded event (#50)', () => {
  assert.match(bundle, /st\.plans\[b\.name\]=\{goal:ev\.goal,steps:\(ev\.steps\|\|\[\]\)\.map\(function\(x\)\{return Object\.assign\(\{\},x\);\}\)\}/);
});

test('kit/schema.json has the events, commands and common fields of the bundle schema', () => {
  const at = bundle.indexOf('/*@schema*/') + '/*@schema*/'.length;
  const B = JSON.parse(bundle.slice(at, bundle.indexOf(';AO.schema=SCHEMA', at)));
  const K = JSON.parse(readFileSync(join(root, 'kit', 'schema.json'), 'utf8'));
  assert.equal(B.version, K.version);
  assert.deepEqual(B.events, K.events);
  assert.deepEqual(B.commands, K.commands);
  assert.deepEqual(B.common, K.common);
  assert.deepEqual(Object.keys(K.common.fields), ['seeded', 'at']);
});

// chat() and logLine() of mountOffice, on a plain store, with the seeding flags that applyEv sets.
function chatRules(seeding, news) {
  const st = { chats: {}, unread: {}, log: [], sel: null };
  const has = bundle.includes(' function logLine(');
  const f = new Function('st', 'hm', 'seeding', 'seedNews',
    source(' function chat(') + (has ? source(' function logLine(') : 'function logLine(){}') +
    'return { chat: chat, logLine: logLine };'
  )(st, () => '09:00', seeding, news);
  return Object.assign(f, { st });
}
const bot = (name = 'Ada') => ({ name });

test('a seeded message that is not news restores the chat, but raises no unread count (#61)', () => {
  const r = chatRules(true, false), b = bot();
  r.chat(b, { from: 'agent', text: 'Tests pass.' });
  assert.equal(r.st.chats.Ada.length, 1, 'the chat line is state: it is restored');
  assert.equal(r.st.unread.Ada || 0, 0);
});

test('a live message, and a seeded message that is news, raise the unread count (#61)', () => {
  const live = chatRules(false, false), news = chatRules(true, true), b = bot();
  live.chat(b, { from: 'agent', text: 'Tests pass.' });
  news.chat(b, { from: 'agent', text: 'Tests pass.' });
  assert.equal(live.st.unread.Ada, 1);
  assert.equal(news.st.unread.Ada, 1);
  live.chat(b, { from: 'user', text: 'Push it.' });
  assert.equal(live.st.unread.Ada, 1, 'a line from the user is not unread');
  live.st.sel = b;
  live.chat(b, { from: 'agent', text: 'Pushed.' });
  assert.equal(live.st.unread.Ada, 1, 'the open bot gets no unread count');
});

test('logLine: Activity skips a seeded event that is not news, and keeps 40 lines (#61)', () => {
  const quiet = chatRules(true, false), news = chatRules(true, true), live = chatRules(false, false);
  quiet.logLine('Ada', 'Said · Tests pass.');
  assert.deepEqual(quiet.st.log, []);
  news.logLine('Ada', 'Said · Tests pass.');
  assert.deepEqual(news.st.log, [{ time: '09:00', name: 'Ada', text: 'Said · Tests pass.' }]);
  for (let i = 0; i < 45; i++) live.logLine('Ada', 'Line ' + i);
  assert.equal(live.st.log.length, 40);
  assert.equal(live.st.log[0].text, 'Line 44', 'the newest line is first');
});

test('every Activity line of the office goes through logLine (#61)', () => {
  assert.equal((bundle.match(/st\.log\.unshift\(/g) || []).length, 1, 'one unshift, in logLine');
  assert.match(source(' function logLine('), /if\(seeding&&!seedNews\)return;st\.log\.unshift\(/);
});

test('applyEv: a seeded event is news only when recordSeeded recorded it; in a replay every event is news (#61)', () => {
  const seen = [];
  const run = new Function('record', 'recordSeeded', 'emit', 'seen',
    'var rp=null,seeding=false,seedNews=false,newsEv=new WeakSet();' +
    'function applyEv0(ev){seen.push([ev.text, seeding, seedNews]);}' +
    source(' function applyEvent(') + source(' function applyEv(') +
    'return { applyEvent: applyEvent, applyEv: applyEv, flags: function () { return [seeding, seedNews]; }, replay: function (on) { rp = on ? { buf: [] } : null; return rp; } };'
  )(() => {}, (e) => e.at > 1000, () => {}, seen);
  run.applyEvent(ev('message', { text: 'old', seeded: true, at: 900 }));
  run.applyEvent(ev('message', { text: 'new', seeded: true, at: 2000 }));
  run.applyEvent(ev('message', { text: 'live' }));
  const r = run.replay(true);
  run.applyEvent(ev('message', { text: 'buffered', seeded: true, at: 3000 }));
  run.applyEv(ev('message', { text: 'replayed', seeded: true, at: 500 }));   // runTo: a recorded event
  run.replay(false);
  r.buf.forEach((e) => run.applyEv(e));   // stopReplay: the events that came during the replay
  assert.deepEqual(seen, [['old', true, false], ['new', true, true], ['live', false, false], ['replayed', true, true], ['buffered', true, true]]);
  assert.deepEqual(run.flags(), [false, false], 'both flags are off again');
});

// summary() of mountOffice, on plain bots.
function summaryOf(bots, history = []) {
  return new Function('st', 'bots', 'seen0',
    'var byName=function(n){return bots.filter(function(b){return b.name===n;})[0];};' +
    source(' function evStatus(') + source(' function cut(') + source(' function summary(', 'return R;}\n') + 'return summary;'
  )({ history }, bots, 1000);
}

test('Since you left: Needs you and its lines come from one source, the bots with an open request (#62)', () => {
  const bots = [
    { name: 'Ada', status: 'waiting', task: 'Pick a branch', request: null },
    { name: 'Bo', status: 'waiting', task: 'Run npm test?', request: { id: 'r1', text: 'Run npm test?' } },
    { name: 'Cy', status: 'working', task: 'Build', request: null }
  ];
  const R = summaryOf(bots)(1000);
  assert.equal(R.waiting, 1, 'a waiting status alone is not a decision');
  assert.deepEqual(R.top.filter((t) => / waits for your decision: /.test(t)), ['Bo waits for your decision: Run npm test?']);
  const none = summaryOf([{ name: 'Ada', status: 'waiting', task: 'Pick a branch', request: null }])(1000);
  assert.equal(none.waiting, 0);
  assert.deepEqual(none.top, [], 'no line lists a bot that Needs you does not count');
});

test('OfficeScene shows the office summary in Since you left, with no second Needs you count (#62)', () => {
  assert.equal(bundle.includes('{waiting:waiting.length}'), false, 'no override of the summary count');
  assert.equal(bundle.includes('h(A.SinceYouLeft,{summary:a().summary(D.syl.since),'), true, 'the live summary, for the same since');
});

// fitD, freeInset and fr: framing between the HUD insets, on a camera that looks down -z.
function StageF() {}
new Function('T', 'Stage', ['fitD', 'freeInset']
  .filter((n) => bundle.includes('Stage.prototype.' + n + '=function'))
  .map((n) => source('Stage.prototype.' + n + '=function', '};\n')).join('')
)({ Vector3: V }, StageF);
function framed(cw, ch, inset, ext = [5, 2, 1]) {
  const s = Object.create(StageF.prototype);
  let got = null;
  Object.assign(s, {
    el: { clientWidth: cw, clientHeight: ch },
    cam: { matrixWorld: { cols: [new V(1, 0, 0), new V(0, 1, 0), new V(0, 0, 1)] }, updateMatrixWorld() {} },
    frame(c) { got = c; }
  });
  new Function('s', 'T', 'inset', source(' function fr(') + 'return fr;')(s, { Vector3: V }, inset)([0, 0, 0], true, ext);
  const D = s.fitD(ext), wpp = 2 * D / ch;
  return { center: cw / 2 - got[0] / wpp, D };   // the scene center on screen, in px from the left
}

test('a frame inset inside the view frames the scene between the insets, as before (#65)', () => {
  const f = framed(1360, 800, { left: 300, right: 200 });
  assert.ok(Math.abs(f.center - (300 + 1160) / 2) < 1e-6);
  assert.ok(Math.abs(f.D - Math.max(2, 5 / (860 / 800)) * 1.06) < 1e-9);
});

test('a frame inset wider than the view is clamped: the scene stays in the view, in the free area (#65)', () => {
  const f = framed(1000, 500, { left: 2000, right: 0 });
  assert.ok(f.center >= 0 && f.center <= 1000, 'the scene center is on screen, not at ' + f.center);
  assert.ok(Math.abs(f.center - (650 + 1000) / 2) < 1e-6, 'centered in the 35% that is left');
  assert.ok(Math.abs(f.D - 5 / 0.7 * 1.06) < 1e-9, 'fitted to 35% of the width');
  const both = framed(1000, 500, { left: 600, right: 600 });
  assert.ok(Math.abs(both.center - 500) < 1e-6, 'equal insets keep the center');
});

test('freeInset: no inset is null; negative sides count as 0; the free area keeps 35% of the width (#65)', () => {
  const s = Object.create(StageF.prototype);
  s.el = { clientWidth: 1000 };
  s.inset = null;
  assert.equal(s.freeInset(), null);
  s.inset = { left: -50, right: 100 };
  assert.deepEqual(s.freeInset(), { left: 0, right: 100 });
  s.inset = { left: 1300, right: 0 };
  assert.deepEqual(s.freeInset(), { left: 650, right: 0 });
  s.inset = { left: 300, right: 700 };
  const fi = s.freeInset();
  assert.ok(Math.abs(fi.left - 195) < 1e-9 && Math.abs(fi.right - 455) < 1e-9, 'both sides shrink in proportion');
});

test('floor.update and room.update rename in place: the floor and room stay, bots follow a new room id, no camera move', () => {
  const calls = [];
  const mk = new Function('TYPES', 'bld', 'st', 'calls',
    'function floorOf(id){return bld.floors.filter(function(f){return f.id===id;})[0];}' +
    'function norm(){bld.floors.forEach(function(f){f.rooms.forEach(function(r){r.bots.forEach(function(b){b.roomId=r.id;});});});}' +
    'function rebuildFloor(){calls.push("floor");}function rebuildBuilding(){calls.push("building");}function show(){calls.push("show");}function emit(){calls.push("emit");}' +
    'function frameFloor(){calls.push("FRAME");}function frameBuilding(){calls.push("FRAME");}' +
    source(' function updateFloor(') + source(' function updateRoom(') + 'return { updateFloor: updateFloor, updateRoom: updateRoom };');
  const bot = { name: 'a', roomId: 'spare-room' };
  const bld = { floors: [{ id: 1, key: 'ops', name: 'No sessions', rooms: [{ id: 'spare-room', type: 'lab', name: 'Empty room', bots: [bot] }, { id: 'other', type: 'lab', name: 'Other', bots: [] }] }] };
  const st = { room: 'spare-room' };
  const e = mk({ lab: {}, team: {} }, bld, st, calls);
  assert.equal(e.updateFloor(1, { name: 'main' }), 1);
  assert.equal(bld.floors[0].name, 'main');
  assert.equal(bld.floors[0].key, 'ops', 'the key stays unless it is given');
  assert.equal(e.updateRoom('spare-room', { id: 'repo-abc', name: 'repo' }), 'repo-abc');
  assert.deepEqual([bld.floors[0].rooms[0].id, bld.floors[0].rooms[0].name, bot.roomId, st.room], ['repo-abc', 'repo', 'repo-abc', 'repo-abc']);
  assert.equal(e.updateRoom('repo-abc', { id: 'other' }), 'repo-abc', 'an id another room has is refused; the room keeps its own');
  assert.equal(e.updateRoom('missing', { name: 'x' }), undefined);
  assert.equal(e.updateFloor(9, { name: 'x' }), undefined);
  assert.ok(!calls.includes('FRAME'), 'a rename never moves the camera');
});

// #64: the narrow floor strip (HUD left at 820 px and below) is one row that scrolls sideways. A row keeps the width
// of its name; it does not shrink (the name has min-width 0), so names do not draw on top of each other.
const dsCss = readFileSync(join(root, 'components', 'bundle.css'), 'utf8').replace(/\r\n/g, '\n');
test('narrow floor strip: a floor row does not shrink, so the names do not overlap (#64)', () => {
  const r = dsCss.match(/@container \(max-width:820px\)\{[^\n]*?\.ao-hud-left \.ao-floors \.ao-row\{([^}]*)\}/);
  assert.ok(r, 'the floor row rule of the 820 px container query');
  assert.match(r[1], /(^|;)flex:none(;|$)/);
  assert.match(r[1], /white-space:nowrap/);
});

test('floorScroll: the current floor is centered in a strip that scrolls; no scroll when all floors fit (#64)', () => {
  const floorScroll = new Function(source('function floorScroll(') + 'return floorScroll;')();
  assert.equal(floorScroll(300, 300, 100, 80), null, 'no overflow');
  assert.equal(floorScroll(1200, 300, 600, 100), 500, 'centered: 600 + 50 - 150');
  assert.equal(floorScroll(1200, 300, 20, 100), 0, 'never before the start');
  assert.equal(floorScroll(1200, 300, 1150, 50), 900, 'never past the end');
});

test('FloorList scrolls the current floor into view when the floor or the list changes (#64)', () => {
  const fl = source('function FloorList(p){var fl=floorRows(p.floors', '));}\n');
  assert.match(fl, /h\("div",\{className:"ao-floors",ref:box\}/);
  assert.match(fl, /R\.useEffect\(function\(\)\{function fit\(\)\{keepInView\(box\.current\);\}/);
  assert.match(fl, /\},\[p\.current,fl\.length\]\);/);
});

// The left menu above 820 px: the floor and room lists scroll inside a cap, the current row is scrolled into view, and Add floor / Add room stay outside the scrolling rows.
test('keepInView: the current row is centered down a capped list and along a strip; nothing moves when the list fits', () => {
  const keepInView = new Function('floorScroll', source('function keepInView(') + 'return keepInView;')(new Function(source('function floorScroll(') + 'return floorScroll;')());
  const list = (o) => {
    const row = { offsetWidth: 200, offsetHeight: 40, getBoundingClientRect: () => ({ left: o.rowLeft ?? 0, top: o.rowTop ?? 0 }) };
    return { scrollWidth: o.sw ?? 200, clientWidth: o.cw ?? 200, scrollHeight: o.sh ?? 150, clientHeight: o.ch ?? 150, scrollLeft: 0, scrollTop: o.st ?? 0,
      getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: (q) => (o.none ? null : (assert.equal(q, '[aria-current="true"]'), row)) };
  };
  const down = list({ sh: 800, ch: 150, rowTop: 500 });           // row 500 px down in a 150 px window
  keepInView(down);
  assert.equal(down.scrollTop, 445, 'centered: 500 + 20 - 75');
  assert.equal(down.scrollLeft, 0, 'no sideways move in a list that fits across');
  const along = list({ sw: 1200, cw: 300, rowLeft: 600 });
  keepInView(along);
  assert.equal(along.scrollLeft, 550, 'centered along the narrow strip: 600 + 100 - 150');
  assert.equal(along.scrollTop, 0);
  const fits = list({ sh: 150, ch: 150 });
  keepInView(fits);
  assert.equal(fits.scrollTop, 0);
  assert.doesNotThrow(() => keepInView(list({ none: true })), 'no current row: nothing to do');
  assert.doesNotThrow(() => keepInView(null));
});

test('the left menu lists: the cap above 820 px, the lists use keepInView, the Add rows are outside the scrolling rows', () => {
  assert.match(dsCss, /@container \(min-width:821px\)\{\.ao-hud-left \.ao-floors\{max-height:150px;overflow-y:auto;[^}]*\}\.ao-hud-left>\.ao-panel:nth-child\(2\) \.ao-floors\{max-height:96px\}\}/);
  const fl = source('function FloorList(p){var fl=', '));}\n');
  const rl = source('function RoomList(p){', '));}\n');
  for (const [name, src] of [['FloorList', fl], ['RoomList', rl]]) {
    assert.match(src, /R\.useEffect\(function\(\)\{function fit\(\)\{keepInView\(box\.current\);\}/, `${name} keeps its current row in view`);
    assert.match(src, /h\("div",\{className:"ao-floors",ref:box\}/, `${name} has the scrolling rows`);
  }
  assert.match(fl, /(\}\)\)|out\)),p\.onAdd&&h\("div",\{className:"ao-addrow"\}/, 'Add floor follows the scrolling rows, it is not inside them');
  assert.match(rl, /\}\)\),\n\s+p\.onAddRoom&&h\("div",\{className:"ao-addrow"\}/, 'Add room follows the scrolling rows, it is not inside them');
});

// #66: the page lays its own cards out around Since you left, so the scene says when the card shows and when it goes.
test('OfficeScene reports Since you left: true when the card shows, false when it closes or the scene goes (#66)', () => {
  assert.ok(bundle.includes('R.useEffect(function(){if(!D.syl)return;var cb=sylCb.current;if(cb)cb(true);return function(){var c=sylCb.current;if(c)c(false);};},[!!D.syl]);'));
  assert.ok(bundle.includes('sylCb=R.useRef(null);sylCb.current=p.onSinceYouLeft;'));
});

// ---- retire: a temporary subagent sits at its desk before it leaves by the elevator ----
function retireRig({ rm = false, view = 'floor', shown = true, exitMs = 0 } = {}) {
  let now = 0, id = 0;
  const timers = new Map(), left = [], removed = [];
  const s = { rm, dead: false }, st = { view, floor: 1 };
  const b = { name: 'sub', floor: shown ? 1 : 2, path: [new V(1, 0, 1)], pos: { x: 0, z: 0 } };
  const env = {
    s, st, DUR: { dwell: 1400 }, Date: { now: () => now },
    byName: (n) => (removed.includes(n) ? null : b),
    removeBot: (n) => removed.push(n),
    leaveByElevator: (bot, done) => { left.push(now); if (exitMs === 0) done(); else if (exitMs !== Infinity) env.setTimeout(done, exitMs); },
    setTimeout: (f, ms) => { timers.set(++id, { f, at: now + ms }); return id; },
  };
  const retire = new Function(...Object.keys(env), source('function retire(b)') + 'return retire;')(...Object.values(env));
  const advance = (ms) => { // run due timers in time order, 10 ms at a time
    for (const end = now + ms; now < end;) { now += 10; for (const [k, t] of [...timers]) if (t.at <= now) { timers.delete(k); t.f(); } }
  };
  const walk = (ms) => { for (let i = 0; i < ms / 1000; i++) { b.pos = { x: b.pos.x + 1, z: b.pos.z }; advance(1000); } }; // a bot that moves 1 unit a second
  return { b, st, retire, advance, walk, left, removed };
}

test('retire: a bot that still walks in is not sent out; it leaves after the dwell once it sits', () => {
  const r = retireRig();
  r.retire(r.b);
  r.advance(3000); // the old fixed timer (1400 ms) would have sent it out by now
  assert.equal(r.left.length, 0, 'still walking: no exit');
  r.b.path = []; // arrived at the seat
  r.advance(1300);
  assert.equal(r.left.length, 0, 'sits first');
  r.advance(300);
  assert.equal(r.left.length, 1, 'then leaves');
  assert.ok(r.left[0] - 3000 >= 1400, 'a full dwell after it arrived');
  assert.deepEqual(r.removed, ['sub']);
});

test('retire: a long walk in and a long walk out are never cut by a timer while the bot moves', () => {
  const r = retireRig({ exitMs: Infinity }); // far room: 40 s in, 40 s out
  r.retire(r.b);
  r.walk(40000);
  assert.equal(r.left.length, 0, 'still walking in after 40 s');
  r.b.path = [];
  r.advance(1500);
  assert.equal(r.left.length, 1, 'it starts the exit walk after the dwell');
  r.walk(40000);
  assert.equal(r.removed.length, 0, 'still walking to the elevator after 40 s');
});

test('retire: a bot that stops moving for 15 s is removed, on the way in or out', () => {
  const inn = retireRig({ exitMs: Infinity });
  inn.retire(inn.b);
  inn.walk(5000);
  inn.advance(13800); // the last move was seen about 1 s before the walk call ended
  assert.equal(inn.removed.length, 0);
  inn.advance(1500);
  assert.deepEqual(inn.removed, ['sub'], 'stuck on the way in');
  const out = retireRig({ exitMs: Infinity });
  out.retire(out.b);
  out.b.path = [];
  out.advance(1600);
  assert.equal(out.left.length, 1);
  out.advance(15200);
  assert.deepEqual(out.removed, ['sub'], 'stuck on the way out');
});

test('retire: a hard cap of 120 s removes a bot that keeps moving but never finishes', () => {
  const r = retireRig({ exitMs: Infinity });
  r.retire(r.b);
  r.walk(119000);
  assert.equal(r.removed.length, 0);
  r.walk(2000);
  assert.deepEqual(r.removed, ['sub']);
});

test('retire: a bot that is walking out is removed at once when its floor goes off screen', () => {
  for (const off of [(st) => { st.view = 'building'; }, (st) => { st.floor = 2; }]) {
    const r = retireRig({ exitMs: Infinity });
    r.retire(r.b);
    r.b.path = [];
    r.advance(1600);
    assert.equal(r.left.length, 1, 'on the exit walk');
    r.walk(2000);
    assert.equal(r.removed.length, 0, 'still shown: it keeps walking');
    off(r.st);
    r.advance(200); // not the 15 s stall
    assert.deepEqual(r.removed, ['sub']);
  }
});

test('retire: reduced motion and a floor that is not on screen do not wait for the walk', () => {
  for (const opt of [{ rm: true }, { shown: false }, { view: 'building' }]) {
    const r = retireRig(opt);
    r.retire(r.b); // path is still set: nothing walks it here
    r.advance(1500);
    assert.equal(r.left.length, 1, JSON.stringify(opt));
    assert.deepEqual(r.removed, ['sub']);
  }
});

// #84: GPU memory. Stage.dispose frees what the stage holds on the GPU (scene, cleared groups, Kit caches, shadows, post
// effects), then the renderer and its WebGL context. Stage.clear takes a group out at once and frees it after the next
// frame. Kit.refresh frees the textures it drops. Nothing that the scene, the Kit or another live stage still uses is
// freed. The rules run on plain stand-ins that count their dispose calls.
let spent, order;   // resource -> number of dispose calls; every call in order
const gpuRes = (kind, o = {}) => { const r = Object.assign({ kind }, o); r.dispose = () => { spent.set(r, (spent.get(r) || 0) + 1); order.push(r.n || kind); }; return r; };
const G = (n) => gpuRes('geo', { n }), X = (n) => gpuRes('tex', { n, isTexture: true }), M = (n, o) => gpuRes('mat', Object.assign({ n }, o));
class Node3 {
  constructor(o) { Object.assign(this, o); this.children = []; this.parent = null; }
  add(...c) { for (const x of c) { if (x.parent) x.parent.remove(x); x.parent = this; this.children.push(x); } return this; }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parent = null; } return this; }
  traverse(fn) { fn(this); for (const c of this.children.slice()) c.traverse(fn); }
}
const mesh3 = (geometry, material) => new Node3({ geometry, material });
function gpuKit() {
  spent = new Map(); order = [];
  const at = bundle.indexOf('/* ---------- GPU memory ---------- */'), end = bundle.indexOf('/* ---------- stage ---------- */');
  assert.ok(at >= 0 && end > at, 'bundle has the GPU memory block before the stage');
  function Stage() {}
  function Kit() {}
  const lib = new Function('Stage', 'Kit', 'cancelAnimationFrame', 'readFonts', 'readTokens',
    bundle.slice(at, end) +
    source('Stage.prototype.clear=function', '};\n') + source('Stage.prototype.gc=function', '};\n') + source('Stage.prototype.dispose=function', '};\n') +
    source('Kit.prototype.prune=function', '};\n') + source('Kit.prototype.refresh=function', '};\n') +
    'return { LIVE: LIVE };'
  )(Stage, Kit, () => {}, () => ({ sans: 'sans' }), () => ({ bg: '#fff' }));
  // a stage as the constructor leaves it: in LIVE, with a renderer, a Kit and observers
  lib.stage = (scene) => {
    const s = Object.create(Stage.prototype);
    const r = { dispose() { order.push('renderer.dispose'); }, forceContextLoss() { order.push('forceContextLoss'); }, domElement: { remove() { order.push('canvas.remove'); } } };
    Object.assign(s, { scene, r, raf: 1, lamps: [], anim: [], K: { tex: {}, mats: {}, themed: [], screens: [] }, mo: { disconnect() {} }, ro: { disconnect() {} }, ctl: { dispose() {} } });
    lib.LIVE.push(s);
    return s;
  };
  return Object.assign(lib, { Stage, Kit });
}

test('Stage.dispose frees each geometry, material and texture of the scene and the Kit caches once, then the WebGL context (#84)', () => {
  const lib = gpuKit();
  const g1 = G('g1'), g2 = G('sprite'), g3 = G('g3');
  const t1 = X('t1'), t2 = X('t2'), t3 = X('t3'), t4 = X('bubble'), t5 = X('t5'), t6 = X('t6'), t7 = X('blob');
  const m1 = M('m1', { map: t1, emissiveMap: t1 }), m2 = M('m2', { normalMap: t2 }), m3 = M('m3', { uniforms: { tDiffuse: { value: t3 }, k: { value: 1 } } });
  const m4 = M('m4', { map: t4 }), m5 = M('m5', { alphaMap: t5, envMap: t6 }), m6 = M('m6', { map: null });
  const shadow = gpuRes('shadow', { n: 'shadow' });
  const scene = new Node3({ isScene: true });
  const floor = new Node3({});
  floor.add(mesh3(g3, m5));
  scene.add(mesh3(g1, m1), mesh3(g1, [m2, m3]), mesh3(g2, m4), new Node3({ isLight: true, shadow }), floor);
  const s = lib.stage(scene);
  Object.assign(s.K, { tex: { bubble: t4, blob: t7 }, mats: { k: m6 } });
  const passes = ['render', 'bloom', 'grade'].map((n) => gpuRes('pass', { n }));
  s.comp = gpuRes('composer', { n: 'composer', passes });
  s.dispose();
  const all = [g1, g2, g3, t1, t2, t3, t4, t5, t6, t7, m1, m2, m3, m4, m5, m6, shadow, ...passes, s.comp];
  for (const r of all) assert.equal(spent.get(r), 1, r.n + ' disposed once');
  assert.equal(spent.size, all.length, 'nothing else');
  assert.deepEqual(order.slice(-3), ['renderer.dispose', 'forceContextLoss', 'canvas.remove'], 'the renderer and the context go last');
  assert.equal(lib.LIVE.includes(s), false, 'out of the live stages');
  assert.equal(s.dead, true);
  assert.deepEqual([s.K.tex, s.K.mats], [{}, {}], 'the Kit caches are empty');
  const n = order.length;
  s.dispose();
  assert.equal(order.length, n, 'a second dispose frees nothing and keeps the renderer calls at one');
  for (const r of all) assert.equal(spent.get(r), 1);
});

test('Stage.dispose keeps what another live stage draws or caches; that stage frees it later (#84)', () => {
  const lib = gpuKit();
  const gS = G('gS'), tS = X('tS'), mS = M('mS', { map: tS }), tK = X('tK'), gA = G('gA'), tA = X('tA'), mA = M('mA', { map: tA, emissiveMap: tS }), mB = M('mB', { map: tK });
  const sa = new Node3({ isScene: true }), sb = new Node3({ isScene: true });
  sa.add(mesh3(gS, mS), mesh3(gA, mA), mesh3(gA, M('mK', { map: tK })));
  sb.add(mesh3(gS, mS), mesh3(G('gB'), mB));
  const a = lib.stage(sa), b = lib.stage(sb);
  b.K.tex.cached = tK;   // in B's Kit cache, drawn by A too
  a.dispose();
  for (const r of [gS, tS, mS, tK, mB]) assert.equal(spent.get(r), undefined, r.n + ' is kept: stage B still uses it');
  for (const r of [gA, tA, mA]) assert.equal(spent.get(r), 1, r.n + ' is freed');
  b.dispose();
  for (const r of [gS, tS, mS, tK, mB]) assert.equal(spent.get(r), 1, r.n + ' is freed with the last stage');
  assert.equal(lib.LIVE.length, 0);
});

test('Stage.clear takes the group out at once and frees it after the next frame, except what the scene or the Kit still uses (#84)', () => {
  const lib = gpuKit();
  const scene = new Node3({ isScene: true }), F = new Node3({});
  const gF = G('gF'), tF = X('tF'), mF = M('mF', { map: tF }), gK = G('gK'), mK = M('mK'), gSp = G('sprite'), tBub = X('bubble'), mBub = M('mBub', { map: tBub });
  const tR = X('tR'), mR = M('mR', { map: tR }), gR = G('gR');
  const lamp = new Node3({ isLight: true, shadow: gpuRes('shadow', { n: 'lampShadow' }) }), screen = mesh3(G('gScr'), M('mScr'));
  F.add(mesh3(gF, mF), mesh3(gK, mK), mesh3(gSp, mBub), mesh3(gR, mR), lamp, screen);
  scene.add(F, mesh3(gSp, M('otherSprite')));
  const s = lib.stage(scene);
  Object.assign(s.K, { tex: { bubble: tBub }, mats: { k: mK }, screens: [[screen, 'coder']] });
  s.lamps = [lamp];
  s.clear(F);
  assert.equal(F.parent, null, 'out of the scene at once');
  assert.deepEqual(s.lamps, [], 'its lamps are gone');
  assert.deepEqual(s.K.screens, [], 'its screens are gone');
  assert.equal(spent.size, 0, 'nothing is freed before the next frame');
  scene.add(mesh3(G('gNew'), mR));   // the page builds again with a material it keeps (a rebuilt floor, new streets)
  s.gc();
  for (const r of [gF, tF, mF, gK, gR, lamp.shadow, screen.geometry, screen.material]) assert.equal(spent.get(r), 1, r.n + ' freed once');
  for (const r of [mK, tBub, gSp, mR, tR]) assert.equal(spent.get(r), undefined, r.n + ' kept: the Kit or the scene still uses it');
  const n = order.length;
  s.gc();
  assert.equal(order.length, n, 'a second gc frees nothing');
});

test('Stage.dispose frees a cleared group that the next frame did not free; clear after dispose frees at once (#84)', () => {
  const lib = gpuKit();
  const scene = new Node3({ isScene: true }), F = new Node3({}), L = new Node3({});
  const gF = G('gF'), mF = M('mF', { map: X('tF') }), gL = G('gL'), mL = M('mL');
  F.add(mesh3(gF, mF)); L.add(mesh3(gL, mL));
  scene.add(F, L);
  const s = lib.stage(scene);
  s.clear(F);
  s.dispose();
  for (const r of [gF, mF, mF.map, gL, mL]) assert.equal(spent.get(r), 1, r.n + ' freed once');
  const late = new Node3({}), gLate = G('gLate');
  late.add(mesh3(gLate, M('mLate')));
  s.clear(late);   // page code that cleans up after the stage is gone
  assert.equal(spent.get(gLate), 1);
});

test('the stage registers as live once it has a renderer, and its loop frees cleared groups after each frame (#84)', () => {
  const ctor = source('function Stage(el,o){', 'requestAnimationFrame(loop);};loop();}\n');
  const made = ctor.indexOf('s.r=new T.WebGLRenderer'), live = ctor.indexOf('LIVE.push(s);');
  assert.ok(made > 0 && live > made, 'LIVE.push after the renderer is made');
  assert.ok(ctor.indexOf('return;}', made) < live, 'a stage without WebGL is not live');
  assert.match(ctor, /s\.draw\(\);if\(s\.junk&&s\.junk\.length\)s\.gc\(\);s\.raf=requestAnimationFrame\(loop\);/);
});

test('a finished handoff arc goes through stage.clear, and a speech bubble frees its material with its texture (#84)', () => {
  // the arc line, its dot and the floor label (a canvas texture each) went out of the scene, but only the line geometry was freed
  assert.match(bundle, /if\(x\.t>=1\)\{s\.clear\(x\.ln\);s\.clear\(x\.dot\);if\(x\.lb\)s\.clear\(x\.lb\);arcs\.splice\(i,1\);\}/);
  assert.equal((bundle.match(/b\.say\.sp\.material\.map\.dispose\(\);/g) || []).length, 2, 'two places end a speech bubble');
  assert.equal((bundle.match(/b\.say\.sp\.material\.map\.dispose\(\);b\.say\.sp\.material\.dispose\(\);/g) || []).length, 2);
});

test('Kit.refresh frees the textures it drops from K.tex, once; screens get the new ones (#84)', () => {
  const lib = gpuKit();
  const K = Object.create(lib.Kit.prototype);
  const oldScr = X('scr-coder'), blob = X('blob');
  let made = 0;
  K.screenTex = function (role) { return this.tex['scr-' + role] || (this.tex['scr-' + role] = X('new-' + (++made))); };
  const scene = new Node3({ isScene: true }), scr = mesh3(G('gScr'), { map: oldScr, emissiveMap: oldScr, needsUpdate: false });
  scene.add(scr);
  const recolored = [], themedMat = { color: { set: (c) => recolored.push(c) } };
  Object.assign(K, { el: null, tex: { 'scr-coder': oldScr, blob }, themed: [[new WeakRef(themedMat), 'bg']], screens: [[scr, 'coder']] });
  K.refresh();
  assert.equal(spent.get(oldScr), 1);
  assert.equal(spent.get(blob), 1);
  assert.equal(scr.material.map, K.tex['scr-coder']);
  assert.notEqual(scr.material.map, oldScr);
  assert.equal(scr.material.emissiveMap, scr.material.map);
  assert.deepEqual(recolored, ['#fff'], 'themed materials still take the new tokens');
  const first = K.tex['scr-coder'];
  K.refresh();
  assert.equal(spent.get(oldScr), 1, 'an old texture is freed once');
  assert.equal(spent.get(first), 1, 'the texture of the last refresh is freed by the next one');
  assert.equal(spent.get(K.tex['scr-coder']), undefined, 'the shown one is kept');
});

// #99: K.themed holds a WeakRef to each themed material, so a material that nothing uses any more drops out. Kit.refresh
// recolors the live ones and drops the dead ones; Kit.t prunes when the list has doubled since the last prune. Page code
// that keeps a material (the City's one-material-per-token cache) keeps it in the list. The rules run on the real Kit
// code with a fake material. A fake WeakRef gives exact counts; a real GC (the v8 flag is set at run time, so plain
// `npm test` needs no --expose-gc) checks the heap rule.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const settle = async () => { for (let i = 0; i < 2; i++) { await new Promise((r) => setTimeout(r, 0)); gc(); } };
// a WeakRef that the test can kill at once
const killable = () => {
  const dead = new Set();
  return { dead, Ref: class { constructor(t) { this.t = t; } deref() { return dead.has(this.t) ? undefined : this.t; } } };
};
// the real Kit constructor, t, prune and refresh on a fake material; `tokens` is what readTokens returns on every call
function themedKit(tokens, WR = WeakRef) {
  class Mat { constructor(o) { Object.assign(this, o); const c = this.color; this.color = { v: c, set(x) { this.v = x; } }; } }
  const Kit = new Function('T', 'readFonts', 'readTokens', 'WeakRef', 'AO',
    source('function Kit(el)', '}\n') + source('Kit.prototype.t=function', '};\n') + source('Kit.prototype.prune=function', '};\n') +
    source('Kit.prototype.refresh=function', '};\n') + 'return Kit;'
  )({ MeshStandardMaterial: Mat }, () => ({}), () => tokens, WR, { MODES: modes() });
  const K = new Kit(null);
  Object.assign(K, { tex: {}, screens: [] });
  return K;
}

test('Kit.t returns a distinct themed material on every call and lists it by weak reference (#99)', () => {
  const K = themedKit({ bg: '#111' });
  const a = K.t('bg'), b = K.t('bg', { roughness: 0.2 });
  assert.notEqual(a, b, 'two callers never share one material');
  assert.equal(a.color.v, '#111');
  a.emissive = 'x';
  assert.equal(b.emissive, undefined, 'a change to one material does not reach another');
  assert.equal(K.themed.length, 2);
  assert.equal(K.themed[0][0].deref(), a);
  assert.equal(K.themed[0][1], 'bg');
});

test('Kit.refresh recolors the materials that are alive and drops the dead entries (#99)', () => {
  const tok = { bg: '#111' }, { dead, Ref } = killable();
  const K = themedKit(tok, Ref);
  const kept = [K.t('bg'), K.t('bg')], gone = [K.t('bg'), K.t('bg'), K.t('bg')];
  gone.forEach((m) => dead.add(m));
  tok.bg = '#eee';
  K.refresh();
  assert.deepEqual(kept.map((m) => m.color.v), ['#eee', '#eee'], 'a material in use takes the new tokens');
  assert.deepEqual(gone.map((m) => m.color.v), ['#111', '#111', '#111'], 'a dead material is not visited');
  assert.equal(K.themed.length, 2, 'the dead entries are gone');
});

test('Kit.t prunes dead entries when the list has doubled since the last prune (#99)', () => {
  const { dead, Ref } = killable();
  const K = themedKit({ bg: '#111' }, Ref);
  let floor = [], peak = 0;
  for (let n = 0; n < 30; n++) {
    floor.forEach((m) => dead.add(m));            // the old floor leaves the scene
    floor = [];
    for (let i = 0; i < 100; i++) floor.push(K.t('bg'));
    peak = Math.max(peak, K.themed.length);
  }
  assert.ok(peak < 500, `the list stays near twice the live size, not 3000 (peak ${peak})`);
});

test('Kit.themed stops growing across floor rebuilds and theme changes under a real GC (#99)', async () => {
  const K = themedKit({ bg: '#111' });
  let scene = [];
  for (let n = 0; n < 30; n++) {
    scene = [];                                   // the old floor leaves the scene
    for (let i = 0; i < 100; i++) scene.push(K.t('bg'));
    await settle();
    K.refresh();                                  // a theme change
  }
  assert.ok(K.themed.length < 150, `about one floor of materials is listed (${K.themed.length}), not 3000`);
  assert.ok(scene.every((m) => m.color.v === '#111'), 'the floor in the scene is still themed');
});

test('Kit.t alone keeps K.themed bounded when no theme change comes (#99)', async () => {
  const K = themedKit({ bg: '#111' });
  let scene = [], peak = 0;
  for (let n = 0; n < 30; n++) {
    scene = [];
    for (let i = 0; i < 100; i++) scene.push(K.t('bg'));
    await settle();
    peak = Math.max(peak, K.themed.length);
  }
  assert.ok(peak < 600, `the list is pruned while it is built (peak ${peak})`);
  assert.equal(scene.length, 100);
});

test('a material that page code caches, out of the scene for a while, takes the current theme (#99, the city.js mat() pattern)', async () => {
  const tok = { 'scene-slab': '#aaa' };
  const K = themedKit(tok);
  const mats = {};
  const mat = (token, o) => { const k = token + (o ? JSON.stringify(o) : ''); return mats[k] || (mats[k] = K.t(token, o)); };
  let scene = [mat('scene-slab')];                // used once ...
  const ground = scene[0];
  scene = [];                                     // ... then stage.clear: only the page cache holds it
  for (let i = 0; i < 50; i++) { K.t('scene-slab'); await settle(); K.refresh(); }
  tok['scene-slab'] = '#222';                     // Night
  K.refresh();
  assert.equal(ground.color.v, '#222', 'the cached material follows the theme');
  scene = [mat('scene-slab')];                    // used again after stage.clear
  assert.equal(scene[0], ground, 'the cache returns the same material');
  assert.equal(scene[0].color.v, '#222');
});

test('Stage.dispose still releases K.themed (#99)', () => {
  const lib = gpuKit();
  const s = lib.stage(new Node3({ isScene: true }));
  s.K.themed = [[new WeakRef({}), 'bg']];
  s.dispose();
  assert.deepEqual(s.K.themed, []);
});

// ----- Themes: one list, AO.MODES, drives the engine, the mode controls and the palette. The parts of each skin are checked in
// test/skin.test.mjs, the same checks for every skin; the tests here check the engine's machinery and name no skin (#131). -----
const tokensJson = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8'));
const tokensCss = readFileSync(join(root, 'tokens.css'), 'utf8').replace(/\r\n/g, '\n');
const rootVals = (() => {
  const at = tokensCss.indexOf(':root, [data-theme="light"] {'), text = tokensCss.slice(at, tokensCss.indexOf('\n}', at)), o = {};
  for (const m of text.matchAll(/\n\s*--([a-z0-9-]+): ([^;]+);/g)) o[m[1]] = m[2];
  return o;
})();
function modes() { const AO = {}; new Function('AO', source('AO.MODES=[', '];\n'))(AO); return AO.MODES; }

test('readScene reads the light-<look>-* and fx-*-<look> tokens of every look of AO.MODES into LOOKS and FX', () => {
  const run = new Function('AO', 'getComputedStyle', 'document',
    'var DEPTH,PITCH,GAP,FLOOR_H,DUR={},HANDOFF={},WALK={},NAV={},LOOKS;' + source('var FX={', '};\n') + source('function num(cs,n,f){', '}\n') +
    source('LOOKS={day:', '};\n') + source('function readScene(el){', '}\n') + 'readScene();return {FX:FX,LOOKS:LOOKS};');
  // every token reads as 1.5, so a value that is not 1.5 was not read
  const { FX, LOOKS } = run({ MODES: modes() }, () => ({ getPropertyValue: (n) => (/^--(light|fx)-/.test(n) ? '1.5' : '') }), { documentElement: {} });
  for (const { id } of modes()) {
    for (const k of ['hi', 'si', 'lamp']) assert.equal(LOOKS[id][k], 1.5, `LOOKS.${id}.${k} from light-${id}-*`);
    for (const k of ['bloom', 'thr', 'exp', 'fog', 'vig']) assert.equal(FX[k][id], 1.5, `FX.${k}.${id} from fx-*-${id}`);
  }
});

// #131: no theme takes the scene look of another. A Stage starts only when every look of AO.MODES has its LOOKS entry and its FX
// values; the error names the theme and the part. Only a value that is no theme (an unknown data-theme or mode) shows the first look.
test('a theme of AO.MODES with no LOOKS entry or FX value stops the Stage with an error that names it, and no look borrows another', () => {
  const gapOf = (MODES, LOOKS, FX) => new Function('AO', 'LOOKS', 'FX', source('function lookGap(){') + 'return lookGap();')({ MODES }, LOOKS, FX);
  const M = modes(), look = {}, fx = () => Object.fromEntries(M.map((m) => [m.id, 1]));
  const LOOKS = Object.fromEntries(M.map((m) => [m.id, look])), FX = { bloom: fx(), thr: fx(), exp: fx(), fog: fx(), vig: fx() };
  assert.equal(gapOf(M, LOOKS, FX), '', 'every theme complete: no gap');
  const last = M[M.length - 1];
  const noLook = { ...LOOKS }; delete noLook[last.id];
  assert.match(gapOf(M, noLook, FX), new RegExp(`the theme "${last.theme}" has no scene look\\. Add AgentOffice\\.office\\.LOOKS\\["${last.id}"\\]`));
  const noFog = { ...FX, fog: { ...FX.fog } }; delete noFog.fog[last.id];
  assert.match(gapOf(M, LOOKS, noFog), new RegExp(`the theme "${last.theme}" has no FX\\.fog value`));
  assert.match(source('function Stage(el,o){', 'var s=this;'), /var gap=lookGap\(\);if\(gap\)throw new Error\(gap\);/, 'the Stage checks first');
  assert.equal(source('function lookOf(K){'), 'function lookOf(K){return LOOKS[K.look];}\n', 'lookOf has no fallback look');
  assert.match(source('Stage.prototype.applyMode=function', '\n'), /var lk=this\.look\(\),L=LOOKS\[lk\],K=this\.K,/, 'applyMode has no fallback look');
});

test('theme to look and back: Stage.look and setMode follow AO.MODES; a value that is no theme shows the first look', () => {
  function Stage() {}
  let theme = null;
  const M = modes();
  const { map, dark } = new Function('AO', 'Stage', 'themeOf', source('var THEME_OF={},LOOK_OF={},DARK={};', '\n') + source('Stage.prototype.look=function', '};\n') +
    source('Stage.prototype.setMode=function', '};\n') + 'return {map:THEME_OF,dark:DARK};')({ MODES: M }, Stage, () => theme);
  assert.deepEqual(map, Object.fromEntries(M.map((m) => [m.id, m.theme])));
  assert.deepEqual(dark, Object.fromEntries(M.map((m) => [m.id, m.dark])));
  const s = Object.assign(Object.create(Stage.prototype), { mode: 'auto', K: { refresh() {} }, applyMode() {}, retheme() {} });
  for (const m of M) { theme = m.theme; assert.equal(s.look(), m.id, `theme ${m.theme}`); }
  for (const t of ['nope', null]) { theme = t; assert.equal(s.look(), M[0].id, `theme ${t}: the first look`); }
  const attrs = {}, last = M[M.length - 1];
  s.root = { setAttribute(k, v) { attrs[k] = v; } };
  s.setMode(last.id);
  assert.equal(attrs['data-theme'], last.theme);
  assert.equal(s.mode, 'auto', 'with a root the theme attribute decides the look');
  s.root = null; s.setMode(last.id);
  assert.equal(s.look(), last.id, 'without a root the mode is the look');
  theme = M[1].theme; s.setMode('nope');
  assert.equal(s.look(), M[1].id, 'a mode that is no look: the theme decides');
  assert.match(bundle, /var THEME_BY_LOOK=THEME_OF;/);
});

test('the mode controls and the palette list every theme from AO.MODES, then Tour', () => {
  const AO = { MODES: modes() };
  const opts = new Function('AO', source('var MODE_OPTS=', '\n') + 'return MODE_OPTS;')(AO);
  assert.deepEqual(opts.map((o) => o.id), AO.MODES.map((m) => m.id).concat('tour'));
  assert.match(bundle, /function ModeToggle\(p\)\{var opts=p\.options\|\|AO\.MODES\.concat\(\[\{id:"tour",label:"Tour",icon:"tour"\}\]\);/);
  const CP = {}, set = [];
  new Function('AO', 'CommandPalette', source('CommandPalette.actions=function(x){', '};\n'))(AO, CP);
  const acts = CP.actions({ setMode: (m) => set.push(m), setView() {}, setSound() {} }).filter((a) => a.group === 'Theme');
  assert.deepEqual(acts.map((a) => [a.id, a.label, a.icon]), AO.MODES.map((m) => ['mode-' + m.id, m.label, m.icon]));
  acts.forEach((a) => a.run());
  assert.deepEqual(set, AO.MODES.map((m) => m.id));
  assert.equal(CP.actions({}).length, 0, 'no handlers, no actions');
});

test('the page reads the theme list from the DS and keeps no copy (office.js City toggle, city.js)', () => {
  const office = readFileSync(join(root, 'public', 'office.js'), 'utf8'), city = readFileSync(join(root, 'public', 'city.js'), 'utf8');
  assert.match(office, /var CITY_MODES = A\.MODES;/);
  assert.match(office, /if \(CITY_MODES\[i\]\.theme === t\) return CITY_MODES\[i\]\.id;/);
  assert.match(city, /\(A\.MODES \|\| \[\]\)\.filter\(function \(x\) \{ return x\.id === m; \}\)\[0\]/);
});

test('the vendored fonts hold no system face (Segoe, Cascadia, Consolas): a theme that uses system faces loads no font file', () => {
  const fonts = readFileSync(join(root, 'public', 'vendor', 'fonts', 'fonts.css'), 'utf8');
  for (const f of ['Segoe', 'Cascadia', 'Consolas']) assert.ok(!fonts.includes(f), `fonts.css has no ${f} face`);
  // the structure swatch of ColorRatio needs no theme list: floor-ops, and a family rule may change it
  const css = readFileSync(join(root, 'components', 'bundle.css'), 'utf8');
  assert.match(css, /\.ao-ratio-30\{flex:30;background:var\(--floor-ops\);color:var\(--on-floor\)\}/);
});

test('the browser draws scrollbars and check boxes in the scheme of the theme: tokens.css sets it in each theme block, no style rule names a theme for it', () => {
  // the theme blocks of tokens.css set color-scheme (test/skin.test.mjs checks it against the dark flag of each skin); color-scheme
  // is inherited, so no control needs a rule of its own and no rule lists the dark themes
  for (const f of [['components', 'bundle.css'], ['public', 'office.css']]) {
    const text = readFileSync(join(root, ...f), 'utf8');
    assert.ok(!/\[data-theme[^\]]*\][^{}]*\{[^}]*color-scheme/.test(text), `${f[1]}: no theme rule sets color-scheme`);
  }
  assert.ok(!/\.ao-[a-z-]+[^{}]*\{color-scheme:dark\}/.test(readFileSync(join(root, 'components', 'bundle.css'), 'utf8')), 'no control rule of its own');
  // the notes editor is a light face in every theme, so its scrollbar stays light
  assert.match(readFileSync(join(root, 'public', 'office.css'), 'utf8'), /\.notes-text \{[^}]*background: var\(--bubble\);[^}]*color-scheme: light; \}/);
});

test('the scene reads flags, not look names: K.dark from AO.MODES, K.caps and K.term from LOOKS; the window, the screens, the signs and the page read them', () => {
  assert.match(source('Stage.prototype.applyMode=function', '\n'), /K=this\.K,prev=K\.look;K\.dark=!!DARK\[lk\];K\.caps=!!L\.caps;K\.term=!!L\.term;K\.look=lk;/);
  assert.match(bundle, /function Kit\(el\)\{[^\n]*this\.dark=false;this\.caps=false;this\.term=false;/);
  assert.ok(!/K\.night\b|this\.night\b|prototype\.night\b|isNight/.test(bundle), 'no night flag: a dark scene is K.dark');
  const win = source('Parts.window=function', '};\n');
  assert.match(win, /var L=lookOf\(K\),paint=WINDOWS\[L\.win\]/, 'the look picks its window picture');
  assert.match(win, /c\.fillStyle=L\.frame;/, 'and its frame color');
  assert.match(win, /emissiveIntensity:K\.dark\?\.95:\.7/);
  assert.match(bundle, /emissiveIntensity=\(b\.status==="resting"\?\.15:\.9\)\*\(K\.dark\?1\.3:1\)/, 'the monitor glow');
  assert.match(source('Kit.prototype.screenTex=function', '\n'), /var sub=this\.term,/);
  assert.match(source('Parts.sign=function', '\n'), /var sl=K\.caps;/);
  const term = readFileSync(join(root, 'public', 'terminal.js'), 'utf8'), board = readFileSync(join(root, 'public', 'board.js'), 'utf8'), sec = readFileSync(join(root, 'public', 'security.js'), 'utf8');
  assert.match(term, /glow: K\.dark \? 7 : sub \? 5 : 0/);
  assert.match(term, /dark = !!K\.dark, sub = !!K\.term;/);
  assert.match(sec, /sl = !!K\.caps;/);
  assert.match(board, /paint\(bd\.canvas\.getContext\('2d'\), bd\.canvas\.width, bd\.canvas\.height, d, K\.tok, K\.f \|\| \{\}, !!K\.dark\);/);
});

test('OfficeTypeCard draws its picture from the tokens of the theme it sits in, in the dark and retro style of its AO.MODES entry', () => {
  const h = (tag, props, ...kids) => ({ tag, props, kids });
  const M = modes(), calls = [];
  let state = '';
  const R = { useRef: () => ({ current: {} }), useState: () => [state, (v) => { state = v; }], useLayoutEffect: (fn) => fn() };
  const AO = { MODES: M, modeOf: (t) => M.find((m) => m.theme === t) || M[0], officePicture: (type, tok, style) => { calls.push([type, tok('scene-floor'), style]); return 'PIC'; } };
  const card = new Function('AO', 'h', 'useTheme', 'OfficeTypeBadge', 'R', 'getComputedStyle', source('function OfficeTypeCard(p){') + 'return OfficeTypeCard;')(AO, h, (p) => p.theme, function () {}, R,
    () => ({ getPropertyValue: (n) => 'v' + n }));
  for (const m of M) {
    card({ type: 'lab', theme: m.theme });
    assert.deepEqual(calls.at(-1), ['lab', 'v--scene-floor', { dark: m.dark, retro: m.retro }], `${m.label}: tokens of the card, style of the entry`);
  }
  assert.equal(card({ type: 'lab', theme: M[0].theme }).kids[0].props.dangerouslySetInnerHTML.__html, 'PIC');
});

test('the modes fit a narrow box: under 520 px a segment with an icon shows the icon, the pressed one keeps its label (office HUD and City)', () => {
  const css = readFileSync(join(root, 'components', 'bundle.css'), 'utf8'), office = readFileSync(join(root, 'public', 'office.css'), 'utf8');
  assert.match(bundle, /title:o\.icon\?o\.label:undefined,onClick:[^\n]*o\.icon\?h\("span",\{className:"ao-seg-l"\},o\.label\):o\.label\)/, 'the label is a span, and the tooltip names the mode');
  assert.match(css, /@container \(max-width:520px\)\{\.ao-seg button:not\(\[aria-pressed="true"\]\) \.ao-seg-l\{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect\(0 0 0 0\)/);
  assert.match(css, /\.ao-office\{[^}]*container-type:inline-size/, 'the office is the container');
  assert.match(office, /\.city-tools \{[^}]*container-type: inline-size;/, 'the City tools are a container too');
});

// The rules of a style sheet in order: { cond, sel, body }, where cond is the @container or @media line around the rule ('' at top level).
function cssRules(text) {
  const s = text.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ''), out = [];
  (function walk(from, to, cond) {
    for (let j = from; j < to;) {
      const open = s.indexOf('{', j);
      if (open < 0 || open >= to) break;
      let depth = 1, k = open + 1;
      for (; depth && k < to; k++) { if (s[k] === '{') depth++; else if (s[k] === '}') depth--; }
      const head = s.slice(j, open).trim().replace(/\s+/g, ' ');
      if (head.startsWith('@')) walk(open + 1, k - 1, head);
      else out.push({ cond, sel: head, body: s.slice(open + 1, k - 1).replace(/\s*([:;])\s*/g, '$1').trim() });
      j = k;
    }
  })(0, s.length, '');
  return out;
}

test('the office top bar keeps to the rows above the side columns: icons only where the labels do not fit, the counts hide, the columns start below the last toggle', () => {
  const css = cssRules(readFileSync(join(root, 'components', 'bundle.css'), 'utf8'));
  const office = cssRules(readFileSync(join(root, 'public', 'office.css'), 'utf8'));
  // the bar holds the brand, Needs you (with onWaiting, #92 review), the mode toggle, the view toggle and the counts, in this order: the
  // view toggle is the last .ao-seg of the bar, so Needs you sits above the columns' top too
  assert.match(bundle, /h\("div",\{className:"ao-hud-top"\},h\("div",\{className:"ao-panel ao-brand"\}[^\n]*\n\s*p\.onWaiting&&nwait>0\?h\(A\.Button,[^\n]*\n\s*h\(A\.ModeToggle,[^\n]*\n\s*h\(A\.ViewToggle,[^\n]*\n\s*h\("div",\{className:"ao-hud-counts"\}/);
  assert.match(source('function ViewToggle(p){'), /className:"ao-panel ao-seg"/);
  const rule = (cond, sel) => css.filter((r) => r.cond === cond && r.sel === sel);
  const sr = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';
  const label = '.ao-hud-top .ao-seg button:not([aria-pressed="true"]) .ao-seg-l';
  assert.ok(rule('@container (max-width:999px)', label).some((r) => r.body.startsWith(sr)), 'in the bar the mode toggle shows icons only to 999 px');
  assert.ok(rule('@container (max-width:959px)', '.ao-hud-counts').some((r) => r.body === 'display:none'), 'the counts hide below 960 px, where a second row would touch the right column');
  assert.ok(rule('', '.ao-hud-top>.ao-seg').some((r) => r.body === 'anchor-name:--ao-hud-seg'), 'each toggle of the bar is the anchor; the last one in the tree wins');
  // The top of a column, from the last rule that sets it in each band. The anchored rule comes after every fixed top, so it has the last word.
  const isCol = (sel, col) => sel.split(',').map((x) => x.trim()).includes(col);
  const tops = (col) => css.map((r, i) => ({ ...r, i })).filter((r) => isCol(r.sel, col) && /(^|;)top:/.test(r.body)).map((r) => ({ i: r.i, cond: r.cond, top: r.body.match(/(?:^|;)top:([^;]*)/)[1] }));
  const last = (col, cond) => tops(col).filter((t) => t.cond === cond).pop();
  const net = (min, gap) => `max(${min}px,calc(anchor(--ao-hud-seg bottom,0px) + ${gap}px))`;
  assert.equal(last('.ao-hud-left', '').top, net(68, 16), 'above 820 px the Floors column is never above 68 px, and starts below the last toggle');
  assert.equal(last('.ao-hud-right', '').top, net(68, 16));
  assert.equal(last('.ao-hud-left', '@container (max-width:820px)').top, net(108, 10), 'two rows of the bar to 521 px');
  assert.equal(last('.ao-hud-right', '@container (max-width:820px)').top, 'auto', 'to 820 px the right column sits at the bottom');
  assert.equal(last('.ao-hud-left', '@container (max-width:520px)').top, net(154, 10), 'three rows below 521 px');
  // A later rule wins over an earlier one of the same weight, also across bands: after the top-level net, a column top is set only by the net of a band.
  const after = last('.ao-hud-left', '').i;
  for (const col of ['.ao-hud-left', '.ao-hud-right']) {
    for (const t of tops(col).filter((x) => x.i > after)) assert.ok(t.cond && (/anchor\(--ao-hud-seg bottom/.test(t.top) || t.top === 'auto'), `${col} top after the net: ${t.cond} ${t.top}`);
  }
  // the page does not move the columns: a page top would undo the net
  for (const r of office) {
    const lastPart = r.sel.split(',').map((x) => x.trim().split(' ').pop());
    if (lastPart.some((p) => /\.ao-hud-(left|right)\b/.test(p))) assert.doesNotMatch(r.body, /(^|;)top:/, `office.css sets no top on ${r.sel}`);
  }
});

// ---- #82: walk speed is a DS token; a temporary helper walks about twice as fast, in and out ----
function walkRig() {
  const WALK = { bot: 2.6, ephemeral: 5.2 };
  const walkStep = new Function('WALK', source('function walkStep(b,dt)', 'return walking;}\n') + 'return walkStep;')(WALK);
  // seconds a bot needs for a straight path of 29 units, in 60 fps steps
  const secs = (bot) => {
    Object.assign(bot, { pos: new V(0, 0, 0), path: [new V(29, 0, 0)] });
    let t = 0;
    while (bot.path.length && t < 120) { walkStep(bot, 1 / 60); t += 1 / 60; }
    return t;
  };
  return { WALK, walkStep, secs };
}

test('walk: a normal bot takes about 11 s for 29 units, a helper at most 6 s (#82)', () => {
  const { secs } = walkRig();
  const normal = secs({}), helper = secs({ ephemeral: true });
  assert.ok(Math.abs(normal - 11.2) < 0.2, `normal bot ${normal.toFixed(2)} s`);
  assert.ok(helper <= 6, `helper ${helper.toFixed(2)} s`);
  assert.ok(Math.abs(normal / helper - 2) < 0.1, 'about twice as fast');
});

test('walk: the speed comes from the token values, so a page can change it (#82)', () => {
  const { WALK, secs } = walkRig();
  WALK.bot = 5.2; WALK.ephemeral = 2.6;
  assert.ok(secs({}) < 6 && secs({ ephemeral: true }) > 10);
});

test('walk: the arrive step fires once, at the end of the path, at both speeds (#82)', () => {
  const { walkStep } = walkRig();
  for (const ephemeral of [false, true]) {
    let arrived = 0;
    const b = { ephemeral, pos: new V(0, 0, 0), path: [new V(3, 0, 0), new V(3, 0.5, 4)], onArrive: () => arrived++ };
    let walking, n = 0;
    do { walking = walkStep(b, 1 / 60); n++; } while (walking && n < 2000);
    assert.equal(arrived, 1, `ephemeral ${ephemeral}`);
    assert.equal(b.onArrive, null);
    assert.equal(b.pos.y, 0.5);
    assert.equal(b.pos.z, 4);
  }
});

test('walk: no literal speed is left in the walk step or the bot animation, and the engine reads both tokens (#82)', () => {
  assert.ok(!/\b2\.6\b/.test(source('function walkStep(b,dt)', 'return walking;}\n')), 'no 2.6 in walkStep');
  const at = bundle.indexOf('function animateBot(');
  assert.ok(at >= 0 && !/sp=2\.6/.test(bundle.slice(at, at + 600)), 'no literal speed in animateBot');
  assert.ok(bundle.slice(at, at + 200).includes('walkStep(b,dt)'), 'animateBot still calls walkStep, or bots would stop walking');
  assert.match(source('function readScene(el)', '\n (AO.MODES||[])'), /WALK\.bot=num\(cs,"scene-walk-speed",2\.6\).*WALK\.ephemeral=num\(cs,"scene-walk-speed-ephemeral",5\.2\)/);
});

// ---- #107: one theme change refreshes the Kit once; Stage.dispose always frees the renderer ----
// The rig runs the real themeOf (the nearest data-theme, else <html>, else the system scheme) and the real AO.MODES maps. The stage
// element sits inside its root, as in the office page (the root is .ao-office, the stage is a child of it).
function themeRig() {
  const node = (parent = null) => ({ attrs: {}, parentNode: parent, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; },
    closest(sel) { const k = sel.slice(1, -1); for (let n = this; n; n = n.parentNode) if (n.attrs[k] != null) return n; return null; } });
  const html = Object.assign(node(), { className: '' });
  const doc = { documentElement: html };
  const win = { matchMedia: () => ({ matches: false }) };
  const C = function () { this.convertSRGBToLinear = () => this; this.set = () => this; };
  const T = { Color: C, Vector3: V, Fog: function () {} };
  const look = { hi: 1, hc: 0, hg: 0, si: 1, sc: 0, lamp: 0, sp: [1, 2, 3] };
  const LOOKS = Object.fromEntries(modes().map((m) => [m.id, look]));
  const FX = { bloom: {}, thr: {}, exp: {}, vig: {}, fog: Object.fromEntries(modes().map((m) => [m.id, 0])), rad: 1, knee: 1 };
  function Stage() {}
  new Function('AO', 'Stage', 'T', 'LOOKS', 'FX', 'document', 'window', 'matchMedia',
    source('function themeOf(el)', '}\n') +
    source('var THEME_OF={},LOOK_OF={},DARK={};', '\n') +
    source('Stage.prototype.look=function', '};\n') +
    source('Stage.prototype.applyMode=function', ';};\n') +
    source('Stage.prototype.themeSig=function', '};\n') +
    source('Stage.prototype.retheme=function', '};\n') +
    source('Stage.prototype.onThemeMutation=function', '};\n') +
    source('Stage.prototype.setMode=function', '};\n')
  )({ MODES: modes() }, Stage, T, LOOKS, FX, doc, win, win.matchMedia);
  const make = () => {
    const calls = { refresh: 0, look: [] };
    const root = node(html);
    const el = node(root);
    const s = Object.create(Stage.prototype);
    const lamp = { intensity: 0 };
    Object.assign(s, {
      el, root, scene: {}, mode: 'auto', comp: null, q: 'high', dist: 10, lamps: [lamp], sunClock: false, bloom: null, grade: null,
      K: { look: 'day', dark: false, tok: { bg: '#fff' }, refresh() { calls.refresh++; } },
      onLook: (lk) => calls.look.push(lk),
      hemi: { color: { set() {} }, groundColor: { set() {} } }, sun: { color: { set() {} }, position: { copy() { return { add() {} }; } }, target: { position: {} } },
    });
    return { s, calls };
  };
  return { make, doc };
}

test('setMode refreshes the Kit once, and the observer that follows its attribute change does not refresh again (#107)', () => {
  const { make } = themeRig();
  const { s, calls } = make();
  const [, B] = modes();
  s.setMode(B.id);                    // sets data-theme on the root, refreshes, applies the look
  assert.equal(calls.refresh, 1, 'setMode: one refresh');
  assert.deepEqual(calls.look, [B.id]);
  s.onThemeMutation();                // the MutationObserver callback for that attribute change
  s.onThemeMutation();                // a second record of the same batch
  assert.equal(calls.refresh, 1, 'the observer finds the theme already applied');
  assert.deepEqual(calls.look, [B.id], 'the look is applied once');
});

test('a theme change from outside the stage refreshes the Kit once (#107)', () => {
  const { make } = themeRig();
  const { s, calls } = make(), [, B, C] = modes();
  s.themeKey = s.themeSig();
  s.root.attrs['data-theme'] = B.theme;
  s.onThemeMutation();
  assert.equal(calls.refresh, 1, 'an outside change: one refresh, not one from the observer and one from the look change');
  assert.deepEqual(calls.look, [B.id]);
  s.onThemeMutation();
  assert.equal(calls.refresh, 1, 'the same state again: no refresh');
  s.root.attrs['data-theme'] = C.theme;
  s.onThemeMutation();
  assert.equal(calls.refresh, 2, 'a new theme: one more refresh');
});

test('the office page: setMode, then chat-extras copies the theme to <html>, then the observer: one refresh in every theme (#107)', () => {
  const { make, doc } = themeRig();
  const { s, calls } = make(), [A] = modes();
  s.root.attrs['data-theme'] = A.theme; doc.documentElement.attrs['data-theme'] = A.theme;
  s.themeKey = s.themeSig();
  let n = 0;
  for (const m of modes().slice(1)) {
    s.setMode(m.id);                                     // DS ModeToggle: the root gets the theme, one refresh
    doc.documentElement.attrs['data-theme'] = m.theme;   // chat-extras.js syncTheme: its observer runs first
    s.onThemeMutation();                                 // the stage's observer: root record and <html> record
    s.onThemeMutation();
    n++;
    assert.equal(calls.refresh, n, `${m.label}: one refresh, not a second one after the <html> copy`);
    assert.equal(calls.look.at(-1), m.id);
  }
  assert.deepEqual(calls.look, modes().slice(1).map((m) => m.id), 'each look applied once');
});

test('a theme change on <html> under a root that keeps its own theme does not refresh; a change the stage reads does (#107)', () => {
  const { make, doc } = themeRig();
  const { s, calls } = make(), [, B, C] = modes();
  s.root.attrs['data-theme'] = B.theme;
  s.themeKey = s.themeSig();
  doc.documentElement.attrs['data-theme'] = C.theme;   // the stage still reads B from its root
  s.onThemeMutation();
  assert.equal(calls.refresh, 0, 'the tokens of the stage did not change');
  delete s.root.attrs['data-theme'];                       // now the stage reads <html>
  s.onThemeMutation();
  assert.equal(calls.refresh, 1);
  assert.deepEqual(calls.look, [C.id]);
  doc.documentElement.className = 'x';
  s.onThemeMutation();
  assert.equal(calls.refresh, 2, 'an <html> class change still refreshes, as the observer watches it');
});

test('Stage.dispose frees the renderer and the context even when a free throws (#107)', () => {
  const lib = gpuKit();
  const bad = G('bad'); bad.dispose = () => { order.push('bad'); throw new Error('free failed'); };
  const scene = new Node3({ isScene: true });
  scene.add(mesh3(bad, M('m')));
  const s = lib.stage(scene);
  s.K.tex = { t: X('t') };
  assert.throws(() => s.dispose(), /free failed/, 'the error still reaches the caller');
  assert.deepEqual(order.slice(-3), ['renderer.dispose', 'forceContextLoss', 'canvas.remove'], 'the renderer, the context and the canvas are freed');
  assert.deepEqual(s.K.tex, {}, 'the Kit caches are empty');
  assert.equal(s.dead, true);
  assert.equal(lib.LIVE.includes(s), false);
  const n = order.length;
  s.dispose();
  assert.equal(order.length, n, 'a second dispose does nothing');
});

test('Stage.dispose frees the context even when the renderer dispose throws (#107)', () => {
  const lib = gpuKit();
  const s = lib.stage(new Node3({ isScene: true }));
  s.r.dispose = () => { order.push('renderer.dispose'); throw new Error('renderer failed'); };
  assert.throws(() => s.dispose(), /renderer failed/);
  assert.deepEqual(order.slice(-3), ['renderer.dispose', 'forceContextLoss', 'canvas.remove']);
});

test('Stage.dispose: when two frees throw, the caller gets the first error, and every free still runs (#107)', () => {
  const lib = gpuKit();
  const bad = G('bad'); bad.dispose = () => { order.push('bad'); throw new Error('first'); };
  const scene = new Node3({ isScene: true });
  scene.add(mesh3(bad, M('m')));
  const s = lib.stage(scene);
  s.r.dispose = () => { order.push('renderer.dispose'); throw new Error('second'); };
  s.r.forceContextLoss = () => { order.push('forceContextLoss'); throw new Error('third'); };
  assert.throws(() => s.dispose(), (e) => e.message === 'first', 'the first error reaches the caller, not the last');
  assert.deepEqual(order.slice(-3), ['renderer.dispose', 'forceContextLoss', 'canvas.remove']);
});

test('Stage.dispose: a controls dispose that throws does not keep the scene, the Kit or the renderer alive (#107)', () => {
  const lib = gpuKit();
  const g = G('g'), t = X('t');
  const scene = new Node3({ isScene: true });
  scene.add(mesh3(g, M('m')));
  const s = lib.stage(scene);
  s.K.tex = { t };
  s.ctl.dispose = () => { throw new Error('controls failed'); };
  assert.throws(() => s.dispose(), /controls failed/);
  assert.equal(spent.get(g), 1, 'the scene geometry is freed');
  assert.equal(spent.get(t), 1, 'the Kit texture is freed');
  assert.deepEqual(order.slice(-3), ['renderer.dispose', 'forceContextLoss', 'canvas.remove']);
});

// The change record (emit) is what the HUD reads: the agent card gets its bot from it. BotDef documents owner, triggers and
// cost as agent card fields, so the record carries them (agent-office #76: a Paperclip run's company is its owner; the
// trigger of a scheduled session was dropped the same way before).
test('the change record of a bot carries every agent card field of BotDef: owner, triggers and cost too', () => {
  const start = 'bots:r.bots.map(function(b){return {name:b.name,color:b.color,';   // emit's (the other is the building view's)
  const at = bundle.indexOf(start);
  assert.ok(at >= 0 && bundle.indexOf(start, at + 1) === -1, 'one bot record in emit');
  const literal = bundle.slice(at + 'bots:r.bots.map(function(b){return '.length, bundle.indexOf('};})', at) + 1);
  const record = new Function('b', 'r', 'bld', 'openSessions', 'return ' + literal);
  const b = { name: 'Ada', platform: 'Paperclip Engineer, Claude Code', owner: 'Acme Robotics (Ada)', triggers: ['Nightly'], cost: '$0.12', identity: 'C:/work', tools: ['Read'] };
  const r = record(b, { id: 'room-1' }, {}, () => []);
  assert.deepEqual([r.platform, r.owner, r.triggers, r.cost, r.identity, r.tools, r.room], [b.platform, b.owner, b.triggers, b.cost, b.identity, b.tools, 'room-1']);
  const none = record({ name: 'x' }, { id: 'r' }, {}, () => []);
  assert.deepEqual([none.owner, none.triggers, none.cost], [null, null, null]);
});

// ---------- function floors (#92): the elevator panel, open desks, the Reception ----------
test('worstOf: the worst state of a floor lights its elevator button (error, needs you, review ready, working, finished, resting)', () => {
  const worstOf = new Function(source('var WORST=[', '];\n') + source('function worstOf(l){') + 'return worstOf;')();
  assert.equal(worstOf(['resting', 'working', 'finished']), 'working');
  assert.equal(worstOf(['working', 'waiting']), 'waiting');
  assert.equal(worstOf(['waiting', 'error']), 'error');
  assert.equal(worstOf(['finished', 'review']), 'review');
  assert.equal(worstOf([]), null);
  assert.equal(worstOf(['nope']), null);
});

test('room.spare adds open desks after the bots: a room with no bot still has desks to click', () => {
  const lr = bundle.slice(bundle.indexOf('function layoutRoom(room){'), bundle.indexOf('function layoutFloor(f){'));
  const lay = new Function('var PITCH=4.6;' + source('var TYPES={', '};\n') + lr + 'return layoutRoom;')();
  assert.equal(lay({ type: 'lab', bots: [] }).stations.length, 0);
  assert.equal(lay({ type: 'lab', bots: [], spare: 2 }).stations.length, 2);
  assert.equal(lay({ type: 'lab', bots: [{}], spare: 1 }).stations.length, 2);
  assert.equal(lay({ type: 'lab', bots: [], spare: 40 }).stations.length, 6, 'at most 6 open desks');
  const lobby = lay({ type: 'lobby', bots: [], spare: 2 });
  assert.equal(lobby.stations.length, 2);
  assert.ok(lobby.W >= 16, 'the Reception is wide enough for its desk');
  // the builder marks each open desk for a page to pick, with a padded hit box
  assert.ok(bundle.includes('dg.userData.spareDesk={room:room.id,i:sp-room.bots.length}'));
  assert.ok(bundle.includes('hb.userData.spareDesk=dg.userData.spareDesk;hb.userData.spareHit=true;'));
  assert.ok(bundle.includes('memo.userData.lobby="memo"') && bundle.includes('dir.userData.lobby="directory"'));
});

test('room.add and room.update carry the small print and the open desks; the sign shows the note', () => {
  const mk = new Function('TYPES', 'bld', 'st',
    'function floorOf(id){return bld.floors.filter(function(f){return f.id===id;})[0];}' +
    'function norm(){}function rebuildFloor(){}function rebuildBuilding(){}function show(){}function emit(){}function frameFloor(){}' +
    source(' function addRoom(') + source(' function updateRoom(') + 'return { addRoom: addRoom, updateRoom: updateRoom };');
  const bld = { floors: [{ id: 1, rooms: [] }] };
  const e = mk({ lab: { label: 'Lab' }, team: { label: 'Team' } }, bld, {});
  e.addRoom(1, { id: 'spare-quality', type: 'lab', name: 'Open desks', note: 'No agents here. Click a desk to start one.', spare: 2, spareRole: 'analyst' });
  assert.deepEqual(bld.floors[0].rooms[0], { id: 'spare-quality', type: 'lab', name: 'Open desks', bots: [], note: 'No agents here. Click a desk to start one.', spare: 2, spareRole: 'analyst' });
  e.updateRoom('spare-quality', { id: 'w-repo-1', name: 'Tidy', note: 'main · Shared workspace', spare: 1 });
  const r = bld.floors[0].rooms[0];
  assert.deepEqual([r.id, r.name, r.note, r.spare], ['w-repo-1', 'Tidy', 'main · Shared workspace', 1]);
  assert.ok(bundle.includes('Parts.sign(K,rg,room.name,room.note?String(room.note).slice(0,48):'));
});

// #92 review: with no dock, a request in another building showed only in the tab title. OfficeScene onWaiting puts a Needs you
// button in the top bar (every width: the zoom column with Decisions hides at 820 px and below), with the page's count.
test('OfficeScene onWaiting: a Needs you button in the top bar, before the toggles, with waitingCount; none when nothing waits', () => {
  assert.ok(bundle.includes('var nwait=p.waitingCount!=null?p.waitingCount:nreq;'), 'the page total, else this building');
  const top = source('h("div",{className:"ao-hud-top"}', 'h(A.ModeToggle,');
  assert.match(top, /p\.onWaiting&&nwait>0\?h\(A\.Button,\{variant:"emphasis",icon:"waiting",className:"ao-hud-needs",/, 'only with onWaiting and a count');
  assert.match(top, /onClick:function\(\)\{p\.onWaiting\(\);\}\},"Needs you · "\+nwait\)/);
  assert.match(top, /label:"Needs you: "\+nwait\+\(nwait===1\?" decision":" decisions"\)\+"\. Go to the oldest\."/, 'the label says what a tap does');
  assert.ok(top.indexOf('ao-hud-needs') > top.indexOf('ao-brand'), 'after the brand');
  // not hidden at any width: no container or media rule hides it, and it is a finger target on a touch screen
  const css = readFileSync(join(root, 'components', 'bundle.css'), 'utf8');
  assert.doesNotMatch(css, /\.ao-hud-needs[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /@media \(pointer:coarse\)\{\.ao-hud-needs\{min-height:44px\}\}/);
});

test('the elevator panel groups floors in wings, dims an empty floor and skips it on the arrow keys', () => {
  const fl = source('function FloorList(p){var fl=floorRows(p.floors', '));}\n');
  assert.match(fl, /className:"ao-wing"/);
  assert.match(fl, /"ao-row"\+\(f\.empty\?" is-empty":""\)/);
  assert.match(fl, /"No agents here"/);
  assert.match(fl, /function step\(i,d\)\{for\(var j=i\+d;j>=0&&j<fl\.length;j\+=d\)\{if\(!fl\[j\]\.empty\)/);
  assert.match(fl, /title:p\.title\|\|"Floors"/);
  assert.ok(bundle.includes('h(A.FloorList,{title:p.floorsTitle,'));
  assert.ok(bundle.includes('r.spare?"No agents here. Click a desk to start one.":'));
});
