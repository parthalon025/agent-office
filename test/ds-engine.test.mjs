// DS scene engine rules in components/bundle.js: reduced-motion camera cuts (#36), the zoom step (#56), seeded events
// and Since you left (#35), unread and Activity of seeded events (#61), the Needs you source of Since you left (#62),
// the frame inset clamp (#65), and the schema copy in kit/schema.json. The bundle needs WebGL and React, so each test
// takes the one function it checks out of the bundle text and runs it on plain stand-ins (no THREE, no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
