// Rituals and the attention measure (#151): stand-up note, merged moment, weekly recap, while-you-were-away, Focus mode,
// and the office clock (the week as two hands). The rules are pure: the shared ones in public/vocab.js (OfficeVocab.rituals),
// the measure in rituals.mjs. No server. The caller passes now.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/vocab.mjs';
import { metrics, recap, away, mergeRecord, officeClock } from '../src/rituals.mjs';

const R = globalThis.OfficeVocab.rituals;
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

test('Focus mode and reduced motion each turn every ritual off; with neither they are on', () => {
  assert.equal(R.on({}), true);
  assert.equal(R.on({ focus: true }), false);
  assert.equal(R.on({ reduced: true }), false);
  assert.equal(R.on({ focus: true, reduced: true }), false);
});

test('a stand-up is due at the first turn of the day, once per agent name in any case, and never in Focus mode', () => {
  const seen = {};
  assert.equal(R.standupDue(seen, 'Ada', NOW, {}), true);
  R.standupDone(seen, 'Ada', NOW);
  assert.equal(R.standupDue(seen, 'ada', NOW + 5 * MIN, {}), false);
  assert.equal(R.standupDue(seen, 'Ada', NOW + 2 * DAY, {}), true);
  assert.equal(R.standupDue(seen, 'Bob', NOW, {}), true);
  assert.equal(R.standupDue(seen, 'Bob', NOW, { focus: true }), false);
  assert.equal(R.standupDue(seen, '__proto__', NOW, {}), true);
  R.standupDone(seen, '__proto__', NOW);
  assert.equal(Object.getPrototypeOf(seen), Object.prototype);
  assert.match(R.STANDUP, /office_room_update/);
  assert.match(R.STANDUP, /Yesterday/);
});

test('a merged moment plays for a new merge, once, and never while any request is open (it waits, the request is not delayed)', () => {
  const m = [{ key: 'a#1', repo: 'a', number: 1, head: 'feat/x', title: 'T', at: NOW - MIN }];
  assert.deepEqual(R.moments(m, {}, { now: NOW }).map((x) => x.key), ['a#1']);
  assert.deepEqual(R.moments(m, { 'a#1': true }, { now: NOW }), []);
  assert.deepEqual(R.moments(m, {}, { now: NOW, waiting: 1 }), []);
  assert.deepEqual(R.moments(m, {}, { now: NOW, focus: true }), []);
  assert.deepEqual(R.moments(m, {}, { now: NOW, reduced: true }), []);
  assert.deepEqual(R.moments(m, {}, { now: NOW + 11 * MIN }), [], 'a merge that is more than 10 minutes old is no moment');
});

const history = [
  { uid: 'h1', name: 'Ada', cost: 1.25, startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR, worktree: { branch: 'agent/ada-1' } },
  { uid: 'h2', name: 'Bob', cost: 0.5, startedAt: NOW - 10 * DAY, endedAt: NOW - 10 * DAY + HOUR, worktree: { branch: 'agent/bob-1' } },
];
const merges = [
  { key: 'r#1', repo: 'r', number: 1, title: 'Fix', head: 'agent/ada-1', at: NOW - HOUR },
  { key: 'r#2', repo: 'r', number: 2, title: 'Old', head: 'agent/bob-1', at: NOW - 9 * DAY },
];
const feed = [
  { t: NOW - 150 * MIN, uid: 'h1', name: 'Ada', kind: 'tool', text: 'approved from the office' },
  { t: NOW - 140 * MIN, uid: 'h1', name: 'Ada', kind: 'tool', text: 'approved and always allowed from the office' },
  { t: NOW - 130 * MIN, uid: 'h1', name: 'Ada', kind: 'tool', text: 'declined from the office' },
  { t: NOW - 120 * MIN, uid: 'h1', name: 'Ada', kind: 'prompt', text: 'answered yes in the office' },
  { t: NOW - 100 * MIN, uid: 'h1', name: 'Ada', kind: 'tool', text: 'read the office inbox' },
  { t: NOW - 20 * DAY, uid: 'x', name: 'Old', kind: 'tool', text: 'approved from the office' },
];

test('metrics come from the feed, the merges and the history: approvals per merge, minutes from done to merged, interruptions per hour', () => {
  const m = metrics({ feed, merges, history, now: NOW, windowMs: 7 * DAY });
  assert.equal(m.merges, 1);
  assert.equal(m.approvals, 2);
  assert.equal(m.interruptions, 4, 'two approvals, one decline and one yes answer');
  assert.equal(m.approvalsPerMerge, 2);
  assert.equal(m.minutesToMerge, 60, 'Ada ended an hour before the merge (history endedAt, merge at)');
  assert.equal(m.interruptionsPerHour, 4, 'one active hour in the window');
});

test('metrics say null, not zero, when there is nothing to divide', () => {
  const m = metrics({ feed: [], merges: [], history: [], now: NOW, windowMs: 7 * DAY });
  assert.deepEqual([m.approvalsPerMerge, m.minutesToMerge, m.interruptionsPerHour], [null, null, null]);
  assert.equal(m.merges, 0);
});

test('a merge made before its session ended counts no negative minutes', () => {
  const m = metrics({ feed: [], merges: [{ key: 'r#3', repo: 'r', number: 3, head: 'agent/ada-1', at: NOW - 5 * HOUR }], history, now: NOW, windowMs: 7 * DAY });
  assert.equal(m.minutesToMerge, null);
});

test('the weekly recap: shipped work, attention, cost and each agent\'s best moment', () => {
  const r = recap({ feed, merges, history, now: NOW });
  assert.deepEqual(r.shipped.map((s) => s.number), [1]);
  assert.equal(r.cost, 1.25);
  assert.equal(r.metrics.approvals, 2);
  assert.deepEqual(r.best, [{ name: 'Ada', text: 'Merged #1 Fix.' }]);
  assert.equal(r.days, 7);
});

test('while you were away: the feed since a time, short, oldest first, with no repeated line', () => {
  const lines = [
    { t: NOW - 50 * MIN, uid: 'a', name: 'Ada', kind: 'start', text: 'started' },
    { t: NOW - 40 * MIN, uid: 'a', name: 'Ada', kind: 'tool', text: 'ran npm test' },
    { t: NOW - 39 * MIN, uid: 'a', name: 'Ada', kind: 'tool', text: 'ran npm test' },
    { t: NOW - 5 * HOUR, uid: 'a', name: 'Ada', kind: 'tool', text: 'too old' },
  ];
  const a = away({ feed: lines, since: NOW - HOUR, now: NOW, max: 5 });
  assert.deepEqual(a.map((x) => x.text), ['Ada started', 'Ada ran npm test']);
  assert.equal(away({ feed: lines, since: NOW - 10 * DAY, now: NOW, max: 2 }).length, 2);
  assert.deepEqual(away({ feed: lines, since: 0, now: NOW, max: 0 }), []);
});

test('the office clock: a quiet week stops the hands, a few merges move them, and a full face holds', () => {
  const quiet = officeClock({ feed: [], merges: [], now: NOW });
  assert.deepEqual(quiet, { hour: 0, minute: 0, merges: 0, answers: 0, line: 'Quiet week.' });
  const week = officeClock({ feed, merges, now: NOW });
  assert.equal(week.merges, 1, 'the merge from last week is outside the window');
  assert.equal(week.answers, 4, 'two approvals, one decline and one yes; a read and an old approval do not count');
  assert.deepEqual([week.hour, week.minute], [1, 4]);
  assert.equal(week.line, '1 merge. The office asked you 4 times.');
  const many = { feed: [], merges: [] };
  for (let i = 0; i < 13; i++) many.merges.push({ at: NOW - i * MIN });
  for (let i = 0; i < 61; i++) many.feed.push({ t: NOW - i * MIN, kind: 'tool', text: 'approved from the office' });
  const full = officeClock({ ...many, now: NOW });
  assert.equal(full.merges, 13);
  assert.equal(full.answers, 61);
  assert.deepEqual([full.hour, full.minute], [12, 60], 'twelve merges and sixty answers fill the face and the hands stay there');
  assert.equal(full.line, '13 merges. The office asked you 61 times.');
  const three = officeClock({
    feed: Array.from({ length: 14 }, (_, i) => ({ t: NOW - i * MIN, kind: 'prompt', text: 'answered in the office: yes' })),
    merges: [1, 2, 3].map((n) => ({ at: NOW - n * MIN })),
    now: NOW,
  });
  assert.deepEqual([three.hour, three.minute], [3, 14]);
  assert.equal(three.line, '3 merges. The office asked you 14 times.');
});

test('a merge record keeps only what the recap and the moment read', () => {
  const rec = mergeRecord('b', { number: 7, title: 'x'.repeat(300), head: 'feat/y', secret: 'no' }, NOW);
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'head', 'key', 'number', 'repo', 'title']);
  assert.equal(rec.key, 'b#7');
  assert.equal(rec.title.length, 140);
});
