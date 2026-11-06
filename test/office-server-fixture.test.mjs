// The office-server fixture must never wait for ever: a child that cannot run, or a stuck one, ends in a failure (#122).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startOffice, settle, holdPort, closeHeld } from './fixtures/office-server.mjs';

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
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
  } finally { await closeHeld(); fs.rmSync(dir, { recursive: true, force: true }); }
});
