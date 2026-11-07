// The office-server fixture must never wait for ever: a child that cannot run, or a stuck one, ends in a failure (#122).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startOffice, settle, holdPort, close, closeHeld } from './fixtures/office-server.mjs';

const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('HANG'), ms))]);
const connects = (port) => new Promise((r) => {
  const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(true); });
  c.once('error', () => r(false));
});

test('startOffice: a child that cannot spawn settles exited and settle, no hang', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fx-'));
  try {
    const o = startOffice(dir, {}, { execPath: path.join(dir, 'no-such-node.exe'), ms: 5000 });
    assert.equal(await within(o.exited, 3000), null);
    const r = await within(settle(o, 5000), 6000);
    assert.notEqual(r, 'HANG');
    assert.equal(r.listening, false);
    assert.equal(await within(o.stop(), 3000), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
});

test('settle: a stuck child fails at the limit, and closeHeld closes every held port', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fx-'));
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  try {
    await holdPort(port);
    const script = path.join(dir, 'stuck.mjs');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const o = startOffice(dir, process.env, { script, ms: 60000 });
    await assert.rejects(within(settle(o, 500), 5000), /did not settle/);
    assert.equal(await connects(port), true);
    await closeHeld();
    assert.equal(await connects(port), false);
    await within(o.exited, 5000);
  } finally { await closeHeld(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
});

test('stop: ends the whole process tree by pid and waits for it (#161)', { timeout: 30000, skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fx-'));
  let kid = 0;
  try {
    const pidFile = path.join(dir, 'child.pid');
    const script = path.join(import.meta.dirname, 'fixtures', 'tree-parent.mjs');
    const o = startOffice(dir, { ...process.env, TREE_PID_FILE: pidFile }, { script, ms: 20000 });
    await o.done;
    kid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.equal(alive(kid), true);
    await o.stop();
    // Windows can report a process for a few ms after its exit; a live one stays for the whole wait.
    for (let i = 0; i < 100 && alive(kid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(kid), false, 'the child of the office must be gone after stop()');
  } finally {
    // A child that outlived stop() holds the folder: end it here, so the assertion above, not EBUSY, is what fails.
    if (kid) { try { process.kill(kid); } catch { /* gone */ }
      for (let i = 0; i < 40 && (() => { try { process.kill(kid, 0); return true; } catch { return false; } })(); i++) await new Promise((r) => setTimeout(r, 100)); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('stop: ends the child of an office that exited first (#161)', { timeout: 30000, skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fx-'));
  let kid = 0;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const pidFile = path.join(dir, 'child.pid');
    const script = path.join(import.meta.dirname, 'fixtures', 'tree-parent.mjs');
    const o = startOffice(dir, { ...process.env, TREE_PID_FILE: pidFile, TREE_PARENT_EXITS: '1' }, { script, ms: 20000 });
    await o.done;
    kid = Number(fs.readFileSync(pidFile, 'utf8'));
    await o.exited;
    assert.equal(alive(kid), true, 'the orphan runs after its parent exited');
    await o.stop();
    for (let i = 0; i < 100 && alive(kid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(kid), false, 'stop() must end the child of a parent that exited first');
  } finally {
    if (kid) { try { process.kill(kid); } catch { /* gone */ }
      for (let i = 0; i < 40 && alive(kid); i++) await new Promise((r) => setTimeout(r, 100)); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('close: a held port closes at once while a client keeps a keep-alive connection (#190)', { timeout: 20000 }, async () => {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  let client;
  try {
    const s = await holdPort(port);
    client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    await new Promise((r) => client.once('connect', r));
    client.setKeepAlive(true);
    await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(await within(close(s), 2000), 'HANG', 'close() must not wait for the client');
    assert.equal(await connects(port), false);
  } finally { client?.destroy(); await closeHeld(); }
});
