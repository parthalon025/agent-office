// Campus module (#180): buildings, layouts, floor actions, tree cache and merge, driven through createCampus with real temporary
// git repositories, a plain state slice and fake sessions. No server, no port. Floors and rooms are made with real git.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as git from '../src/git.mjs';
import * as launch from '../src/launch.mjs';
import { createCampus } from '../src/campus.mjs';
import { placeOfSession, normPath } from '../src/place.mjs';

const GIT = launch.resolveExe('git');
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const plain = (cwd, ...a) => execFileSync(GIT, [...IDENT, ...a], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const made = [];
// A refresh still running when a test ends holds its folder as the current folder of git or gh, so the removal retries.
after(async () => { await new Promise((r) => setTimeout(r, 500)); for (const d of made) for (const x of [d, d + '.worktrees']) fs.rmSync(x, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); });
function repo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-campus-')));
  made.push(dir);
  plain(dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'b.txt'), 'b');
  plain(dir, 'add', '-A'); plain(dir, 'commit', '-m', 'one');
  return dir;
}
const fail = (status, message) => Object.assign(new Error(message), { status });
const askFirst = (kind, text) => Object.assign(fail(409, text), { confirm: kind });
// A campus over a plain state slice; `sessionList` is the live array the test edits.
function rig(over = {}) {
  const state = { layouts: {}, rooms: {}, merges: [] };
  const log = { saved: 0, changed: 0, feed: [], adopted: [] };
  const sessionList = [];
  const campus = createCampus({
    git: over.git || { ...git, ghRun: async () => '[]' }, state, save: () => { log.saved++; }, sessions: () => sessionList, changed: () => { log.changed++; },
    roomPlace: (s) => placeOfSession(s.git, s.cwd), adoptNotes: (p) => log.adopted.push(p), feed: (s, k, t) => log.feed.push([k, t]), fail, askFirst,
  });
  return { campus, state, log, sessionList };
}
const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(what); };
const wt = (c, dir) => c.reposView().find((r) => r.key === normPath(dir))?.worktrees || [];

test('addRepo makes a building with a layout record once, and reads its worktrees', async () => {
  const dir = repo();
  const { campus, state, log } = rig();
  campus.addRepo(dir);
  campus.addRepo(dir);
  assert.equal(campus.reposView().length, 1);
  assert.ok(state.layouts[normPath(dir)], 'a layout record');
  assert.equal(Object.keys(campus.layoutsView()).length, 1);
  await until(() => wt(campus, dir).length === 1, 'the main worktree is read');
  assert.ok(log.changed > 0);
  assert.equal(campus.reposView()[0].securityRoomId.startsWith('s-'), true);
});

test('create-floor, create-room, delete-floor run against real git', async () => {
  const dir = repo();
  const { campus } = rig();
  campus.addRepo(dir);
  await until(() => wt(campus, dir).length === 1, 'read');
  const f = await campus.floorAction('create-floor', { repo: dir, branch: 'feature-x', from: 'main', name: 'fx' });
  assert.ok(f);
  await until(() => wt(campus, dir).some((w) => w.branch === 'feature-x'), 'the floor shows');
  assert.ok((await campus.branches(dir)).branches.includes('main'));
  const r = await campus.floorAction('create-room', { repo: dir, branch: 'feature-x', name: 'second' });
  assert.ok(r);
  await campus.floorAction('remove-room', { repo: dir, root: r.root || r.path });
  await campus.floorAction('delete-floor', { repo: dir, branch: 'feature-x' });
  assert.ok(!wt(campus, dir).some((w) => w.branch === 'feature-x'));
});

test('floor actions: unknown repository is 404, unknown action 400, a git refusal is 409', async () => {
  const dir = repo();
  const { campus } = rig();
  await assert.rejects(campus.floorAction('create-floor', { repo: dir, branch: 'x' }), (e) => e.status === 404);
  campus.addRepo(dir);
  await assert.rejects(campus.floorAction('nope', { repo: dir }), (e) => e.status === 400);
  await assert.rejects(campus.floorAction('delete-floor', { repo: dir, branch: 'does-not-exist' }), (e) => e.status === 409);
});

test('a room with a live session in it is not removed, and its floor is not deleted or cleaned up', async () => {
  const dir = repo();
  const { campus, sessionList } = rig();
  campus.addRepo(dir);
  await until(() => wt(campus, dir).length === 1, 'read');
  await campus.floorAction('create-floor', { repo: dir, branch: 'busy', from: 'main', name: 'busy' });
  await until(() => wt(campus, dir).some((w) => w.branch === 'busy'), 'floor');
  const room = wt(campus, dir).find((w) => w.branch === 'busy').root;
  sessionList.push({ uid: 1, name: 'Ada', status: 'idle', cwd: path.join(room, 'src') });
  await assert.rejects(campus.floorAction('remove-room', { repo: dir, root: room }), (e) => e.status === 409 && /Ada works in this room/.test(e.message));
  await assert.rejects(campus.floorAction('delete-floor', { repo: dir, branch: 'busy' }), (e) => e.status === 409 && /Ada works on this floor/.test(e.message));
  const out = await campus.floorAction('cleanup-floors', { repo: dir, branches: ['busy', 'main'] });
  assert.deepEqual(out.deleted, []);
  assert.deepEqual(out.skipped.sort(), ['busy', 'main']);
  assert.ok(!(await campus.staleFloors(dir)).floors.some((f) => f.branch === 'busy'));
  sessionList[0].status = 'ended';
  await campus.floorAction('delete-floor', { repo: dir, branch: 'busy' });
});

test('cleanup-floors deletes a merged floor and never one the page named that is not safe', async () => {
  const dir = repo();
  const { campus } = rig();
  campus.addRepo(dir);
  await until(() => wt(campus, dir).length === 1, 'read');
  await campus.floorAction('create-floor', { repo: dir, branch: 'done', from: 'main', name: 'done' });
  await until(() => wt(campus, dir).some((w) => w.branch === 'done'), 'floor');
  const root = wt(campus, dir).find((w) => w.branch === 'done').root;
  fs.writeFileSync(path.join(root, 'new.txt'), 'dirty');
  const out = await campus.floorAction('cleanup-floors', { repo: dir, branches: ['done', 'main'] });
  assert.deepEqual(out.deleted, []);
  assert.deepEqual(out.skipped.sort(), ['done', 'main']);
});

test('changeLayout: unknown building is 404, a bad edit is 400, a good edit saves and tells the page', async () => {
  const dir = repo();
  const { campus, state, log } = rig();
  assert.throws(() => campus.changeLayout({ building: normPath(dir) }), (e) => e.status === 404);
  campus.addRepo(dir);
  assert.throws(() => campus.changeLayout({ building: normPath(dir), action: 'nope' }), (e) => e.status === 400);
  const before = log.changed;
  const k = normPath(dir);
  const floors = campus.layoutsView()[k].floors;
  assert.ok(floors.length > 0);
  const res = campus.changeLayout({ building: k, action: 'rename', floor: floors[0].id, name: 'Renamed' });
  assert.equal(res.ok, true);
  assert.ok(log.changed > before);
  assert.ok(state.layouts[k]);
});

test('Other folders appear in layoutsView only while a placed session works outside git', () => {
  const { campus, sessionList } = rig();
  assert.deepEqual(Object.keys(campus.layoutsView()), []);
  sessionList.push({ uid: 1, status: 'idle', placed: true, cwd: os.tmpdir(), git: null, startedAt: 1 });
  assert.deepEqual(Object.keys(campus.layoutsView()), ['']);
  sessionList[0].status = 'ended';
  assert.deepEqual(Object.keys(campus.layoutsView()), []);
});

test('repoTree lists a known worktree, refuses an unknown folder, and caches for the ttl', async () => {
  const dir = repo();
  let t = 1000;
  const state = { layouts: {}, rooms: {}, merges: [] };
  let reads = 0;
  const counting = { ...git, ghRun: async () => '[]', files: async (r) => { reads++; return git.files(r); } };
  const campus = createCampus({ git: counting, state, save() {}, sessions: () => [], changed() {}, roomPlace: () => ({}), adoptNotes() {}, feed() {}, fail, askFirst, now: () => t });
  campus.addRepo(dir);
  await until(() => wt(campus, dir).length === 1, 'read');
  await assert.rejects(campus.repoTree(os.tmpdir()), (e) => e.status === 404);
  const a = await campus.repoTree(dir);
  assert.equal(a.total, 2);
  assert.deepEqual(a.entries.map((e) => [e.name, e.dir, e.files]), [['src', true, 1], ['a.txt', false, 1]]);
  await campus.repoTree(dir);
  assert.equal(reads, 1);
  t += 31000;
  await campus.repoTree(dir);
  assert.equal(reads, 2);
});


// gh stand-in: the reader's one call (git.ghRun) answers the raw `gh pr list` text.
const raw = (over = {}) => ({ number: 7, title: 'Add x', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', headRefName: 'feat', baseRefName: 'main', statusCheckRollup: [], url: 'u', ...over });
function ghRig(prs) {
  const dir = repo();
  const merged = [];
  const fakeGit = { ...git, ghRun: async () => JSON.stringify(prs), mergePr: async (p, a) => { merged.push([p, a]); } };
  return { dir, merged, ...rig({ git: fakeGit }) };
}
test('mergeChange: unknown building 404, bad number 400, unknown or not-ready change 409, nothing merged', async () => {
  const { dir, campus, merged, log } = ghRig([raw({ number: 8, isDraft: true })]);
  await assert.rejects(campus.mergeChange({ repo: 'nope', number: 1 }), (e) => e.status === 404);
  campus.addRepo(dir);
  const k = normPath(dir);
  await assert.rejects(campus.mergeChange({ repo: k, number: 0 }), (e) => e.status === 400);
  await assert.rejects(campus.mergeChange({ repo: k, number: 7 }), (e) => e.status === 409 && /unknown/.test(e.message));
  await assert.rejects(campus.mergeChange({ repo: k, number: 8, confirmed: true }), (e) => e.status === 409 && /not ready/.test(e.message));
  assert.deepEqual(merged, []);
  assert.deepEqual(log.feed, []);
});
test('mergeChange: a ready change asks first, a confirmed merge runs once, records it and feeds the office', async () => {
  const { dir, campus, merged, log, state } = ghRig([raw()]);
  campus.addRepo(dir);
  const k = normPath(dir);
  await assert.rejects(campus.mergeChange({ repo: k, number: 7 }), (e) => e.status === 409 && e.confirm === 'merge' && /Merge #7 Add x into main/.test(e.message));
  assert.deepEqual(merged, []);
  assert.deepEqual(await campus.mergeChange({ repo: k, number: 7, confirmed: true }), { ok: true });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0][1], ['pr', 'merge', '7', '--merge']);
  assert.equal(state.merges.length, 1);
  assert.deepEqual(log.feed, [['merge', 'merged #7 Add x']]);
  assert.equal(campus.changesView()[k].ready[0].number, 7);
});
