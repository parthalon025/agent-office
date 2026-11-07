// Campus: the buildings the office knows (repositories), their layouts, room records, pull request and change views, the tree
// cache and the floor actions (#180, spec #168). One Module, one Interface; the server asks it for views.
// Inputs (all injected, so tests use real temporary git repos and plain objects):
//   git       the git module, or a stand-in with the same calls (layout, refreshEntry, createFloor, createRoom, removeRoom,
//             deleteFloor, staleFloors, floorCandidates, files, mergePr, ghRun, locateOrKeep, KEEP)
//   state     the state slice { layouts, rooms, merges } (the persisted object); save() writes it
//   sessions  () => iterable of sessions (the tracker's map values); roomPlace(s) is the place of one (place.mjs)
//   changed() a view changed (the server's broadcast); adoptNotes(place); feed(session, kind, text)
//   fail(status, message) builds the error the HTTP layer reads; askFirst(kind, text) builds the ask-first error
//   recent    folders to look up as buildings once start() runs
// Nothing runs a timer or a folder lookup until start() (the recent-folder lookups and the 30 s refresh). The state slice is
// saved.slice('layouts', 'rooms', 'merges') (#181).
// Interface: addRepo, refreshRepo, reposView, layoutRecord, seatOfSession, layoutsView, changeLayout, roomsView, noteRooms,
// changesView, changesStale, mergeChange (409 ask-first until confirmed), repoTree, branches, staleFloors, floorAction (a room
// or floor with a live session in it is never removed). office.mjs builds one and routes to it. Tested in test/campus.test.mjs
// with real temporary git repos and a gh stand-in.
import fs from 'node:fs';
import path from 'node:path';
import { createReader as createPrReader, readyEntries, mergeArgs } from './changes.mjs';
import { placeOfWorktree, normPath, securityRoomIdOf, seatOf } from './place.mjs';
import { settleRooms, viewRooms } from './rooms.mjs';
import { detect, newRecord, edit as editLayout, layoutView, shownFloors } from './archetypes.mjs';
import { mergeRecord, MERGES_KEPT } from './rituals.mjs';
import { clip } from './tracker.mjs';

// A room on a floor: a worktree of the branch, or an agent room whose base is that branch (it sits on that floor, #69).
export const onFloor = (w, branch) => w.branch === branch || (!!w.base && w.base === branch);

// The file names at a folder's root and one level down (archetypes.mjs detect): names only, never contents. A folder that
// cannot be read gives what could be read. Caps keep a huge folder cheap.
export function namesOf(dir) {
  const out = [], skip = new Set(['.git', 'node_modules']);
  let top = [];
  try { top = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 400); } catch { return out; }
  for (const e of top) {
    if (skip.has(e.name)) continue;
    if (!e.isDirectory()) { out.push(e.name); continue; }
    out.push(e.name + '/');
    try { for (const c of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }).slice(0, 200)) out.push(e.name + '/' + c.name + (c.isDirectory() ? '/' : '')); } catch { /* unreadable: skip */ }
  }
  return out;
}

export function createCampus({ git, state, save, sessions, roomPlace, changed, adoptNotes, feed, fail, askFirst, recent = [], now = Date.now, treeTtlMs = 30000 }) {
  const repos = new Map(); // lower-case repo path -> { path, name, worktrees }
  const repoKey = normPath;
  const live = () => [...sessions()].filter((s) => s.status !== 'ended');

  // ---- repositories ----
  function addRepo(repoPath) {
    const k = repoKey(repoPath);
    if (repos.has(k)) return;
    repos.set(k, { path: path.normalize(repoPath), name: path.basename(repoPath), worktrees: [] });
    layoutRecord(k, repoPath);
    void refreshRepo(k);
  }
  // The record of a building, made once from detection (Other folders: General, nothing to detect).
  function layoutRecord(key, dir) {
    if (!state.layouts[key]) { state.layouts[key] = newRecord(key && dir ? detect(namesOf(dir)) : null); save(); }
    return state.layouts[key];
  }
  function knownRepo(p) {
    const r = repos.get(repoKey(String(p || '')));
    if (!r) throw fail(404, 'The office does not know that repository.');
    return r;
  }
  // The repository entries the snapshot carries, each with its Security room id and the place of its worktrees.
  const reposView = () => [...repos.entries()].map(([key, r]) => ({ key, ...r, securityRoomId: securityRoomIdOf(key), worktrees: r.worktrees.map((w) => ({ ...w, place: placeOfWorktree(r.path, w) })) }));

  // ---- seats, rooms, layouts ----
  function seatOfSession(s) {
    if (!s.placed) return null;
    const pl = roomPlace(s);
    return seatOf({ assigned: s.assignedRole, desk: s.deskRole, agentType: s.agentType }, shownFloors(layoutRecord(pl.buildingKey, pl.repoPath)));
  }
  // The live sessions as the room rules read them (rooms.mjs settleRooms, viewRooms), oldest first.
  function liveRooms() {
    return live().filter((s) => s.placed).sort((a, b) => a.startedAt - b.startedAt)
      .map((s) => ({ pl: roomPlace(s), seat: seatOfSession(s), goal: s.goal, firstPrompt: s.firstPrompt }));
  }
  // Each git room is on the floors where its agents sit now and takes the best name its sessions offer. True when a record changed.
  function noteRooms() {
    const r = settleRooms(state.rooms, liveRooms());
    if (r.moved) { state.rooms = r.rooms; save(); }
    return r.moved;
  }
  const roomsView = () => viewRooms(state.rooms, liveRooms());
  // The layout of every building the page can show: each known repository, and Other folders when a session works there.
  function layoutsView() {
    const out = {};
    for (const [k, r] of repos.entries()) out[k] = layoutView(layoutRecord(k, r.path));
    if (live().some((s) => s.placed && !roomPlace(s).buildingKey)) out[''] = layoutView(layoutRecord('', ''));
    return out;
  }
  // A user change to the floors of a building (archetypes.mjs edit). 400 with the reason when it is not possible.
  function changeLayout(body) {
    const key = String(body.building ?? '');
    if (key && !repos.has(key)) throw fail(404, 'The office does not know that building.');
    let next;
    try { next = editLayout(layoutRecord(key, key ? repos.get(key).path : ''), body); } catch (e) { throw fail(400, e.message); }
    state.layouts[key] = next; save(); changed();
    return { ok: true, layout: layoutView(next) };
  }

  // ---- paper flow (#93): pull requests from gh, read-only ----
  const prReader = createPrReader({ run: git.ghRun });
  const prSeen = new Map(); // building key -> JSON of the last answer broadcast
  async function refreshChanges(k) {
    const r = repos.get(k);
    if (!r) return;
    const got = await prReader.read(k, r.path);
    const sig = JSON.stringify([got.ok, got.prs, got.mergedToday, readyFor(k, got.prs).map((e) => e.number)]);
    if (prSeen.get(k) !== sig) { prSeen.set(k, sig); if (!got.ok) console.warn(`The office could not read the pull requests of ${r.name}: ${got.why}`); changed(); }
  }
  // The Ready to merge entries of a building. The Quality record: an Operations Hub building lists a change only when a reviewer
  // session on its Quality floor is linked to the change by its branch.
  function readyFor(k, prs) {
    const r = repos.get(k);
    const hub = !!r && layoutRecord(k, r.path).archetype === 'ops-hub';
    const quality = new Set(live().filter((s) => s.placed && roomPlace(s).buildingKey === k && seatOfSession(s)?.floor === 'quality').map((s) => roomPlace(s).branch).filter(Boolean));
    return readyEntries(prs.map((p) => ({ ...p, repo: k })), { needQuality: hub, quality });
  }
  // Per building { ok, at, error?, mergedToday, prs, ready }. Not read yet means no entry (the page shows unknown).
  function changesView() {
    const out = {};
    for (const k of repos.keys()) {
      const got = prReader.peek(k);
      if (!got) continue;
      const prs = got.prs.map((p) => ({ ...p, repo: k }));
      out[k] = { ok: got.ok, at: got.at, error: got.error || null, mergedToday: got.mergedToday, prs, ready: readyFor(k, prs) };
    }
    return out;
  }
  // A pull request of a session was made: read the building's changes again.
  function changesStale(k) { prReader.invalidate(k); void refreshChanges(k); }
  // Merge a change: only one the office reads as ready now, and only after the user's confirm (409 with the question until then).
  async function mergeChange(body) {
    const k = String(body.repo ?? ''), n = Number(body.number);
    const r = repos.get(k);
    if (!r) throw fail(404, 'The office does not know that building.');
    if (!Number.isInteger(n) || n < 1) throw fail(400, 'Name the pull request number.');
    prReader.invalidate(k);
    const got = await prReader.read(k, r.path);
    const p = got.ok ? got.prs.find((x) => x.number === n) : null;
    if (!p) throw fail(409, 'PR state unknown. Check again in a moment.');
    if (p.state !== 'ready' || !readyFor(k, got.prs).some((e) => e.number === n)) throw fail(409, `#${n} is not ready to merge. ${p.state === 'ready' ? 'It has no Quality record yet.' : `Its state is ${p.state}.`}`);
    if (body.confirmed !== true) throw askFirst('merge', `Merge #${n} ${p.title} into ${p.base || 'main'}? This changes the repository on GitHub.`);
    await git.mergePr(r.path, mergeArgs(n));
    try { // the merge is done on GitHub: a failure to write the record must not read as a failed merge
      const rec = mergeRecord(k, p, now());
      state.merges = [rec, ...state.merges.filter((m) => m.key !== rec.key)].slice(0, MERGES_KEPT); save();
      feed({ uid: 'merge', name: r.name || 'Office' }, 'merge', `merged #${n} ${clip(p.title, 80)}`);
    } catch (e) { console.warn(`The office could not record the merge of #${n}: ${e.message}`); }
    prReader.invalidate(k); await refreshChanges(k);
    return { ok: true };
  }

  // ---- worktrees ----
  async function refreshRepo(k) {
    const r = repos.get(k);
    if (!r) return;
    void refreshChanges(k);
    const done = await git.refreshEntry(r); // a failed `git worktree list` changes nothing; overlapping refreshes keep the newest answer
    if (done === 'gone') { if (repos.get(k) === r) repos.delete(k); changed(); return; } // the folder is gone, or it is not a repository any more
    if (done === 'changed') { r.worktrees.forEach((w) => adoptNotes(placeOfWorktree(r.path, w))); dropGoneRooms(k, r); changed(); }
  }
  // A worktree that is gone takes its room records with it: the room leaves the building (#92).
  function dropGoneRooms(k, r) {
    const roots = new Set(r.worktrees.map((w) => repoKey(w.root)));
    let gone = false;
    for (const [nk, rec] of Object.entries(state.rooms)) if (rec.building === k && !roots.has(rec.root)) { delete state.rooms[nk]; gone = true; }
    if (gone) save();
  }
  // Never take a room away from a session that works in it.
  function roomInUse(root) {
    const r = repoKey(root);
    const sep = '\\'; // repoKey is normPath, which follows Windows rules on every host (place.mjs), so its separator is a backslash, not path.sep
    for (const s of live()) if (s.cwd) { const k = repoKey(s.cwd); if (k === r || k.startsWith(r.endsWith(sep) ? r : r + sep)) return s; }
    return null;
  }
  // The top of a worktree for the room board: each top-level folder with its file count. Only a worktree of a known repository.
  const treeCache = new Map();
  async function repoTree(root) {
    const k = repoKey(root || '-');
    const known = [...repos.values()].some((r) => r.worktrees.some((w) => repoKey(w.root) === k));
    if (!known) throw fail(404, 'The office does not know that folder.');
    const hit = treeCache.get(k);
    if (hit && now() - hit.t < treeTtlMs) return hit.v;
    const files = await git.files(root);
    const by = new Map();
    for (const f of files) {
      const i = f.indexOf('/');
      const name = i < 0 ? f : f.slice(0, i);
      const e = by.get(name) || { name, dir: i >= 0, files: 0 };
      e.files += 1; by.set(name, e);
    }
    const v = { root, total: files.length, entries: [...by.values()].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)).slice(0, 60) };
    treeCache.set(k, { t: now(), v });
    return v;
  }
  const branches = async (repo) => ({ branches: await git.floorCandidates(knownRepo(repo).path) });
  // Floors that are safe to delete now and have no session in them (the clean-up dialog's list).
  async function staleFloors(repo) {
    const r = knownRepo(repo);
    const wts = await git.layout(r.path);
    return { floors: (await git.staleFloors(r.path)).filter((f) => !wts.some((w) => onFloor(w, f.branch) && roomInUse(w.root))) };
  }
  // Git refusals (branch exists, not merged, uncommitted changes) are the user's to fix: answer 409.
  async function floorAction(action, body) {
    try { return await floorActionRaw(action, body); } catch (e) { throw e.status ? e : fail(409, e.message); }
  }
  async function floorActionRaw(action, body) {
    const r = knownRepo(body.repo);
    const branch = String(body.branch || '').trim();
    let out;
    if (action === 'create-floor') out = await git.createFloor(r.path, branch, String(body.from || '').trim(), String(body.name || ''));
    else if (action === 'create-room') out = await git.createRoom(r.path, branch, String(body.name || ''));
    else if (action === 'remove-room') {
      const s = roomInUse(String(body.root || ''));
      if (s) throw fail(409, `${s.name} works in this room. Close the session first.`);
      out = await git.removeRoom(r.path, String(body.root || ''), body.force === true);
    } else if (action === 'delete-floor') {
      // git's list, not the 30 s copy; the floor's rooms are its worktrees and the agent rooms that sit on it (#69 base)
      for (const w of (await git.layout(r.path)).filter((x) => onFloor(x, branch))) {
        const s = roomInUse(w.root);
        if (s) throw fail(409, `${s.name} works on this floor. Close the session first.`);
      }
      out = await git.deleteFloor(r.path, branch, body.force === true);
    } else if (action === 'cleanup-floors') {
      // Only floors that are still unused and safe now, whatever the page sent. Never forced.
      const safe = new Set((await git.staleFloors(r.path)).map((f) => f.branch));
      const wts = await git.layout(r.path);
      out = { deleted: [], skipped: [] };
      for (const b of (Array.isArray(body.branches) ? body.branches : []).map(String)) {
        const busy = wts.filter((w) => onFloor(w, b)).map((w) => roomInUse(w.root)).find(Boolean);
        if (!safe.has(b) || busy) { out.skipped.push(b); continue; }
        try { await git.deleteFloor(r.path, b, false); out.deleted.push(b); } catch { out.skipped.push(b); }
      }
    } else throw fail(400, 'Unknown action.');
    await refreshRepo(repoKey(r.path));
    return out;
  }

  // ---- recent folders that are in git are buildings too ----
  // git.locateOrKeep tries a passing failure 3 times; a folder that still got KEEP is asked again every 30 s. A folder that is
  // gone, not in git or refused by git is not asked again. A lookup that still runs is not started a second time.
  const unplacedRecent = new Set(recent);
  const placingRecent = new Set();
  function placeRecent() {
    for (const d of unplacedRecent) {
      if (placingRecent.has(d)) continue;
      placingRecent.add(d);
      git.locateOrKeep(d).then((g) => {
        placingRecent.delete(d);
        if (g === git.KEEP) return;
        unplacedRecent.delete(d);
        if (g) addRepo(g.repo);
      });
    }
  }
  // Start the lookups and the 30 s refresh loop. Returns the timer (unref'd).
  function start() {
    placeRecent();
    return setInterval(() => { for (const k of repos.keys()) void refreshRepo(k); placeRecent(); }, 30000).unref();
  }

  return { repoKey, addRepo, refreshRepo, knownRepo, reposView, layoutRecord, seatOfSession, noteRooms, roomsView, layoutsView, changeLayout,
    refreshChanges, changesStale, changesView, mergeChange, repoTree, branches, staleFloors, floorAction, start };
}
