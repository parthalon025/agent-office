// The customization store (#152) against a real server.mjs copy: starters, team templates, export and import, and that the
// export carries no Security rules. Same rig as test/security-routes.test.mjs: a throwaway copy of the code on a free port.
// Run: node --test test/customization-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFile } from '../auth.mjs';
import { startOnFreePort } from './fixtures/office-server.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let base, office, port, pageToken;
const call = async (route, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-office-token': pageToken }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cus-'));
  const copy = path.join(base, 'office'), home = path.join(base, 'home');
  for (const d of [copy, home]) fs.mkdirSync(d);
  for (const f of fs.readdirSync(SRC)) {
    if (/\.(mjs|json|ps1)$/.test(f) && !/^(state|history)(-\d+)?\.json$/.test(f) && !f.startsWith('office-')) fs.copyFileSync(path.join(SRC, f), path.join(copy, f));
  }
  for (const d of ['providers', 'public']) fs.cpSync(path.join(SRC, d), path.join(copy, d), { recursive: true });
  const env = { ...process.env, OFFICE_HOOKS: 'command', OFFICE_RATE_FILE: path.join(base, 'no-rate.json'), OFFICE_OPEN: '0', LOCALAPPDATA: path.join(base, 'local'), USERPROFILE: home, HOME: home };
  const started = await startOnFreePort(copy, env);
  ({ office, port } = started);
  pageToken = JSON.parse(fs.readFileSync(pageFile(started.env, port), 'utf8')).token;
  assert.ok(pageToken, office.out().slice(-800));
});
after(async () => {
  if (office) await office.stop();
  await new Promise((r) => setTimeout(r, 300));
  if (base) fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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
