// Paper flow (#93): the building store turns the snapshot's `changes` into folders, trays and the pipeline (building.js changes,
// folderAt, requests). Plain snapshots, no tracker, no DOM, no server, no paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normPath } from '../src/place.mjs';
import { stageOf } from '../src/changes.mjs';
import '../src/vocab.mjs';
import '../public/wire.js';
import '../public/building.js';
import { loadBundle } from './fixtures/ds-bundle.mjs';

globalThis.AgentOffice = loadBundle().AO;
const B = globalThis.OfficeBuilding;

const REPO_A = 'C:\\work\\repo', REPO_B = 'C:\\work\\other';
const KEY_A = normPath(REPO_A), KEY_B = normPath(REPO_B);
const NOW = 1_800_000_000_000;
const prOf = (o) => ({ number: 1, title: 'T', head: 'feat/x', base: 'main', url: 'u', state: 'open', stage: 'check', checks: { total: 0, passed: 0, failed: 0, pending: 0 }, reviewer: '', diff: { additions: 1, deletions: 0, files: 1 }, mergedAt: null, repo: KEY_A, ...o });
const readyOf = (p) => ({ id: `merge:${p.repo}:${p.number}`, kind: 'merge', repo: p.repo, number: p.number, title: p.title, url: p.url, text: `#${p.number} ${p.title} is ready to merge.`, recommendation: 'Merge', reason: 'Checks passed (0). Approved. No conflict.' });
const entry = (prs, o) => ({ ok: true, at: NOW - 1000, error: null, mergedToday: 0, prs, ready: prs.filter((p) => p.state === 'ready').map(readyOf), ...o });
const snapOf = (changes) => ({ sessions: [], repos: [{ key: KEY_A, name: 'repo', path: REPO_A, worktrees: [] }, { key: KEY_B, name: 'other', path: REPO_B, worktrees: [] }], layouts: {}, rooms: {}, changes });

test('each PR state gives its folder place and mark, by shape and not by color', () => {
  const states = ['draft', 'open', 'checks', 'review', 'changes', 'approved', 'ready', 'conflict', 'merged', 'closed'];
  const prs = states.map((st, i) => prOf({ number: i + 1, head: 'b' + i, state: st, stage: stageOf(st) }));
  const c = B.changes(snapOf({ [KEY_A]: entry(prs) }), KEY_A, NOW);
  const by = Object.fromEntries(c.folders.map((f) => [f.state, f]));
  assert.equal(by.draft.place, 'desk');
  assert.equal(by.open.place, 'outbox');
  assert.equal(by.checks.mark, 'checklist');
  assert.equal(by.review.place, 'inbox');
  assert.equal(by.changes.mark, 'note');
  assert.equal(by.approved.mark, 'stamp');
  assert.equal(by.conflict.mark, 'tab');
  assert.equal(by.ready.place, 'ready-tray');
  assert.equal(by.merged.place, 'cabinet');
  assert.equal(by.closed.place, 'archive');
  assert.ok(c.folders.every((f) => f.glyph && f.number && f.word), 'every folder has a glyph, its number and a word');
  assert.equal(c.tray.length, 1);
  assert.equal(c.pipeline.find((s) => s.id === 'merge').count, 1);
});

test('a failed read, no read yet and old data all give PR state unknown, never live state', () => {
  const fail = B.changes(snapOf({ [KEY_A]: { ok: false, at: NOW - 1000, error: 'PR state unknown', prs: [], ready: [], mergedToday: 0 } }), KEY_A, NOW);
  assert.equal(fail.unknown, true); assert.equal(fail.line, 'PR state unknown'); assert.deepEqual(fail.tray, []);
  assert.equal(B.changes(snapOf({}), KEY_A, NOW).unknown, true);
  const old = B.changes(snapOf({ [KEY_A]: entry([prOf({ state: 'ready' })], { at: NOW - 10 * 60000 }) }), KEY_A, NOW);
  assert.equal(old.unknown, true); assert.deepEqual(old.tray, []); assert.deepEqual(old.folders, []);
  assert.ok(old.pipeline.every((s) => s.unknown));
});

test('at most one folder per desk, the rest as a count', () => {
  const c = B.changes(snapOf({ [KEY_A]: entry([prOf({ number: 1, head: 'a', state: 'draft' }), prOf({ number: 2, head: 'a', state: 'review' }), prOf({ number: 3, head: 'b' })]) }), KEY_A, NOW);
  const a = B.folderAt(c, 'a');
  assert.equal(a.number, 2); assert.equal(a.more, 1);
  assert.equal(B.folderAt(c, 'zzz'), null);
});

test('Ready to merge counts toward Needs you from every building, with no session behind it', () => {
  const p8 = prOf({ number: 8, state: 'ready', repo: KEY_B, title: 'Eight' });
  const s = snapOf({ [KEY_A]: entry([prOf({ number: 7, state: 'ready' })]), [KEY_B]: entry([p8]) });
  const list = B.requests(s, NOW);
  assert.deepEqual(list.map((r) => r.number).sort(), [7, 8]);
  assert.ok(list.every((r) => r.kind === 'merge' && r.uid == null && r.buildingName));
  assert.deepEqual(B.requests(snapOf({ [KEY_A]: entry([prOf({ state: 'ready' })], { at: NOW - 10 * 60000 }) }), NOW), []);
});
