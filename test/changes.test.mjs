// Paper flow (#93, spec #88 phase 4): the rules that turn `gh pr list` JSON into a folder state, a pipeline stage and the
// Ready to merge tray, and the reader that asks `gh` (read-only) and never shows old data as live. A fake runner stands for gh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stateOf, checksOf, stageOf, viewPrs, readyEntries, pipelineOf, createReader, readArgs, mergeArgs } from '../src/changes.mjs';

const pr = (o) => ({ number: 1, title: 'T', state: 'OPEN', isDraft: false, headRefName: 'feat/x', baseRefName: 'main', mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [], additions: 3, deletions: 1, changedFiles: 2, url: 'u', ...o });
const ok = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' };
const bad = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' };
const run = { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' };

test('each PR state gives its folder state', () => {
  assert.equal(stateOf(pr({ isDraft: true })), 'draft');
  assert.equal(stateOf(pr({})), 'open');
  assert.equal(stateOf(pr({ statusCheckRollup: [ok, run] })), 'checks');
  assert.equal(stateOf(pr({ statusCheckRollup: [bad] })), 'checks');
  assert.equal(stateOf(pr({ statusCheckRollup: [ok], reviewDecision: 'REVIEW_REQUIRED' })), 'review');
  assert.equal(stateOf(pr({ statusCheckRollup: [ok], reviewDecision: 'CHANGES_REQUESTED' })), 'changes');
  assert.equal(stateOf(pr({ statusCheckRollup: [ok], reviewDecision: 'APPROVED' })), 'ready');
  assert.equal(stateOf(pr({ statusCheckRollup: [ok], reviewDecision: 'APPROVED', mergeable: 'UNKNOWN' })), 'approved');
  assert.equal(stateOf(pr({ mergeable: 'CONFLICTING' })), 'conflict');
  assert.equal(stateOf(pr({ state: 'MERGED' })), 'merged');
  assert.equal(stateOf(pr({ state: 'CLOSED' })), 'closed');
  assert.equal(stateOf(null), 'unknown');
  assert.equal(stateOf({ number: 'x' }), 'unknown');
});

test('checks are counted, a failed one wins', () => {
  assert.deepEqual(checksOf(pr({ statusCheckRollup: [ok, bad, run, { __typename: 'StatusContext', state: 'SUCCESS' }] })), { total: 4, passed: 2, failed: 1, pending: 1 });
  assert.deepEqual(checksOf(pr({})), { total: 0, passed: 0, failed: 0, pending: 0 });
});

test('a state sits in one pipeline stage; stages with no data are unknown', () => {
  assert.equal(stageOf('draft'), 'build');
  assert.equal(stageOf('checks'), 'check');
  assert.equal(stageOf('review'), 'review');
  assert.equal(stageOf('ready'), 'merge');
  assert.equal(stageOf('merged'), 'record');
  const p = pipelineOf([{ state: 'draft', stage: 'build' }, { state: 'review', stage: 'review' }, { state: 'ready', stage: 'merge' }]);
  assert.deepEqual(p.map((s) => s.id), ['intake', 'build', 'check', 'review', 'gate', 'merge', 'release', 'record']);
  assert.equal(p.find((s) => s.id === 'intake').unknown, true);
  assert.equal(p.find((s) => s.id === 'release').unknown, true);
  assert.equal(p.find((s) => s.id === 'build').count, 1);
  assert.equal(p.find((s) => s.id === 'check').count, 0);
});

test('viewPrs: one entry per PR, merged today counted, one folder per desk with a count', () => {
  const now = Date.parse('2026-11-06T12:00:00');
  const v = viewPrs([
    pr({ number: 1, state: 'MERGED', mergedAt: '2026-11-06T09:00:00' }),
    pr({ number: 2, state: 'MERGED', mergedAt: '2026-11-05T09:00:00' }),
    pr({ number: 3, headRefName: 'a' }), pr({ number: 4, headRefName: 'a', isDraft: true }),
  ], now);
  assert.equal(v.mergedToday, 1);
  assert.equal(v.prs.length, 4);
  assert.deepEqual(v.prs[2].diff, { additions: 3, deletions: 1, files: 2 });
  assert.equal(v.prs.find((p) => p.number === 3).state, 'open');
});

test('Ready to merge: needs a Quality record where the building asks for one, and lists every ready change', () => {
  const prs = [{ number: 5, title: 'Five', head: 'feat/five', state: 'ready', url: 'u5', repo: 'r' }, { number: 6, title: 'Six', head: 'feat/six', state: 'ready', repo: 'r' }, { number: 7, head: 'x', state: 'review', repo: 'r' }];
  assert.deepEqual(readyEntries(prs, {}).map((e) => e.number), [5, 6]);
  const q = readyEntries(prs, { needQuality: true, quality: new Set(['feat/five']) });
  assert.deepEqual(q.map((e) => e.number), [5]);
  assert.equal(q[0].kind, 'merge');
  assert.equal(q[0].recommendation, 'Merge');
  assert.match(q[0].text, /#5/);
});

test('reader: read-only gh args, cached for the ttl, a failed read is "PR state unknown", never old data', async () => {
  assert.deepEqual(readArgs().slice(0, 2), ['pr', 'list']); assert.ok(!readArgs().some((a) => /^(merge|create|edit|close|comment|review)$/.test(a)));
  assert.deepEqual(mergeArgs(7).slice(0, 3), ['pr', 'merge', '7']);
  let t = 1000, calls = 0, fail = false;
  const r = createReader({ now: () => t, ttlMs: 60000, run: async () => { calls++; if (fail) throw new Error('no gh'); return JSON.stringify([pr({ number: 9 })]); } });
  const a = await r.read('k', 'C:/x');
  assert.equal(a.ok, true); assert.equal(a.prs[0].number, 9);
  t += 30000; await r.read('k', 'C:/x'); assert.equal(calls, 1);
  t += 31000; fail = true;
  const b = await r.read('k', 'C:/x');
  assert.equal(calls, 2);
  assert.equal(b.ok, false); assert.deepEqual(b.prs, []); assert.equal(b.error, 'PR state unknown');
  r.invalidate('k'); fail = false;
  assert.equal((await r.read('k', 'C:/x')).ok, true);
  fail = true; r.invalidate('k');
  const bad2 = createReader({ now: () => t, run: async () => 'not json' });
  assert.equal((await bad2.read('k', 'C:/x')).ok, false);
});

test('reader: a failed read is asked again after the short wait, and an invalidated read in flight never fills the cache', async () => {
  let t = 0, calls = 0, fail = true, release;
  const gate = new Promise((r) => { release = r; });
  const r = createReader({ now: () => t, ttlMs: 60000, failTtlMs: 10000, run: async () => { calls++; const n = calls; if (fail) throw new Error('timeout'); await gate; return JSON.stringify([pr({ number: n })]); } });
  const a = await r.read('k', 'x'); assert.equal(a.ok, false); assert.match(a.why, /timeout/);
  t += 5000; await r.read('k', 'x'); assert.equal(calls, 1, 'kept for the short wait');
  t += 6000; fail = false;
  const old = r.read('k', 'x');
  r.invalidate('k');
  const fresh = r.read('k', 'x');
  release();
  assert.equal(calls, 3);
  assert.equal((await fresh).prs[0].number, 3);
  await old;
  assert.equal(r.peek('k').prs[0].number, 3, 'the old read did not overwrite the fresh one');
});
