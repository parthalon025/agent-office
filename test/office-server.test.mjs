// The shared server start (test/fixtures/office-server.mjs, #98): ready on the server's own line, a fast failure when the
// server stops first, and a new port when the free port was taken between the guess and the bind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOffice, startOnFreePort, until, copyOffice } from './fixtures/office-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';

const tmpDir = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-start-')));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a temp folder may stay */ } };
const standIn = (dir, code) => { const f = path.join(dir, 'stand-in.mjs'); fs.writeFileSync(f, code); return f; };

test('startOffice: ready on the "is open" line, after the server has started', async () => {
  const dir = tmpDir();
  try {
    const o = startOffice(dir, process.env, { script: standIn(dir, "setTimeout(() => console.log('Agent Office is open: http://127.0.0.1:1/#n=x'), 200); setTimeout(() => {}, 60000);") });
    assert.equal(await o.done, 'open');
    assert.match(o.out(), /is open: /);
    await o.stop();
    assert.notEqual(o.child.exitCode ?? o.child.signalCode, null);
  } finally { rm(dir); }
});

test('startOffice: a server that stops first fails at once, with its output and the busy flag', async () => {
  const dir = tmpDir();
  try {
    const t0 = Date.now();
    const crash = startOffice(dir, process.env, { ms: 60000, script: standIn(dir, "console.error('boom'); process.exit(3);") });
    await assert.rejects(crash.done, (e) => /stopped \(3\)/.test(e.message) && /boom/.test(e.message) && e.busy === false);
    assert.ok(Date.now() - t0 < 30000, 'the wait did not run to its limit');
    const busy = startOffice(dir, process.env, { script: standIn(dir, "console.error('Agent Office stopped: port 1 for branch \"x\" is busy.'); process.exit(1);") });
    await assert.rejects(busy.done, (e) => e.busy === true);
    const twin = startOffice(dir, process.env, { script: standIn(dir, "console.log('Agent Office is already running on port 1. Nothing was changed.'); process.exit(0);") });
    assert.equal(await twin.done, 'exited');
  } finally { rm(dir); }
});

test('startOffice: a server that never says it is open fails at the limit, and the child is stopped', async () => {
  const dir = tmpDir();
  try {
    const o = startOffice(dir, process.env, { ms: 600, script: standIn(dir, 'setTimeout(() => {}, 60000);') });
    await assert.rejects(o.done, /did not say it is open in 600 ms/);
    await o.exited;
  } finally { rm(dir); }
});

test('until: gives the value, and names what it waited for with the log on timeout', async () => {
  let n = 0;
  assert.equal(await until(() => (++n > 2 ? 'ok' : null), 'a value', { step: 1 }), 'ok');
  await assert.rejects(until(() => null, 'the thing', { ms: 30, step: 5, log: () => 'last line' }), /timed out waiting for the thing\nlast line/);
});

test('startOnFreePort: a port taken before the bind makes the server start again on a new port', { timeout: 180000 }, async () => {
  const dir = tmpDir();
  const blockers = [];
  let started = null;
  try {
    copyOffice(dir);
    const lad = path.join(dir, 'local');
    fs.mkdirSync(lad);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['path', 'office_id', 'office_port'].includes(k.toLowerCase())));
    Object.assign(env, {
      PATH: [path.dirname(process.execPath), ...(win ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [])].join(path.delimiter),
      OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(dir, 'roaming'), OFFICE_RATE_FILE: path.join(dir, 'no-rate.json'),
    });
    const tried = [];
    // The first two ports are taken by another program right after they were chosen: what a busy machine does.
    const prepare = async (port) => {
      tried.push(port);
      if (tried.length > 2) return;
      blockers.push(await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve(s)); }));
    };
    started = await startOnFreePort(dir, env, { prepare });
    assert.equal(tried.length, 3);
    assert.equal(started.port, tried[2]);
    assert.equal(started.env.OFFICE_PORT, String(tried[2]));
    assert.match(started.office.out(), new RegExp(`127\\.0\\.0\\.1:${tried[2]}/`));
  } finally {
    if (started) await started.office.stop();
    await Promise.all(blockers.map((s) => new Promise((r) => s.close(r))));
    await new Promise((r) => setTimeout(r, 300)); // let Windows release the folder
    rm(dir);
  }
});
