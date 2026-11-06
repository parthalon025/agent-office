// Desk actions (#90): the rules of the approval paper and the question note, the hit areas, and Ctrl+K for every action of the scene.
// The pure part of public/desk.js; the building store's targets are in test/building.test.mjs. No browser. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../public/scene-host.js';
import '../public/screen-kit.js';
import '../public/desk.js';

const D = globalThis.OfficeDesk.pure, H = globalThis.OfficeSceneHost.pure;
const low = { id: 'r1', uid: 'u1', bot: 'Ada', tool: 'Bash', text: 'Allow Bash: ls?', high: false, always: 'Bash(ls *)', t: 1000, until: 61000 };
const high = { ...low, id: 'r2', high: true, always: null, tool: 'Bash', text: 'Allow Bash: rm -rf x?' };

test('a low-risk paper answers at the Approve stamp; Decline answers no; Always allow answers yes with the rule', () => {
  assert.deepEqual(D.step({}, low, 'approve').act, { allow: true, always: false });
  assert.deepEqual(D.step({}, low, 'decline').act, { allow: false, always: false });
  assert.deepEqual(D.step({}, low, 'always').act, { allow: true, always: true });
  assert.equal(D.step({}, { ...low, always: null }, 'always').act, null, 'no rule offered: no Always allow');
  assert.equal(D.step({}, low, 'confirm').act, null, 'a low-risk paper has no Confirm');
});

test('a high-risk paper needs two different controls, Approve then Confirm, and never takes Always allow', () => {
  const a = D.step({}, high, 'approve');
  assert.equal(a.act, null, 'the Approve stamp alone answers nothing');
  assert.equal(a.stages.r2, 'confirm');
  assert.equal(D.step(a.stages, high, 'approve').act, null, 'a second click on the Approve spot does nothing');
  assert.equal(D.step({}, high, 'confirm').act, null, 'Confirm before Approve does nothing');
  const c = D.step(a.stages, high, 'confirm');
  assert.deepEqual(c.act, { allow: true, always: false });
  assert.equal(c.stages.r2, undefined, 'the stage is gone once it answered');
  assert.equal(D.step({}, high, 'always').act, null, 'never Always allow for high risk');
  assert.equal(D.step({}, { ...high, always: 'Bash(rm *)' }, 'always').act, null, 'not even when the request names a rule');
  assert.deepEqual(D.step(a.stages, high, 'decline').act, { allow: false, always: false }, 'Decline is one click in any stage');
  assert.equal(D.step(a.stages, high, 'cancel').stages.r2, undefined, 'Cancel goes back to the first stage');
  assert.equal(D.plan(high, 'ask', false).some((c) => c.id === 'always'), false, 'the paper does not draw Always allow');
});

test('the Approve stamp and the Confirm are two spots: their hit areas never overlap, at any size the paper has on screen', () => {
  for (const narrow of [false, true]) for (const w of [260, 360, 480, 640, 900]) {
    const plane = { w, h: w * 0.75 };
    const ap = D.plan(high, 'ask', narrow).find((c) => c.id === 'approve'), cf = D.plan(high, 'confirm', narrow).find((c) => c.id === 'confirm');
    const A = H.hitBox(ap.rect, plane, D.HIT), C = H.hitBox(cf.rect, plane, D.HIT);
    const apart = A.left + A.width <= C.left || C.left + C.width <= A.left || A.top + A.height <= C.top || C.top + C.height <= A.top;
    assert.ok(apart, `Approve and Confirm overlap at ${w} px (narrow ${narrow})`);
    // in the confirm stage the Approve spot holds no control that answers yes
    const centre = { x: ap.rect.x + ap.rect.w / 2, y: ap.rect.y + ap.rect.h / 2 };
    const hit = H.hitAt(D.plan(high, 'confirm', narrow), centre, plane, D.HIT);
    assert.ok(hit !== 'confirm', 'the Approve spot is not the Confirm');
  }
});

test('every control has a hit area of at least 44 px after the focus, in both layouts', () => {
  for (const narrow of [false, true]) for (const paper of [low, high]) for (const stage of ['ask', 'confirm']) for (const w of [200, 360, 640]) {
    D.plan(paper, stage, narrow).forEach((c) => {
      const b = H.hitBox(c.rect, { w, h: w * 0.75 }, D.HIT);
      assert.ok(b.width >= 44 && b.height >= 44, `${c.id} ${b.width}x${b.height} at ${w} px`);
    });
  }
});

test('below 600 px a paper shows one large action: Approve, or Confirm, full width, and a Decline strip', () => {
  const area = (c) => c.rect.w * c.rect.h;
  const ask = D.plan(low, 'ask', true);
  assert.deepEqual(ask.map((c) => c.id), ['approve', 'decline'], 'no Always allow strip at this width');
  assert.ok(ask[0].rect.w >= 0.9 && area(ask[0]) > area(ask[1]), 'Approve is the large action');
  const conf = D.plan(high, 'confirm', true);
  assert.ok(conf.find((c) => c.id === 'confirm').rect.w >= 0.9, 'Confirm is the large action');
  assert.equal(D.NARROW, 600);
  assert.deepEqual(D.plan(low, 'ask', false).map((c) => c.id).sort(), ['always', 'approve', 'decline']);
});

test('the paper shows the time left before the hold ends', () => {
  assert.equal(D.timeLeft(61000, 1000), '60 s left');
  assert.equal(D.timeLeft(61000, 60500), '1 s left');
  assert.equal(D.timeLeft(1000 + 15 * 60000, 1000), '15 min left');
  assert.equal(D.timeLeft(1000, 2000), 'Timed out');
  assert.equal(D.timeLeft(0, 2000), '', 'a request with no deadline says nothing');
  assert.equal(D.spent(low, 1000), 0);
  assert.equal(D.spent(low, 31000), 0.5);
  assert.equal(D.spent(low, 99000), 1);
});

// The test the issue asks for: every action of an object in the scene has a Ctrl+K entry.
test('every in-scene action is in the Ctrl+K list', () => {
  const targets = { papers: [low, high], notes: [{ uid: 'u1', bot: 'Ada', id: 'q1', text: 'Which branch?' }], empty: [{ floorKey: 'quality', name: 'Quality', roomId: 'spare-quality', role: 'reviewer' }] };
  const sessions = [{ uid: 'u1', name: 'Ada', headless: true, status: 'working', botName: 'Ada' }];
  const have = (stages) => new Set(D.paletteActions(targets, stages, sessions).map((a) => a.action));
  const all = new Set([...have({}), ...have({ r2: 'confirm' })]);
  for (const a of D.ACTIONS) assert.ok(all.has(a.id), 'Ctrl+K has ' + a.id);
  for (const id of all) assert.ok(D.ACTIONS.some((a) => a.id === id), 'ACTIONS lists ' + id);
  assert.equal(D.paletteActions(targets, {}, []).some((a) => a.action === 'paper-confirm'), false, 'Confirm only after Approve');
  assert.equal(D.paletteActions(targets, { r2: 'confirm' }, []).some((a) => a.action === 'paper-confirm' && a.ref.id === 'r2'), true);
  const always = D.paletteActions(targets, {}, []).filter((a) => a.action === 'paper-always');
  assert.deepEqual(always.map((a) => a.ref.id), ['r1'], 'a high-risk paper has no Always allow');
  assert.equal(D.paletteActions(targets, {}, [{ uid: 'u2', name: 'B', headless: false, status: 'working' }]).some((a) => a.action === 'pause'), false, 'the pause key is for a turn inside the office');
  // the page builds its Ctrl+K entries from this list and sends each action through the desk's own rules
  const office = fs.readFileSync(new URL('../public/office.js', import.meta.url), 'utf8');
  assert.match(office, /OfficeDesk\.pure\.paletteActions\(dt, dk \? dk\.stages\(\) : \{\}, dsess\)/);
  assert.match(office, /dk\.act\(a\.action, a\.ref\.id \|\| a\.ref\.uid\)/);
});

test('the desk adapter keeps the rules: one raycaster, no pointer listener, no cursor write, no camera move (the host owns them)', () => {
  const src = fs.readFileSync(new URL('../public/desk.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /new T\.Raycaster|addEventListener\(['"]pointer|addEventListener\(['"]mouse|\.style\.cursor|stage\.goal|ctl\.target/, 'only the scene host picks, sets the cursor and flies');
  assert.match(src, /host\.register\(target\)/, 'its pick target is registered with the scene host');
});

test('the page has no request bar and no open-session form on the desks any more', () => {
  const office = fs.readFileSync(new URL('../public/office.js', import.meta.url), 'utf8');
  assert.doesNotMatch(office, /RequestBar/);
  assert.match(office, /function deskStart\(roomId\)/, 'an open desk starts an agent at once');
  assert.doesNotMatch(office, /deskOpen/, 'no dialog from a desk');
});
