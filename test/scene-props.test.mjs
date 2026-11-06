// #93 scene props: the pipeline board on the Reception wall and the paper props (trays, folder, stamp, cabinet, archive box) that a
// page fills. The pure part of public/lobby.js and the DS source. No browser. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../public/format.js';
import '../public/vocab.js';
import '../public/screen-kit.js';
import '../public/lobby.js';

const L = globalThis.OfficeLobby.pure;
const bundle = fs.readFileSync(new URL('../components/bundle.js', import.meta.url), 'utf8');

test('the pipeline board lists the eight stages; a stage with no data says so, and no read says why', () => {
  const stages = ['intake', 'build', 'check', 'review', 'gate', 'merge', 'release', 'record'].map((id, i) => ({ id, name: id[0].toUpperCase() + id.slice(1), count: i === 1 ? 3 : 0, unknown: id === 'intake' || id === 'release' }));
  const p = L.pipelineLines({ unknown: false, pipeline: stages, mergedToday: 2, folders: [], tray: [] });
  assert.equal(p.rows.length, 8);
  assert.equal(p.rows[0].text, 'No data');
  assert.equal(p.rows[1].text, '3');
  assert.equal(p.rows[1].count, 3);
  assert.equal(p.foot, '2 merged today');
  const u = L.pipelineLines({ unknown: true, line: 'Changes are not read yet.', pipeline: stages.map((s) => ({ ...s, count: 0, unknown: true })), folders: [], tray: [] });
  assert.ok(u.rows.every((r) => r.text === 'No data'));
  assert.equal(u.foot, 'Changes are not read yet.');
  assert.equal(L.pipelineLines(null).rows.length, 8, 'no data at all still draws the stages');
});

test('the props hold what the folders say: ready tray, inbox, outbox, cabinet, archive box', () => {
  const f = (place) => ({ place });
  const c = { unknown: false, tray: [{}, {}], mergedToday: 4, folders: [f('inbox'), f('inbox'), f('outbox'), f('cabinet'), f('archive'), f('desk')] };
  assert.deepEqual(L.propCounts(c), { ready: 2, inbox: 2, outbox: 1, cabinet: 1, archive: 1 });
  assert.deepEqual(L.propCounts(null), { ready: 0, inbox: 0, outbox: 0, cabinet: 0, archive: 0 });
  assert.deepEqual(L.propCounts({ unknown: true, tray: [], folders: [f('inbox')] }), { ready: 0, inbox: 0, outbox: 0, cabinet: 0, archive: 0 }, 'unknown shows empty props');
});

test('the DS has the paper props as parts, each with a count the page sets', () => {
  for (const p of ['tray', 'folder', 'stamp', 'cabinet', 'archiveBox']) assert.match(bundle, new RegExp('Parts\\.' + p + '='), p);
  assert.match(bundle, /userData\.lobby="pipeline"/, 'the Reception has the pipeline board');
  assert.match(bundle, /userData\.setCount=/, 'a prop takes its count');
  assert.match(bundle, /userData\.prop=/, 'a prop names its kind');
});

test('the lobby paints the pipeline board with FACES and reads the props from the page', () => {
  const src = fs.readFileSync(new URL('../public/lobby.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function paintPipeline('), src.indexOf('\n    }\n', src.indexOf('function paintPipeline(')));
  assert.ok(body.length > 60);
  assert.doesNotMatch(body, /tok\[['"]|tok\.[a-z]|#[0-9a-f]{3}\b/i, 'paints with FACES only');
  assert.match(body, /FACES\.pipeline/);
  assert.match(src, /o\.changes/, 'the page gives the changes of the building');
});
