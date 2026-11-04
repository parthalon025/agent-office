// Scene host: shown floor, view, room groups and rebuild detection on plain scene graphs (no THREE, no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
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
  const cv = { style: { cursor: '' }, addEventListener: (n, f) => { handlers[n] = f; }, removeEventListener: (n) => { delete handlers[n]; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
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
  return { office: { inspect: () => ins }, handlers, cv, anim, board, screen, botHit, K, scene, ins };
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

test('host: bypass consumes a click before the pick', () => {
  const s = fakeStage({ board: 3 });
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const calls = [];
  host.register({ name: 'board', active: () => true, meshes: () => [s.board], itemOf: () => ({}), hover: () => {}, click: () => calls.push('click'), bypass: () => { calls.push('bypass'); return true; } });
  s.handlers.pointerdown(ev()); s.handlers.pointerup(ev());
  assert.deepEqual(calls, ['bypass']);
  host.dispose();
});

test('host: a bypass that changes its own state does not let the click reach a target under the pointer', () => {
  const s = fakeStage({ board: 3 });
  const host = globalThis.OfficeSceneHost.attach(s.office);
  const calls = [];
  let open = true;
  host.register({ name: 'board', active: () => !open, meshes: () => [s.board], itemOf: () => ({}), hover: () => {}, click: () => calls.push('board'), bypass: () => { if (!open) return false; open = false; calls.push('closed'); return true; } });
  host.register({ name: 'terminal', active: () => true, meshes: () => [s.screen], itemOf: () => ({}), hover: () => {}, click: () => calls.push('terminal') });
  s.handlers.pointerdown(ev()); s.handlers.pointerup(ev());
  assert.deepEqual(calls, ['closed']);
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
