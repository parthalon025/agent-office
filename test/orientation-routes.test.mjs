// Orientation (#196) through the office core, in process: the view, a step marked done or skipped, a bad step is 400.
// No session opens, so this runs on every platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';

test('GET and POST /api/orientation/step', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-orient-'));
  let rig;
  try {
    rig = await startInProcess({ dir: base, state: { orientation: { seen: false, steps: { kinds: 'done' } } } });
    let r = await rig.call('/api/orientation');
    assert.equal(r.status, 200);
    assert.equal(r.json.steps.find((s) => s.id === 'kinds').status, 'done');
    assert.equal(r.json.next, 'security');
    r = await rig.call('/api/orientation/step', { step: 'spend', status: 'skipped' });
    assert.equal(r.status, 200);
    assert.equal(r.json.steps.find((s) => s.id === 'spend').status, 'skipped');
    r = await rig.call('/api/orientation/step', { seen: true });
    assert.equal(r.json.seen, true);
    assert.equal((await rig.call('/api/orientation/step', { step: 'nope', status: 'done' })).status, 400);
    assert.equal((await rig.call('/api/orientation/step', { step: 'kinds', status: 'maybe' })).status, 400);
    assert.equal((await rig.call('/api/orientation')).json.seen, true);
  } finally {
    if (rig) rig.stop();
    await removeTree(base);
  }
});
