// The pure part of the core-jobs gate (#147): the step limits and the verdict. The browser run is `npm run gate:jobs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, WIDTHS, JOBS, verdict } from './core-jobs.mjs';

test('every job has an integer step limit, and the widths are 1360 and 400', () => {
  assert.deepEqual(WIDTHS, [1360, 400]);
  assert.deepEqual(JOBS.slice().sort(), ['approve', 'approveAfterDesk', 'discard', 'find', 'hire', 'read', 'setup', 'start']);
  for (const j of JOBS) assert.ok(Number.isInteger(LIMITS[j]) && LIMITS[j] > 0, j);
});

test('verdict: a run inside its limit passes', () => {
  assert.deepEqual(verdict([{ job: 'approve', width: 1360, steps: LIMITS.approve, ok: true }]), []);
});

test('verdict: one step over the limit fails and names the job and the width', () => {
  const out = verdict([{ job: 'find', width: 400, steps: LIMITS.find + 1, ok: true }]);
  assert.equal(out.length, 1);
  assert.match(out[0], /find at 400 px: \d+ steps, the limit is \d+/);
});

test('verdict: a goal that never showed fails, with the reason', () => {
  const out = verdict([{ job: 'read', width: 1360, steps: 2, ok: false, why: 'pick "Changes of": target not found' }]);
  assert.match(out[0], /read at 1360 px: goal not reached after 2 steps \(pick "Changes of"/);
});

test('verdict: a job with no limit is a failure, never unchecked', () => {
  assert.match(verdict([{ job: 'merge', width: 1360, steps: 1, ok: true }])[0], /no step limit/);
  assert.match(verdict([{ job: 'find', width: 1360, steps: 1, ok: true }], { find: 'three' })[0], /no step limit/);
});

test('verdict: the limits are a parameter, so one place sets them', () => {
  assert.equal(verdict([{ job: 'start', width: 1360, steps: 2, ok: true }], { start: 1 }).length, 1);
});
