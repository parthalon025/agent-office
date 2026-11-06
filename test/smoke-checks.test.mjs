// The unpaid half of test/smoke.mjs (#188): its expectations are functions in fixtures/smoke-checks.mjs, tested here with the
// shape of a real smoke run (a repo folder named repo1, a room of two sessions after a failed turn).
import test from 'node:test';
import assert from 'node:assert/strict';
import { inWorktreeOf, roomFiguresOf, roomAtRest } from './fixtures/smoke-checks.mjs';
import { createTracker } from '../src/tracker.mjs';
import { slimPayload } from '../src/payload.mjs';
import '../src/vocab.mjs';

const V = globalThis.OfficeVocab;

test('the worktree of repo1 is repo1.worktrees/<slug>, in any slash style and case', () => {
  const repo = 'C:/Users/me/AppData/Local/Temp/agent-office-smoke/repo1';
  assert.ok(inWorktreeOf('C:\\Users\\me\\AppData\\Local\\Temp\\agent-office-smoke\\repo1.worktrees\\wt-test', repo, 'wt-test'));
  assert.ok(inWorktreeOf('c:/users/me/appdata/local/temp/agent-office-smoke/Repo1.worktrees/WT-TEST/', repo, 'wt-test'));
  assert.ok(!inWorktreeOf(repo, repo, 'wt-test'), 'the main folder is not a worktree');
  assert.ok(!inWorktreeOf('C:/t/repo2.worktrees/wt-test', repo, 'wt-test'), 'another repository');
});

// A room of two (a watcher that has not been asked anything and a session whose first turn fails on its spending limit),
// driven by the hooks and stream lines that session gets: the same figures and words the smoke script reads.
test('after a failed first turn the room is at rest and the failed session reads as an error, then as finished after Dismiss', () => {
  const t = createTracker({
    now: () => 1_000_000, makeId: (k) => k + Math.random().toString(36).slice(2), locate: async () => null, onChange() {}, releaseHold() {}, setTimer: () => 1,
  });
  const watcher = t.newSession({ officeId: 'w', uid: 'w', headless: true, status: 'starting', name: 'watcher' });
  const failer = t.newSession({ officeId: 'f', uid: 'f', headless: true, status: 'starting', name: 'failer', budget: 0.0001 });
  const hook = (raw) => t.onHook(slimPayload(raw, 'f'));
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-f', cwd: 'C:/c', prompt: 'Say hello.' });
  assert.equal(V.status(failer).key, 'working');
  t.onStream(failer, JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: false, total_cost_usd: 0.01 }));
  hook({ hook_event_name: 'Stop', session_id: 'sid-f', cwd: 'C:/c' });
  assert.equal(V.status(failer).key, 'error');
  assert.equal(V.status(watcher).key, 'resting');
  const sn = { sessions: [{ uid: 'f', place: { noteKey: 'k' } }, { uid: 'w', place: { noteKey: 'k' } }], figures: { k: V.figures([watcher, failer]) } };
  assert.deepEqual([roomFiguresOf(sn, 'w').sessions, roomFiguresOf(sn, 'f').working], [2, 0]);
  assert.ok(roomAtRest(roomFiguresOf(sn, 'w')));
  t.dismissError(failer);
  assert.equal(V.status(failer).key, 'finished');
  assert.ok(roomAtRest(V.figures([watcher, failer])));
});

// A turn that fails at once can end on the stream before its UserPromptSubmit hook reaches the office. The late hook is the
// same turn: it counts the turn, but it neither starts work again nor clears the error (#188).
test('a prompt hook that comes after the result of the same turn does not make the failed session work again', () => {
  const t = createTracker({
    now: () => 1_000_000, makeId: (k) => k + Math.random().toString(36).slice(2), locate: async () => null, onChange() {}, releaseHold() {}, setTimer: () => 1,
  });
  const failer = t.newSession({ officeId: 'f', uid: 'f', headless: true, status: 'starting', name: 'failer', budget: 0.0001, prompt: 'Say hello.' });
  t.onStream(failer, JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: false, total_cost_usd: 0.01 }));
  t.onHook(slimPayload({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-f', cwd: 'C:/c', prompt: 'Say hello.' }, 'f'));
  assert.equal(V.status(failer).key, 'error');
  assert.equal(failer.turns, 1);
  t.dismissError(failer);
  assert.equal(V.status(failer).key, 'finished');
  // The next prompt is a new turn: it works and clears nothing stale.
  t.onHook(slimPayload({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-f', cwd: 'C:/c', prompt: 'Again.' }, 'f'));
  assert.equal(V.status(failer).key, 'working');
});
