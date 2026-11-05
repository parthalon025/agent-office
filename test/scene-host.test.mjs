// Scene host: shown floor, view, room groups and rebuild detection on plain scene graphs (no THREE, no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../public/scene-host.js';

const P = globalThis.OfficeSceneHost.pure;

// A plain node with parent links, like a THREE object3D.
function node(props = {}, children = []) {
  const n = { visible: true, userData: {}, children: [], parent: null, ...props };
  children.forEach((c) => { c.parent = n; n.children.push(c); });
  return n;
}
const floor = (visible, extra = {}, kids = []) => node({ visible, userData: { LB: 1, elev: {} }, ...extra }, kids);
const box = (w, h, d) => ({ isMesh: true, visible: true, userData: {}, children: [], geometry: { type: 'BoxGeometry', parameters: { width: w, height: h, depth: d } } });
const plane = (w, h) => ({ isMesh: true, visible: true, userData: {}, children: [], geometry: { type: 'PlaneGeometry', parameters: { width: w, height: h } } });

test('inScene and shown follow the parent chain', () => {
  const m = node(), g = node({}, [m]), scene = node({}, [g]);
  assert.equal(P.inScene(scene, m), true);
  assert.equal(P.inScene(scene, node()), false);
  assert.equal(P.shown(scene, m), true);
  g.visible = false;
  assert.equal(P.shown(scene, m), false);
  assert.equal(P.floorOf(scene, m), g);
  assert.equal(P.floorOf(scene, node()), null);
});

test('shown floor: the one visible floor; none in the building view', () => {
  const f1 = floor(false), f2 = floor(true), other = node({ visible: true });
  const scene = node({}, [f1, f2, other]);
  assert.equal(P.shownFloor(scene, { bots: [], floor: 2 }), f2);
  assert.equal(P.viewOf(scene), 'floor');
  f2.visible = false;
  assert.equal(P.shownFloor(scene, { bots: [], floor: 2 }), null);
  assert.equal(P.viewOf(scene), 'building');
});

test('shown floor: groups without the elevator marker are not floors', () => {
  const notFloor = node({ visible: true, userData: { LB: 1 } });
  const scene = node({}, [notFloor]);
  assert.equal(P.floorGroups(scene).length, 0);
  assert.equal(P.viewOf(scene), 'none');
  assert.equal(P.shownFloor(scene, { bots: [] }), null);
});

test('shown floor: during the elevator ride the floor with the current floor bots wins', () => {
  const bot = node();
  const f1 = floor(true, {}, [bot]), f2 = floor(true);
  const scene = node({}, [f1, f2]);
  assert.equal(P.shownFloor(scene, { floor: 1, bots: [{ g: bot, floor: 1 }] }), f1);
  assert.equal(P.shownFloor(scene, { floor: 2, bots: [{ g: bot, floor: 1 }] }), null);
  assert.equal(P.shownFloor(scene, { floor: 1, bots: [] }), null);
  assert.equal(P.viewOf(scene), 'floor');
});

test('parts: wall, back wall, side wall, sign and board are told apart by size', () => {
  const back = box(10, 5.2, 0.2), side = box(0.2, 5.2, 8), roof = box(10, 0.3, 8), sign = plane(4.8, 1.2), board = plane(4, 2.5);
  assert.equal(P.parts.isWall(back), true);
  assert.equal(P.parts.isBackWall(back), true);
  assert.equal(P.parts.isBackWall(side), false);
  assert.equal(P.parts.isSideWall(side), true);
  assert.equal(P.parts.isWall(roof), false);
  assert.equal(P.parts.isSign(sign), true);
  assert.equal(P.parts.isBoard(board), true);
  assert.equal(P.parts.isBoard(sign), false);
  assert.equal(P.parts.isBoard({ isMesh: true }), false);
});

function roomGroup(x, id) {
  const g = node({ isGroup: true, position: { x }, roomName: id }, [box(10, 5.2, 0.2)]);
  return g;
}

test('room groups: matched to DS rooms left to right, by order not by child order', () => {
  const a = roomGroup(20, 'a'), b = roomGroup(0, 'b'), c = roomGroup(10, 'c');
  const fg = floor(true, {}, [a, b, c, box(1, 1, 1)]);
  const rooms = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
  const m = P.roomGroups(fg, rooms, P.parts.isBackWall);
  assert.deepEqual(m.map((x) => [x.room.id, x.rg.roomName]), [['r1', 'b'], ['r2', 'c'], ['r3', 'a']]);
});

test('room groups: a different count matches nothing (the floor is being rebuilt)', () => {
  const fg = floor(true, {}, [roomGroup(0, 'a'), roomGroup(10, 'b')]);
  assert.deepEqual(P.roomGroups(fg, [{ id: 'r1' }], P.parts.isBackWall), []);
  assert.deepEqual(P.roomGroups(null, [{ id: 'r1' }], P.parts.isBackWall), []);
  assert.deepEqual(P.roomGroups(fg, null, P.parts.isBackWall), []);
});

test('room groups: a group without a back wall is not a room', () => {
  const fg = floor(true, {}, [roomGroup(0, 'a'), node({ isGroup: true, position: { x: 5 } }, [box(1, 1, 1)])]);
  assert.equal(P.roomGroups(fg, [{ id: 'r1' }], P.parts.isBackWall).length, 1);
});

test('rebuilt: names why the scene changed', () => {
  const g1 = floor(true), g2 = floor(false), fg = g1;
  const base = { bots: [1], floor: 1, fg, groups: [g1, g2], tok: {}, look: 'day', gone: false };
  assert.deepEqual(P.rebuilt(null, base), []);
  assert.deepEqual(P.rebuilt(base, { ...base }), []);
  assert.deepEqual(P.rebuilt(base, { ...base, bots: [1, 2] }), ['bots']);
  assert.deepEqual(P.rebuilt(base, { ...base, tok: {} }), ['theme']);
  assert.deepEqual(P.rebuilt(base, { ...base, look: 'night' }), ['theme']);
  assert.deepEqual(P.rebuilt(base, { ...base, floor: 2, fg: g2 }), ['floor']);
  assert.deepEqual(P.rebuilt(base, { ...base, groups: [floor(true), g2] }), ['floors']);
  assert.deepEqual(P.rebuilt(base, { ...base, gone: true }), ['gone']);
});

test('choose: one winner, the nearest; a bot in front wins the click', () => {
  const near = { id: 'terminal', distance: 4 }, far = { id: 'board', distance: 9 };
  assert.equal(P.choose([far, near], null), near);
  assert.equal(P.choose([far, near], 3), null);
  assert.equal(P.choose([far, near], 5), near);
  assert.equal(P.choose([], null), null);
  assert.equal(P.choose(null, 1), null);
});

// ---------- the browser part, with a fake THREE and a fake canvas ----------
function fakeStage(hitsFor) {
  const handlers = {};
  const cv = { style: { cursor: '' }, addEventListener: (n, f) => { handlers[n] = f; }, removeEventListener: (n) => { delete handlers[n]; }, clientHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) };
  const anim = [];
  const mesh = (name) => node({ name, isMesh: true });
  const board = mesh('board'), screen = mesh('screen'), botHit = mesh('bot');
  const fg = floor(true, {}, [board, screen, botHit]);
  const scene = node({}, [fg]);
  const K = { tok: {}, look: 'day' };
  const stage = { scene, K, r: { domElement: cv }, cam: {}, anim };
  const ins = { stage, bots: [{ name: 'b', floor: 1, hit: botHit, g: botHit }], floor: 1 };
  globalThis.THREE = {
    Vector2: class { set() {} },
    Raycaster: class {
      setFromCamera() {}
      intersectObjects(list) { return list.map((m) => ({ object: m, distance: hitsFor[m.name], point: { x: 0 } })).filter((h) => h.distance != null).sort((a, b) => a.distance - b.distance); }
    }
  };
  return { office: { inspect: () => ins }, handlers, cv, anim, board, screen, botHit, K, scene, ins, fg, hitsFor };
}
const ev = (x = 10, y = 10, button = 0) => ({ clientX: x, clientY: y, button });

test('host: a click where a monitor stands in front of a board acts once, on the nearer one', () => {
  const s = fakeStage({ board: 9, screen: 4 });
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const calls = [];
  host.register({ name: 'board', active: () => true, meshes: () => [s.board], itemOf: () => ({ k: 'board' }), hover: () => {}, click: () => calls.push('board') });
  host.register({ name: 'terminal', active: () => true, meshes: () => [s.screen], itemOf: () => ({ k: 'term' }), hover: () => {}, click: () => calls.push('terminal') });
  s.handlers.pointerdown(ev()); s.handlers.pointerup(ev());
  assert.deepEqual(calls, ['terminal']);
  host.dispose();
});

test('host: a bot in front of the item takes the click (the engine handles it)', () => {
  const s = fakeStage({ board: 9, bot: 2 });
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const calls = [];
  host.register({ name: 'board', active: () => true, meshes: () => [s.board], itemOf: () => ({}), hover: () => {}, click: () => calls.push('board') });
  s.handlers.pointerdown(ev()); s.handlers.pointerup(ev());
  assert.deepEqual(calls, []);
  host.dispose();
});

test('host: a drag is not a click, and an inactive target is not picked', () => {
  const s = fakeStage({ board: 3, screen: 5 });
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const calls = []; let boardOn = true;
  host.register({ name: 'board', active: () => boardOn, meshes: () => [s.board], itemOf: () => ({}), hover: () => {}, click: () => calls.push('board') });
  host.register({ name: 'terminal', active: () => true, meshes: () => [s.screen], itemOf: () => ({}), hover: () => {}, click: () => calls.push('terminal') });
  s.handlers.pointerdown(ev(10, 10)); s.handlers.pointerup(ev(40, 40));
  assert.deepEqual(calls, []);
  boardOn = false;
  s.handlers.pointerdown(ev()); s.handlers.pointerup(ev());
  assert.deepEqual(calls, ['terminal']);
  host.dispose();
});

test('host: the host owns the cursor and clears only its own pointer', () => {
  const s = fakeStage({ board: 3 });
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const hovers = [];
  host.register({ name: 'board', active: () => true, meshes: () => [s.board], itemOf: () => ({ k: 1 }), hover: (i) => hovers.push(i ? 'on' : 'off'), click: () => {} });
  s.handlers.pointermove(ev());
  s.anim[0](0.016, 0);
  assert.equal(s.cv.style.cursor, 'pointer');
  assert.deepEqual(hovers, ['on']);
  s.handlers.pointerleave();
  assert.equal(s.cv.style.cursor, '');
  assert.deepEqual(hovers, ['on', 'off']);
  s.cv.style.cursor = 'grab';   // someone else's cursor stays
  host.leave();
  assert.equal(s.cv.style.cursor, 'grab');
  host.dispose();
});

test('host: the rebuild event fires before the frames, with the reason', () => {
  const s = fakeStage({});
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const order = [];
  host.onRebuild((why) => order.push('rebuild:' + why.join(',')));
  host.frame(() => order.push('frame'));
  s.anim[0](0.016, 0);
  assert.deepEqual(order, ['frame']);
  s.ins.bots = [...s.ins.bots];
  s.anim[0](0.016, 0.016);
  assert.deepEqual(order, ['frame', 'rebuild:bots', 'frame']);
  host.dispose();
  assert.equal(s.anim.length, 0);
});

test('host: an anchor that left the scene is a rebuild', () => {
  const s = fakeStage({});
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const why = [];
  const lost = node({ isMesh: true });
  host.register({ name: 't', active: () => true, meshes: () => [], itemOf: () => null, hover: () => {}, click: () => {}, anchors: () => [lost] });
  host.onRebuild((w) => why.push(w.join(',')));
  s.anim[0](0.016, 0);
  assert.deepEqual(why, ['gone']);
  host.dispose();
});

test('host: view and rooms come from the floor groups and the building', () => {
  const s = fakeStage({});
  const fg = s.scene.children[0];
  const host = globalThis.OfficeSceneHost.attach({ ...s.office, getBuilding: () => ({ floors: [{ id: 1, rooms: [{ id: 'r1', type: 'lab' }] }] }) });
  assert.equal(host.view(), 'floor');
  assert.equal(host.inBuilding(), false);
  fg.children.push(Object.assign(roomGroup(0, 'a'), { parent: fg }));
  assert.deepEqual(host.rooms().map((x) => x.room.id), ['r1']);
  fg.visible = false;
  assert.equal(host.inBuilding(), true);
  assert.deepEqual(host.rooms(), []);
  host.dispose();
});

// ---------- focus: look first, then open ----------
const plain = (key, open = false) => ({ key, open });

test('focus steps: a click looks, a second click on the same screen opens, another screen is looked at', () => {
  let r = P.focusStep(null, { type: 'click', key: 'board:r1' });
  assert.deepEqual(r, { state: plain('board:r1'), act: 'look' });
  r = P.focusStep(r.state, { type: 'click', key: 'board:r1' });
  assert.deepEqual(r, { state: plain('board:r1', true), act: 'open' });
  r = P.focusStep(r.state, { type: 'click', key: 'board:r1' });   // open: a click shows it again
  assert.deepEqual(r, { state: plain('board:r1', true), act: 'open' });
  r = P.focusStep(r.state, { type: 'click', key: 'notes:r1' });   // another screen: step 1 for that one
  assert.deepEqual(r, { state: plain('notes:r1'), act: 'look' });
});

test('focus steps: Esc or Back and a click on empty scene go back; nothing to do without a screen in focus', () => {
  const looking = plain('stats:r1'), open = plain('stats:r1', true);
  assert.deepEqual(P.focusStep(looking, { type: 'back' }), { state: plain(null), act: 'back' });
  assert.deepEqual(P.focusStep(open, { type: 'back' }), { state: plain(null), act: 'back' });
  assert.deepEqual(P.focusStep(looking, { type: 'empty' }), { state: plain(null), act: 'back' });
  assert.deepEqual(P.focusStep(plain(null), { type: 'back' }), { state: plain(null), act: null });
  assert.deepEqual(P.focusStep(null, { type: 'empty' }), { state: plain(null), act: null });
  assert.deepEqual(P.focusStep(looking, { type: 'click', key: null }), { state: looking, act: null });
});

test('free rect: a side column cuts its side, a band cuts its edge, with the gap; a cover off the view does nothing', () => {
  const view = { left: 0, top: 0, right: 1000, bottom: 800 };
  const covers = [
    { left: 10, top: 10, right: 990, bottom: 50 },     // top bar
    { left: 10, top: 60, right: 200, bottom: 500 },    // left column
    { left: 800, top: 60, right: 990, bottom: 300 },   // right column
    { left: 300, top: 700, right: 700, bottom: 780 },  // dock
    { left: 1100, top: 0, right: 1200, bottom: 800 }   // off the view
  ];
  assert.deepEqual(P.freeRect(view, covers, 8), { left: 208, top: 58, right: 792, bottom: 692 });
  assert.deepEqual(P.freeRect(view, [], 8), view);
  assert.deepEqual(P.freeRect(view, null, 8), view);
});

test('free rect: the box that shows the item largest, not the largest box; covers in any order', () => {
  const view = { left: 0, top: 0, right: 1000, bottom: 1000 };
  const block = { left: 500, top: 0, right: 1000, bottom: 600 };
  assert.deepEqual(P.freeRect(view, [block], 0), { left: 0, top: 0, right: 500, bottom: 1000 }, 'no aspect: the largest area (the column)');
  assert.deepEqual(P.freeRect(view, [block], 0, 1.6), { left: 0, top: 600, right: 1000, bottom: 1000 }, 'a wide board: the band below');
  // a small column in a corner and a short panel: the result does not depend on the order of the covers
  const covers = [{ left: 1072, top: 68, right: 1344, bottom: 226 }, { left: 1024, top: 645, right: 1060, bottom: 886 }, { left: 16, top: 12, right: 1344, bottom: 52 }, { left: 16, top: 68, right: 236, bottom: 583 }, { left: 362, top: 743, right: 984, bottom: 824 }];
  const v2 = { left: 0, top: 0, right: 1360, bottom: 900 };
  const one = P.freeRect(v2, covers, 8, 1.7), two = P.freeRect(v2, covers.slice().reverse(), 8, 1.7);
  assert.deepEqual(one, two);
  assert.deepEqual(one, { left: 244, top: 60, right: 1064, bottom: 637 }, 'above the zoom column: a wider box beats a taller one');
});

test('free rect: on a phone the panels are bands, so they cut the top and the bottom', () => {
  const view = { left: 0, top: 0, right: 400, bottom: 860 };
  const covers = [{ left: 16, top: 12, right: 384, bottom: 144 }, { left: 16, top: 154, right: 384, bottom: 201 }, { left: 16, top: 477, right: 384, bottom: 690 }, { left: 16, top: 698, right: 384, bottom: 848 }];
  assert.deepEqual(P.freeRect(view, covers, 8), { left: 0, top: 209, right: 400, bottom: 469 });
});

// A plane facing +z: half width along x, half height along y.
const board = { c: [5, 2, -3], n: [0, 0, 1], ax: [2, 0, 0], ay: [0, 1.25, 0] };
const camOf = (extra = {}) => ({ dist: 60, span: 20, h: 900, minPolar: 0.35, maxPolar: 1.25, back: [1, 1, 1], ...extra });
const view = { left: 0, top: 0, right: 1360, bottom: 900 };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// where a world point lands on screen for a pose (an orthographic camera looks at the target, centered in the view)
function screenOf(pose, cam, p) {
  const wpp = cam.span / (pose.zoom * cam.h), d = [p[0] - pose.target[0], p[1] - pose.target[1], p[2] - pose.target[2]];
  return [(view.left + view.right) / 2 + dot(d, pose.right) / wpp, (view.top + view.bottom) / 2 - dot(d, pose.up) / wpp];
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('frame pose: the screen fills the fill share of the limiting side, faces the camera, inside the polar range', () => {
  const cam = camOf(), pose = P.framePose(board, cam, view, view, 0.88);
  const left = screenOf(pose, cam, [3, 2, -3]), right = screenOf(pose, cam, [7, 2, -3]);
  assert.ok(near(right[0] - left[0], 0.88 * 1360, 1e-6), 'width is 88% of the view: ' + (right[0] - left[0]));
  assert.ok(near(screenOf(pose, cam, board.c)[0], 680) && near(screenOf(pose, cam, board.c)[1], 450), 'centered');
  assert.ok(near(Math.acos(pose.dir[1]), 1.25), 'polar clamped to the controls max');
  assert.ok(pose.dir[2] > 0.9, 'in front of the board');
  assert.ok(near(Math.hypot(pose.pos[0] - pose.target[0], pose.pos[1] - pose.target[1], pose.pos[2] - pose.target[2]), 60), 'the camera keeps its distance');
  // a tall view: the width still limits; a wide flat view: the height limits
  const flat = P.framePose(board, cam, view, { left: 0, top: 0, right: 1360, bottom: 300 }, 0.88);
  const top = screenOf(flat, cam, [5, 3.25, -3]), bottom = screenOf(flat, cam, [5, 0.75, -3]);
  assert.ok(near(bottom[1] - top[1], 0.88 * 300, 1e-6), 'height is 88% of the free height: ' + (bottom[1] - top[1]));
});

test('frame pose: the screen sits in the middle of the free part, not of the view', () => {
  const cam = camOf(), free = { left: 244, top: 60, right: 1016, bottom: 735 };
  const pose = P.framePose(board, cam, view, free, 0.88);
  const c = screenOf(pose, cam, board.c);
  assert.ok(near(c[0], (244 + 1016) / 2) && near(c[1], (60 + 735) / 2), 'center ' + c);
  const w = screenOf(pose, cam, [7, 2, -3])[0] - screenOf(pose, cam, [3, 2, -3])[0];
  assert.ok(near(w, 0.88 * 772), 'width ' + w);
  // a free part too small to use: the view
  const tiny = P.framePose(board, cam, view, { left: 0, top: 0, right: 40, bottom: 40 }, 0.88);
  assert.ok(near(screenOf(tiny, cam, board.c)[0], 680));
});

test('frame pose: a screen that tilts back is seen inside the polar range; a flat one uses the camera side', () => {
  const t = 0.2, tilted = { ...board, n: [0, Math.sin(t), Math.cos(t)], ay: [0, 1.25 * Math.cos(t), -1.25 * Math.sin(t)] };
  const cam = camOf({ maxPolar: 1.5 });
  assert.ok(near(Math.acos(P.framePose(tilted, cam, view, view, 0.88).dir[1]), Math.PI / 2 - t), 'face on when the range allows it');
  const flat = { ...board, n: [0, 1, 0] };
  const pose = P.framePose(flat, camOf({ back: [0, 1, -1] }), view, view, 0.88);
  assert.ok(near(Math.acos(pose.dir[1]), 0.35) && pose.dir[2] < 0, 'from the camera side, at the min polar');
});

// ---------- the browser part: clicks run the steps, the host flies the camera ----------
const v3 = (x, y, z) => ({ x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } });
// a plane mesh centered at (x, y, z), facing +z
function screenMesh(name, x = 0, y = 2, z = 0, w = 4, h = 2.5) {
  return node({ name, isMesh: true, geometry: { type: 'PlaneGeometry', parameters: { width: w, height: h } }, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] }, updateWorldMatrix() {} });
}
function focusStage(hitsFor) {
  const s = fakeStage(hitsFor);
  const a = screenMesh('a', 0), b = screenMesh('b', 10);
  [a, b].forEach((m) => { m.parent = s.fg; s.fg.children.push(m); });
  Object.assign(s.ins.stage.cam, { position: v3(30, 40, 60), zoom: 1, top: 10, bottom: -10, updateProjectionMatrix() {} });
  s.ins.stage.ctl = { target: v3(0, 0, 0), enabled: true, minPolarAngle: 0.35, maxPolarAngle: 1.25, maxZoom: 4 };
  s.ins.stage.goal = null;
  return Object.assign(s, { a, b, stage: s.ins.stage });
}
// two screens and a door; look() gives a spec for the screens
function screens(s, log) {
  const items = { a: { id: 'a', mesh: s.a }, b: { id: 'b', mesh: s.b }, door: { id: 'door', mesh: s.board } };
  const t = {
    name: 'board', active: () => true, meshes: () => [s.a, s.b, s.board], itemOf: (m) => items[m.name === 'board' ? 'door' : m.name],
    hover: () => {}, click: (it) => log.push('click:' + it.id), open: (it) => log.push('open:' + it.id),
    look: (it) => (it.id === 'door' ? null : { key: 'k:' + it.id, mesh: it.mesh, verb: 'Open ' + it.id, kind: 'board' }),
    find: (key) => { const it = items[key.slice(2)]; return it ? { item: it, mesh: it.mesh } : null; }
  };
  return { t, items };
}
const click = (s) => { s.handlers.pointerdown(ev()); s.handlers.pointerup(ev()); };
const land = (s) => { for (let i = 0; i < 3; i++) s.anim[0](1, i); };   // 1 s frames: any flight lands

test('host: the first click on a screen flies to it, the second opens it', () => {
  const s = focusStage({ a: 5 }), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  host.register(screens(s, log).t);
  const seen = [];
  host.onFocus((f) => seen.push(f && [f.key, f.open, f.verb]));
  click(s);
  assert.deepEqual(log, []);
  assert.equal(host.focused().key, 'k:a');
  assert.equal(host.focused().open, false);
  assert.equal(host.flying(), true);
  assert.equal(s.stage.ctl.enabled, false, 'the controls wait for the landing');
  land(s);
  assert.equal(host.flying(), false);
  assert.equal(s.stage.ctl.enabled, true, 'after the flight the camera is the user\'s again');
  assert.ok(s.stage.cam.zoom > 1, 'zoomed in on the screen');
  assert.ok(s.stage.ctl.maxZoom >= s.stage.cam.zoom, 'the wheel can zoom on from there');
  click(s);
  assert.deepEqual(log, ['open:a']);
  assert.equal(host.focused().open, true);
  assert.deepEqual(seen, [['k:a', false, 'Open a'], ['k:a', true, 'Open a']]);
  host.dispose();
});

test('host: another screen is looked at, and Back flies to the camera of the room', () => {
  const s = focusStage({ a: 5 }), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  host.register(screens(s, log).t);
  const room = [s.stage.cam.position.x, s.stage.cam.position.y, s.stage.cam.position.z, s.stage.cam.zoom];
  click(s); land(s);
  const atA = s.stage.ctl.target.x;
  s.hitsFor.a = undefined; s.hitsFor.b = 5;
  click(s); land(s);
  assert.equal(host.focused().key, 'k:b');
  assert.equal(host.focused().open, false);
  assert.ok(s.stage.ctl.target.x > atA + 5, 'the camera moved to b');
  host.blur();
  assert.equal(host.focused(), null);
  land(s);
  assert.deepEqual([s.stage.cam.position.x, s.stage.cam.position.y, s.stage.cam.position.z, s.stage.cam.zoom], room);
  assert.equal(s.stage.ctl.maxZoom, 4, 'the max zoom is the DS value again');
  assert.deepEqual(log, []);
  host.dispose();
});

test('host: a click on empty scene flies back; a click on a bot is the engine\'s', () => {
  const s = focusStage({ a: 5 }), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  host.register(screens(s, log).t);
  click(s); land(s);
  s.hitsFor.a = undefined; s.hitsFor.bot = 3;
  click(s);
  assert.equal(host.focused().key, 'k:a', 'a bot under the pointer: the focus stays');
  s.hitsFor.bot = undefined;
  click(s);
  assert.equal(host.focused(), null);
  assert.equal(host.flying(), true);
  host.dispose();
});

test('host: the door is one click, and the open button is the second step', () => {
  const s = focusStage({ board: 5 }), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  host.register(screens(s, log).t);
  click(s);
  assert.deepEqual(log, ['click:door']);
  assert.equal(host.focused(), null);
  host.open();
  assert.deepEqual(log, ['click:door'], 'nothing in focus: nothing to open');
  s.hitsFor.board = undefined; s.hitsFor.a = 5;
  click(s);
  host.open();
  assert.deepEqual(log, ['click:door', 'open:a']);
  host.dispose();
});

test('host: the keyboard path takes both steps at once, and from another screen flies straight on', () => {
  const s = focusStage({}), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const sc = screens(s, log);
  host.register(sc.t);
  const room = s.stage.cam.position.x;
  assert.equal(host.show(sc.t, sc.items.a, true), true);
  assert.deepEqual(log, ['open:a']);
  assert.equal(host.focused().key, 'k:a');
  assert.equal(host.focused().open, true);
  land(s);
  assert.equal(host.show(sc.t, sc.items.b, true), true);
  assert.deepEqual(log, ['open:a', 'open:b']);
  assert.equal(host.focused().key, 'k:b');
  assert.equal(host.show(sc.t, sc.items.door, true), false, 'the door has no screen');
  assert.equal(host.show({ look: () => null }, sc.items.a, true), false, 'not a registered target');
  host.blur(); land(s);
  assert.equal(s.stage.cam.position.x, room, 'Back goes to the room, not to a');
  host.dispose();
});

test('host: with clear the camera lands close to the screen, and steps back out before it flies home', () => {
  const s = focusStage({ a: 5 }), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const sc = screens(s, log), look0 = sc.t.look;
  sc.t.look = (it) => Object.assign(look0(it), { clear: 0.5 });
  host.register(sc.t);
  const p = s.stage.cam.position, t = s.stage.ctl.target, dist = () => Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
  const room = [p.x, p.y, p.z], far = dist();
  click(s);
  s.anim[0](0.001, 0);
  assert.ok(dist() > far * 0.9, 'far during the flight: nothing is cut on the way');
  land(s);
  assert.ok(Math.abs(dist() - 0.5) < 1e-9, 'close after the landing: ' + dist());
  const zoomed = s.stage.cam.zoom;
  host.blur();
  s.anim[0](0.001, 0);
  assert.ok(dist() > far * 0.9, 'out on the line of sight first');
  assert.ok(Math.abs(s.stage.cam.zoom - zoomed) < 0.01, 'the picture did not jump');
  land(s);
  assert.deepEqual([p.x, p.y, p.z], room);
  host.dispose();
});

test('host: a side panel frames the screen again beside it; a panel over the view keeps the camera', () => {
  const s = focusStage({ a: 5 }), log = [];
  s.cv.clientHeight = 800; s.cv.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });
  let covers = [];
  const host = globalThis.OfficeSceneHost.attach(s.office, { covers: () => covers });
  host.register(screens(s, log).t);
  click(s); land(s);
  const z = s.stage.cam.zoom, x = s.stage.ctl.target.x;
  covers = [{ left: 0, top: 0, right: 1000, bottom: 780 }];   // a phone: the panel takes the view
  host.refit();
  assert.equal(host.flying(), false);
  assert.equal(s.stage.cam.zoom, z);
  covers = [{ left: 600, top: 0, right: 1000, bottom: 800 }];   // a side panel on the right
  host.refit();
  assert.equal(host.flying(), true);
  land(s);
  assert.ok(s.stage.cam.zoom < z, 'smaller, so it fits beside the panel');
  assert.ok(s.stage.ctl.target.x > x, 'the screen moves left on screen: the camera target moves right');
  host.dispose();
});

test('host: the engine does not reframe while a screen is in focus', () => {
  const s = focusStage({ a: 5 }), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  host.register(screens(s, log).t);
  s.stage.goal = { t: 1 };
  s.anim[0](0.016, 0);
  assert.deepEqual(s.stage.goal, { t: 1 }, 'no focus: the engine frames');
  click(s); land(s);
  assert.equal(s.stage.goal, null, 'a goal from before the look is cleared');
  s.stage.goal = { t: 2 };   // the HUD sets a new inset after a bot is selected: frameFloor()
  assert.equal(s.stage.goal, null, 'held back where it is set, so not even one frame moves the camera');
  s.anim[0](0.016, 0);
  assert.equal(s.stage.goal, null);
  host.blur(); land(s);
  s.stage.goal = { t: 3 };
  assert.deepEqual(s.stage.goal, { t: 3 }, 'no focus: the engine frames again');
  host.dispose();
  s.stage.goal = { t: 4 };
  assert.deepEqual(Object.getOwnPropertyDescriptor(s.stage, 'goal'), { value: { t: 4 }, writable: true, enumerable: true, configurable: true }, 'dispose gives the stage its plain property back');
});

// The engine's own frame and goal step (components/bundle.js), on the focus stage: under reduced motion every move is
// still a goal, so the host holds it back while a screen is in focus (#36).
const bundleSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'bundle.js'), 'utf8').replace(/\r\n/g, '\n');
function engineFn(start) {
  const at = bundleSrc.indexOf(start);
  assert.ok(at >= 0 && bundleSrc.indexOf(start, at + 1) === -1, `bundle has ${start} once`);
  return bundleSrc.slice(at, bundleSrc.indexOf('};\n', at) + 3);
}
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}
function engineStage(s) {
  const proto = {};
  new Function('T', 'Stage', 'DUR', engineFn('Stage.prototype.frame=function') + engineFn('Stage.prototype.goalStep=function'))({ Vector3: V3 }, { prototype: proto }, { camera: 600 });
  const st = s.stage;
  Object.assign(st, { rm: true, D: 11, sunOff: null, ext: null, frame: proto.frame, goalStep: proto.goalStep,
    sun: { position: new V3(), target: { position: new V3() } }, shadowFit() {}, resize() {}, fitD() { return 7; } });
  st.ctl.target = new V3(0, 0, 0);
  st.cam.position = new V3(30, 40, 60);
  // one frame of the stage loop: the goal step, then the page's frames (st.anim)
  return (dt = 0.016) => { if (st.goal) st.goalStep(dt); s.anim.forEach((f) => f(dt, 0)); };
}
const at3 = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e6);

test('host + engine, reduced motion: a move cuts in one frame, and is held while a screen is in focus (#36)', () => {
  const s = focusStage({ a: 5 }), log = [];
  const frameOnce = engineStage(s), st = s.stage;
  const host = globalThis.OfficeSceneHost.attach(s.office);
  host.register(screens(s, log).t);
  st.frame([1, 2, 3], 9, 1);   // setFloor or setView: no focus, the camera cuts
  frameOnce();
  assert.equal(st.goal, null);
  assert.deepEqual(at3(st.ctl.target), [1, 2, 3]);
  click(s); land(s);
  assert.ok(host.focused(), 'a screen is in focus');
  const t0 = at3(st.ctl.target), p0 = at3(st.cam.position), z0 = st.cam.zoom, d0 = st.D;
  st.frame([9, 0, 9], 5, 1);   // a bot joins (frameFloor) or the HUD inset changes (setFrameInset)
  frameOnce(); frameOnce();
  assert.equal(st.goal, null, 'the goal is held');
  assert.deepEqual(at3(st.ctl.target), t0, 'the camera stays on the screen');
  assert.deepEqual(at3(st.cam.position), p0);
  assert.equal(st.cam.zoom, z0);
  assert.equal(st.D, d0);
  host.blur(); land(s);
  st.frame([2, 0, 2], 9, 1);
  frameOnce();
  assert.deepEqual(at3(st.ctl.target), [2, 0, 2], 'no focus: the next move cuts again');
  host.dispose();
});

test('host: after a rebuild the focus follows the new mesh; a screen that is gone flies back', () => {
  const s = focusStage({ a: 5 }), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const sc = screens(s, log);
  host.register(sc.t);
  click(s); land(s);
  const a2 = screenMesh('a', 0);
  a2.parent = s.fg; s.fg.children.push(a2);
  sc.items.a = { id: 'a2', mesh: a2 };
  s.ins.bots = [...s.ins.bots];   // a bot joined: the engine rebuilt the floor
  s.anim[0](0.016, 0);
  assert.equal(host.focused().item.id, 'a2');
  assert.equal(host.flying(), false);
  delete sc.items.a;
  s.ins.bots = [...s.ins.bots];
  s.anim[0](0.016, 0);
  assert.equal(host.focused(), null);
  assert.equal(host.flying(), true, 'same floor: back to the room camera');
  host.dispose();
});

test('host: a theme change frames the floor at once; the camera goes back on the screen in the same frame', () => {
  const s = focusStage({ a: 5 }), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  host.register(screens(s, log).t);
  click(s); land(s);
  const z = s.stage.cam.zoom, x = s.stage.ctl.target.x;
  s.stage.cam.zoom = 1; s.stage.ctl.target.set(-5, 1, 0);   // the engine's rebuildAll: frameFloor(true)
  s.K.tok = {};                                             // new theme tokens
  s.anim[0](0.016, 0);
  assert.equal(host.flying(), false);
  assert.ok(Math.abs(s.stage.cam.zoom - z) < 1e-9 && Math.abs(s.stage.ctl.target.x - x) < 1e-9, 'back on the screen');
  assert.equal(host.focused().key, 'k:a');
  host.dispose();
});

test('host: when the floor is no longer shown the focus lets go without a flight', () => {
  const s = focusStage({ a: 5 }), log = [];
  const host = globalThis.OfficeSceneHost.attach(s.office);
  host.register(screens(s, log).t);
  const seen = [];
  host.onFocus((f) => seen.push(f ? f.key : null));
  click(s); land(s);
  s.fg.visible = false;   // the building view
  s.stage.goal = { building: true };   // the engine frames the building: held while the screen is in focus
  s.anim[0](0.016, 0);
  assert.equal(host.focused(), null);
  assert.equal(host.flying(), false);
  assert.equal(s.stage.ctl.enabled, true);
  assert.deepEqual(s.stage.goal, { building: true }, 'the held goal runs: the engine frames the building');
  assert.deepEqual(seen, ['k:a', null]);
  host.dispose();
});

test('host: with reduced motion a flight lands in one frame', () => {
  const s = focusStage({ a: 5 }), log = [];
  s.stage.rm = true;
  const host = globalThis.OfficeSceneHost.attach(s.office);
  host.register(screens(s, log).t);
  click(s);
  s.anim[0](0.016, 0);
  assert.equal(host.flying(), false);
  host.dispose();
});
