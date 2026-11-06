// The customization store (#152) through the office core, in process: starters, team templates, export and import, and that the
// export carries no Security rules. The office is the real one (src/office.mjs), called through core.handle: no spawned server.
// Run: node --test test/customization-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';

let base, rig;
const call = (route, body) => rig.call(route, body);

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cus-'));
  rig = await startInProcess({ dir: base });
});
after(async () => {
  if (rig) rig.stop();
  if (base) await removeTree(base);
});

test('starters add the three personas and one team, once; the user can add a team and start none without a folder', async () => {
  assert.equal((await call('/api/persona/starters', {})).json.added, 4);
  assert.equal((await call('/api/persona/starters', {})).json.added, 0);
  const list = (await call('/api/personas')).json;
  assert.deepEqual(Object.keys(list.personas).sort(), ['fixer', 'researcher', 'reviewer']);
  assert.equal(list.teams['fix and review'].members.length, 3);
  assert.equal((await call('/api/team/save', { name: 'Pair', members: ['Fixer', 'Reviewer'] })).status, 200);
  assert.equal((await call('/api/team/save', { name: 'Empty', members: [] })).status, 400);
  assert.equal((await call('/api/team/start', { team: 'nobody', cwd: base })).status, 404);
  const none = (await call('/api/team/start', { team: 'pair', cwd: path.join(base, 'missing') })).json;
  assert.equal(none.ok, false);
  // Off Windows, opening a session is refused before the folder check, so only the folder message is Windows-only.
  assert.ok(none.started.length === 2 && none.started.every((m) => m.error && (process.platform !== 'win32' || /Folder not found/.test(m.error))), 'each member reports its own error');
  assert.equal((await call('/api/open', { persona: 'nobody', cwd: base })).status, 404);
});

test('export, then import into a changed office: the setup comes back; Security rules are never in the file', async () => {
  await call('/api/persona/save', { name: 'Ada', style: 'fast', role: 'Fix bugs.', model: 'sonnet', color: 2 });
  assert.equal((await call('/api/security/set', { scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' })).status, 200);
  const out = (await call('/api/custom/export')).json;
  assert.equal(out.format, 'agent-office-customization');
  assert.equal(out.personas.ada.role, 'Fix bugs.');
  assert.equal('security' in out, false);
  await call('/api/persona/delete', { name: 'Ada' });
  await call('/api/team/delete', { name: 'Pair' });
  const dirty = { ...out, security: { office: { shell: 'allow' } }, personas: { ...out.personas, evil: { name: 'Evil', style: 'reckless', permissions: 'allow' } } };
  const r = (await call('/api/custom/import', { data: dirty })).json;
  assert.equal(r.ok, true);
  const list = (await call('/api/personas')).json;
  assert.equal(list.personas.ada.model, 'sonnet');
  assert.deepEqual(list.personas.evil, { name: 'Evil' });
  assert.ok(list.teams.pair);
  assert.equal((await call('/api/custom/import', { data: { format: 'other' } })).status, 400);
});

test('the wall screen of a room is set by the page route, shows in the lists and in the export, and a wrong view is 400', async () => {
  assert.equal((await call('/api/screen/set', { key: 'Lab-A', view: 'steps' })).status, 200);
  assert.equal((await call('/api/personas')).json.screens['lab-a'], 'steps');
  assert.equal((await call('/api/custom/export')).json.screens['lab-a'], 'steps');
  assert.equal((await call('/api/screen/set', { key: 'lab-a', view: 'weather' })).status, 400);
  assert.equal((await call('/api/screen/set', { key: '', view: 'steps' })).status, 400);
  assert.equal((await call('/api/screen/set', { key: 'lab-a', view: 'overview' })).status, 200);
  assert.equal((await call('/api/personas')).json.screens['lab-a'], undefined);
});
