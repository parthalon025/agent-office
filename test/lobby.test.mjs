// The lobby and the desks (#92): the pure part of public/lobby.js (the tour, the nameplate, the directory board, the reception
// memo), and the keyboard path of every lobby object in Ctrl+K. No browser. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../public/format.js';
import '../public/vocab.js';
import '../public/lobby.js';
import '../public/scene-host.js';

const L = globalThis.OfficeLobby.pure;

test('the tour has four stops: the empty desk, the monitor, the paper and the elevator; it shows once, in the office', () => {
  assert.deepEqual(L.tourSteps().map((s) => s.key), ['desk', 'monitor', 'paper', 'elevator']);
  for (const s of L.tourSteps()) { assert.ok(s.title && s.text); assert.doesNotMatch(s.text, /please|sorry|oops|!/i, 'plain words, no exclamation'); }
  assert.equal(L.tourDue(false, true), true);
  assert.equal(L.tourDue(true, true), false, 'seen: only a replay from the Reception shows it');
  assert.equal(L.tourDue(false, false), false, 'not in the city');
});

test('a nameplate says the name, the model lane and the cost', () => {
  assert.deepEqual(L.plateLines('reviewer', { model: 'claude-opus-5-5', cost: 1.234 }), { name: 'reviewer', detail: 'Opus · $1.23' });
  assert.deepEqual(L.plateLines('local', { model: 'qwen3', costUnknown: true }), { name: 'local', detail: 'cost unknown' });
  assert.deepEqual(L.plateLines('new', { model: 'sonnet', cost: null }), { name: 'new', detail: 'Sonnet' });
  assert.deepEqual(L.plateLines('x', null), { name: 'x', detail: '' });
});

test('the directory board lists every floor top first, with its wing, its agents and the worst state', () => {
  const floors = [{ id: 1, name: 'Lobby', wingName: '' }, { id: 2, name: 'Engineering', wingName: 'Product and tech' }, { id: 3, name: 'Executive', wingName: 'Leadership' }];
  const rows = L.directoryRows(floors, { 2: ['a', 'b', 'c', 'd'], 1: ['z'] }, { 2: 'waiting', 1: 'working' });
  assert.deepEqual(rows.map((r) => r.name), ['Executive', 'Engineering', 'Lobby']);
  assert.deepEqual(rows[0], { id: 3, wing: 'Leadership', name: 'Executive', agents: 0, state: null, line: 'No agents' });
  assert.equal(rows[1].line, 'a, b and 2 more · Needs you');
  assert.equal(rows[2].line, 'z · Working');
});

test('the reception memo asks to confirm the proposed archetype once, then shows Since you left', () => {
  const open = L.memoLines({ confirmed: false, proposedName: 'Operations Hub', archetypeName: 'Operations Hub', why: 'A package manifest and agents.' }, []);
  assert.equal(open.title, 'Confirm the building');
  assert.deepEqual(open.lines, ['Proposed: Operations Hub.', 'A package manifest and agents.', 'Click the memo to confirm or change it.']);
  const done = L.memoLines({ confirmed: true, archetypeName: 'Software product' }, ['repo finished a task', 'b stopped on an error', 'c', 'd']);
  assert.equal(done.title, 'Software product');
  assert.equal(done.lines.length, 4, 'three news lines and the way to the floors');
  assert.deepEqual(L.memoLines({ confirmed: true, archetypeName: 'General' }, []).lines, ['Nothing new since you left.', 'Click the memo for the floors and the tour.']);
  assert.equal(L.memoLines(null, []).title, 'Reception');
});

// #92 review: a nameplate on the desk was about 2 px text at the floor's zoom. It is a sprite now, drawn at the DS body (name) and
// caption (lane and cost) sizes and scaled every frame to that many CSS pixels, so it reads at every zoom and width.
test('nameplate box: as wide as its longer line plus padding, at most the cap; one line when there is no lane or cost', () => {
  assert.deepEqual(L.plateBox(80, 50, 13, 11, 8, 200), { w: 96, h: 42, nameY: 4 + 13 * 0.72, detailY: 4 + 13 * 1.45 + 11 * 0.7 });
  assert.equal(L.plateBox(500, 40, 13, 11, 8, 200).w, 200, 'a long name is cut, the plate stays at the cap');
  assert.equal(L.plateBox(30, 90, 13, 11, 8, 200).w, 106, 'the detail line can be the longer one');
  const one = L.plateBox(60, 0, 13, 11, 8, 200);
  assert.equal(one.h, Math.round(13 * 1.45 + 8), 'no detail: one line');
  assert.ok(L.plateBox(0, 0, 13, 11, 8, 200).w >= 29, 'an empty name still has a box');
  const lobby = fs.readFileSync(new URL('../public/lobby.js', import.meta.url), 'utf8');
  assert.match(lobby, /new T\.Sprite\(new T\.SpriteMaterial\(\{ map: t\.tex, transparent: true, depthTest: false, depthWrite: false \}\)\)/, 'a sprite: it faces the camera');
  assert.match(lobby, /m\.material\.toneMapped = false;/, 'unlit: the painted pairs (contrast.test.mjs) are the colors on screen');
  assert.match(lobby, /wpp = \(st\.cam\.top - st\.cam\.bottom\) \/ \(st\.cam\.zoom \|\| 1\) \/ \(cv\.clientHeight \|\| 1\);[\s\S]{0,400}?p\.mesh\.scale\.set\(p\.box\.w \* wpp, p\.box\.h \* wpp, 1\);/, 'scaled to its CSS size every frame');
  assert.match(lobby, /var sz = \{ body: cssNum\('type-body-size', 13\), caption: cssNum\('type-caption-size', 11\) \};/, 'the DS type sizes');
});

// #92 review: two agents at neighbouring desks at 400 px had two plates on top of each other. A plate that overlaps one shown
// before it waits until the zoom parts them.
test('nameplates on top of each other: the first shows, the one over it waits; apart, both show', () => {
  const box = (left, top, w = 100, h = 40) => ({ left, top, right: left + w, bottom: top + h });
  assert.deepEqual(L.declutter([box(0, 0), box(50, 10), box(300, 0)], 4), [true, false, true]);
  assert.deepEqual(L.declutter([box(0, 0), box(102, 0)], 4), [true, false], 'the gap counts');
  assert.deepEqual(L.declutter([box(0, 0), box(110, 0)], 4), [true, true]);
  assert.deepEqual(L.declutter([null, box(0, 0), box(0, 0)], 4), [false, true, false], 'off screen shows nothing and blocks nothing');
  assert.deepEqual(L.declutter([box(0, 0), box(50, 10), box(100, 20)], 0), [true, false, true], 'a hidden plate blocks nothing');
  const lobby = fs.readFileSync(new URL('../public/lobby.js', import.meta.url), 'utf8');
  assert.match(lobby, /var show = declutter\(boxes, 4\);\s*plates\.forEach\(function \(p, i\) \{ p\.mesh\.visible = !!show\[i\] \|\| !boxes\[i\]; \}\);/, 'every frame');
});

// Every in-scene object of this phase has a keyboard path (ADR 0003 keeps painted toggles out; these are actions).
test('every lobby object has a Ctrl+K action: an open desk on each floor, the Reception, the tour, and the directory search', () => {
  const office = fs.readFileSync(new URL('../public/office.js', import.meta.url), 'utf8');
  const lobby = fs.readFileSync(new URL('../public/lobby.js', import.meta.url), 'utf8');
  const verbs = /var VERB = \{ desk: '([^']+)', memo: '([^']+)', directory: '([^']+)', monitor: '([^']+)' \};/.exec(lobby);
  assert.ok(verbs, 'the in-scene verbs');
  assert.deepEqual(verbs.slice(1), ['Start an agent here', 'Open the Reception', 'Search the office', 'Start an agent here']);
  // an open desk on each floor moved into desk.js (#90): one list of the scene's actions, which test/desk.test.mjs checks
  assert.match(office, /OfficeDesk\.pure\.paletteActions\(dt,/, 'desk: Start an agent on <floor>');
  assert.match(fs.readFileSync(new URL('../public/desk.js', import.meta.url), 'utf8'), /'Start an agent on ' \+ \(e\.name/, 'desk: Start an agent on <floor>');
  assert.match(office, /\['reception', 'Reception: floors and the kind of building', 'building'/, 'memo: the Reception');
  assert.match(office, /\['tour', 'Replay the lobby tour', 'chevron-right'/);
  assert.match(office, /onReception: function \(part\) \{ if \(part === 'directory'\) openPalette\(\);/, 'the directory opens the search, which is Ctrl+K itself');
  // the dock's per-agent actions moved into Ctrl+K
  for (const id of ["'page-s-always-'", "'page-s-model-'", "'page-s-mode-'", "'page-s-stop-'", "'page-s-term-'", "'page-s-chg-'"]) assert.ok(office.includes(id), id);
});

// ---------- the tour's flights (#92 review): lobby.js on the real scene host, on a plain scene graph (no THREE, no DOM) ----------
// The monitor stop used to fly nowhere (host.blur). Now it looks at an agent's monitor on the floor (the terminal adapter,
// o.monitor), else at the monitor of the first open desk; the second step starts an agent at that desk.
function node(props = {}, children = []) {
  const n = { visible: true, userData: {}, children: [], parent: null, ...props };
  children.forEach((c) => { c.parent = n; n.children.push(c); });
  n.traverse = (fn) => { fn(n); n.children.forEach((c) => (c.traverse ? c.traverse(fn) : fn(c))); };
  return n;
}
const v3 = (x, y, z) => ({ x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } });
// a plane mesh centered at (x, y, z), facing +z, like a DS desk screen
const screenAt = (name, x, y, z, w = 1.05, h = 0.68) => node({ name, isMesh: true, geometry: { type: 'PlaneGeometry', parameters: { width: w, height: h } },
  matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] }, updateWorldMatrix() {} });
const backWall = () => node({ isMesh: true, geometry: { type: 'BoxGeometry', parameters: { width: 16, height: 5.2, depth: 0.2 } } });
function lobbyRig({ desks = 1 } = {}) {
  const cv = { style: { cursor: '' }, addEventListener() {}, removeEventListener() {}, clientWidth: 100, clientHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) };
  const anim = [], screens = [], kids = [backWall()];
  for (let i = 0; i < desks; i++) {
    const mon = screenAt('monitor-' + i, 3 + i * 3, 1.62, -1);
    const hit = node({ name: 'hit-' + i, isMesh: true, userData: { spareHit: true, spareDesk: { room: 'reception', i } }, geometry: { type: 'BoxGeometry', parameters: { width: 2.8, height: 1.8, depth: 2.6 } },
      matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3 + i * 3, 0.9, 0.2, 1] }, updateWorldMatrix() {} });
    kids.push(node({ isGroup: true, userData: { spareDesk: { room: 'reception', i } } }, [mon, hit]));
    screens.push([mon, 'planner']);
  }
  const rg = node({ isGroup: true, position: { x: 0 } }, kids);
  const fg = node({ userData: { LB: 1, elev: {} } }, [rg]);
  const scene = node({}, [fg]);
  const stage = { scene, K: { tok: {}, look: 'day', screens }, r: { domElement: cv }, anim, goal: null,
    cam: { position: v3(30, 40, 60), zoom: 1, top: 10, bottom: -10, updateProjectionMatrix() {} },
    ctl: { target: v3(0, 0, 0), enabled: true, minPolarAngle: 0.35, maxPolarAngle: 1.25, maxZoom: 4 } };
  const ins = { stage, bots: [], floor: 1 };
  const office = { inspect: () => ins, getBuilding: () => ({ floors: [{ id: 1, rooms: [{ id: 'reception', type: 'lobby' }] }] }) };
  globalThis.THREE = { Vector2: class { set() {} }, Raycaster: class { setFromCamera() {} intersectObjects() { return []; } } };
  const host = globalThis.OfficeSceneHost.attach(office);
  const land = () => { for (let i = 0; i < 3; i++) anim.forEach((f) => f(1, i)); };   // 1 s frames: any flight lands
  return { office, host, stage, screens, land };
}

test('tour: the monitor stop flies to the monitor of an open desk, and the second step starts an agent at that desk', () => {
  const r = lobbyRig(), started = [];
  let asked = 0;
  const lob = globalThis.OfficeLobby.attach(r.office, { host: r.host, monitor: () => { asked++; return false; }, onDesk: (room, i) => started.push([room, i]) });
  try {
    assert.equal(lob.tour('monitor'), true, 'the camera flies');
    assert.equal(asked, 1, 'an agent monitor is asked for first');
    const f = r.host.focused();
    assert.deepEqual([f.key, f.open, f.verb, f.kind], ['monitor:reception:0', false, 'Start an agent here', 'desk']);
    assert.equal(f.item.mesh, r.screens[0][0], 'the look is at the desk screen, not at the desk');
    assert.equal(r.host.flying(), true);
    r.land();
    assert.equal(r.host.flying(), false);
    assert.ok(r.stage.cam.zoom > 1, 'zoomed in on the monitor');
    assert.ok(Math.abs(r.stage.ctl.target.x - 3) < 0.5 && Math.abs(r.stage.ctl.target.y - 1.62) < 0.5, 'the camera looks at the monitor: ' + JSON.stringify(r.stage.ctl.target));
    r.host.open();
    assert.deepEqual(started, [['reception', 0]]);
    // the desk stop and the monitor stop are two looks
    assert.equal(lob.tour('desk'), true);
    assert.equal(r.host.focused().key, 'desk:reception:0');
  } finally { lob.dispose(); r.host.dispose(); }
});

test('tour: an agent monitor on the floor is the stop when there is one; with no monitor at all the stop flies back', () => {
  const r = lobbyRig();
  const lob = globalThis.OfficeLobby.attach(r.office, { host: r.host, monitor: () => true });
  try {
    assert.equal(lob.tour('monitor'), true, 'the terminal adapter flies to the agent monitor');
    assert.equal(r.host.focused(), null, 'the lobby does not fly as well');
  } finally { lob.dispose(); r.host.dispose(); }
  const bare = lobbyRig({ desks: 0 });
  const lob2 = globalThis.OfficeLobby.attach(bare.office, { host: bare.host, monitor: () => false });
  try {
    assert.equal(lob2.tour('monitor'), false);
    assert.equal(bare.host.focused(), null);
  } finally { lob2.dispose(); bare.host.dispose(); }
});
