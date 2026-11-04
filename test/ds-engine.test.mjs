// DS scene engine rules in components/bundle.js: reduced-motion camera cuts (#36), the zoom step (#56), seeded events
// and Since you left (#35), and the schema copy in kit/schema.json. The bundle needs WebGL and React, so each test
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
}
function Stage() {}
new Function('T', 'Stage', source('Stage.prototype.frame=function', '};\n') + source('Stage.prototype.zoom=function', '};\n'))({ Vector3: V }, Stage);

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

test('frame glides without reduced motion: a goal, the target does not move yet (#36)', () => {
  const s = stage(false);
  s.frame([1, 2, 3], 9, 1.5);
  assert.ok(s.goal, 'a camera goal');
  assert.deepEqual([s.ctl.target.x, s.ctl.target.y, s.ctl.target.z], [0, 0, 0]);
  assert.equal(s.D, 11);
});

test('frame cuts under reduced motion: no goal, target, D and zoom set at once (#36)', () => {
  const s = stage(true);
  s.frame([1, 2, 3], 9, 1.5);
  assert.equal(s.goal, null);
  assert.deepEqual([s.ctl.target.x, s.ctl.target.y, s.ctl.target.z], [1, 2, 3]);
  assert.deepEqual([s.cam.position.x, s.cam.position.y, s.cam.position.z], [11, 12, 13], 'the camera moves with the target');
  assert.equal(s.D, 9);
  assert.equal(s.cam.zoom, 1.5);
  s.frame([0, 0, 0], 0, 1, false, [4, 4, 4]);
  assert.equal(s.goal, null, 'an explicit now=false also cuts');
  assert.equal(s.D, 7, 'ext fits D');
});

test('the floor-change slide ends at once under reduced motion (#36)', () => {
  assert.match(bundle, /if\(fx\)\{fx\.t=s\.rm\?1:Math\.min\(1,/);
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
    'var rp=null,seeding=false;' +
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

test('dispose marks the building as seen and saves (#35)', () => {
  const at = bundle.indexOf('dispose:function(){if(adapter&&adapter.dispose)adapter.dispose();document.removeEventListener("visibilitychange",onVis)');
  assert.ok(at >= 0);
  assert.match(bundle.slice(at, bundle.indexOf('\n', at)), /st\.lastSeen=seenNow\(\);hsave\(\);/);
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
