/* Agent Office for Claude Code x0.2: snapshot store and building adapters.
   Two parts, no DOM, no EventSource, no network, no timers of its own (they are injected). The page loads it as a
   script (window.OfficeBuilding). The tests import it for its side effect and read globalThis.OfficeBuilding.

   Snapshot store (createStore): owns the latest snapshot, the people who listen to it, and the building
   adapters that are on screen.
     set(snap)             a whole snapshot
     receive(msg)          the SSE feed calls this for each message: a whole snapshot or a patch (wire.js);
                           false when a patch does not fit the latest snapshot (then connect again)
     latest()              the newest snapshot, or null
     onSnapshot(fn)        fn(snap) now (when there is one) and on each snapshot; returns an unsubscribe function
     buildings(snap?)      the buildings, busiest first
     requests(snap?)       every open request and question of every building, oldest first (Needs you)
     queue(snap?)          the one queue: { items (requests), count, oldest, find(id), reach(item) }; every surface that counts or opens a request reads it
     alerts(snap?)         those requests and the error of each session, as DS Notifier notifications
     preview(repo, snap?)  a building definition with its bots (cards and the city); it mounts nothing
     session(botName)      the open session of a bot in the building that is on screen
     lookup(botName)       the commands and skills of that session
     botName(uid)          the scene name of a seated bot
     kinds()               the agent kinds of the server (snapshot.kinds): label and the Open dialog's options
     kindWord(s)           the agent kind of a session as a word (OfficeVocab.kindWord)
     mount(repo)           a new building adapter for one building (below)

   Building adapter (store.mount(repo)): made once per mounted scene. It owns the mirror of what the scene was
   told, the layout of its floors and rooms, and the names of its bots. Nothing is shared between two of them, so a
   new building starts clean and there is no reset call.
     repo, id              the building key and a number that is new for each mount
     def                   the building definition for the scene (fixed at mount time)
     attach(emit)          the scene starts: replay the latest snapshot as DS events, then follow the store.
                           The replay is one pass with seeded: true on each event (and at, the real time, where
                           the snapshot has it), so the scene restores it with no toast, sound or onNotify.
                           A bot seated again on another floor is seeded too. Later news is not seeded.
     detach()              the scene stops: later snapshots and timers do nothing
     stale(snap?)          true when the scene shows a worktree room that is gone.
                           The DS has no event that removes a floor or a room, so the page mounts a new adapter.
     floorBranch(floorId)  the branch of a DS floor id in this scene, or null
     floorId(branch)       the DS floor id of a branch in this scene's definition, or null
                           OfficeBuilding.floorMemory() decides the floor a new scene opens on and keeps the user's
                           last pick per building (start, see, picked); OfficeBuilding.startFloor is its rule.
     roomInfo(roomId)      { sessions, place } of one room of this building
     figures(roomId)       the server's figures for that room
     noteKey(roomId)       the server's notes key for that room
     agentName(snap?)      the agent kinds of the building's open sessions as one word ('Claude Code, Ollama'), for
                           the scene's connection name; an empty building gives the first kind (a new session's
                           kind), and '' before any snapshot
     session(botName), lookup(botName), uidsOf(cmd), roomsShown()
   The scene's events are the DS events (kit/schema.json). */
(function (root) {
  'use strict';
  var V = root.OfficeVocab;
  // The worst state of a set of desks: the DS's one order (AgentOffice.worstOf, the order the elevator lights its buttons in),
  // read at the call, so this file loads without the DS (the page loads the bundle first; the tests give it the bundle too).
  function worst(list) { return root.AgentOffice.worstOf(list); }
  var SHAPES = ['cone', 'blob', 'octa', 'capsule'];
  var OTHER = 'Other folders';
  var REMOVE_AFTER_MS = 6000;
  var HISTORY_CALLS = 12;   // calls shown in the trace when the page opens mid-session
  var USAGE_REPEAT_MS = 15000;

  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function shapeOf(uid) { return SHAPES[hash(String(uid)) % SHAPES.length]; }
  // The body color of a bot: one of the DS shape colors, picked from the uid apart from the shape, so bots of the
  // same shape still differ. The scene and every list read this one value, so a bot looks the same everywhere.
  // Without the DS bundle (tests) there is no color and the DS picks its own.
  function colorOf(uid) {
    var c = root.AgentOffice && root.AgentOffice.BOT_COLORS;
    if (!c) return undefined;
    var v = Object.keys(c).map(function (k) { return c[k]; });
    return v.length ? v[Math.floor(hash(String(uid)) / SHAPES.length) % v.length] : undefined;
  }
  function withColor(bot, uid) { var c = colorOf(uid); if (c) bot.color = c; return bot; }
  // A Paperclip run (#76, s.hq from the server): the card's owner line is its company and its Paperclip agent. cardOf is what
  // the card shows that only bot.add sets (the owner and the role in the platform line), to seat the bot again on a change.
  function ownerOf(s) { return s && s.hq ? s.hq.company + ' (' + s.hq.agent + ')' : ''; }
  function cardOf(s) { return s && s.hq ? ownerOf(s) + '|' + s.hq.role : ''; }
  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function base(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; }
  // A subagent's type picks its role: the workstation and the icon.
  function helperRole(type) {
    if (/explore|research|search|guide/i.test(type)) return 'research';
    if (/plan|architect/i.test(type)) return 'planner';
    if (/review|verif|audit|security/i.test(type)) return 'analyst';
    if (/doc|writ/i.test(type)) return 'writer';
    return 'coder';
  }
  function argsOf(c) { if (!c.detail) return undefined; var a = {}; a[V.toolArg(c.name)] = c.detail; return a; }
  // at: the real time of an event, where the snapshot has it (DS common field; Since you left counts a seeded event by it)
  function stamp(e, t) { if (typeof t === 'number' && t > 0) e.at = t; return e; }
  function hostOf(url) { return String(url).replace(/^https?:\/\//, '').split('/')[0] || String(url); }

  // Where a session sits: building (repo), room (worktree folder), and the branch as a label. The server computes it
  // (place.mjs) and sends it as session.place and worktree.place; this only renames the fields.
  function fromPlace(p) {
    return { repo: p.buildingKey, repoName: p.building, branch: p.branch != null ? p.branch : p.floor, root: p.rootKey, roomName: p.room, roomId: p.roomId, noteKey: p.noteKey, path: p.root, securityRoomId: p.securityRoomId, repoPath: p.repoPath || '', agentRoom: !!p.baseBranch };
  }
  // The Security room (#70): first on the ground floor of every building, no bots, never a worktree (no layout entry, no
  // notes key, never stale). Its id comes from the server (place.mjs securityRoomIdOf, in each place and repo entry).
  function securityDef(id) {
    var S = V.security;
    return { id: id, type: 'security', name: S.roomName, bots: [], screens: S.screens.map(function (x) { return x.title; }) };
  }
  function placeOf(s) { return fromPlace(s.place); }
  // A seat: building, floor key and workspace. A change of any of them seats the bot again.
  function placeKey(pl, fn) { return pl.repo + '|' + (fn || '') + '|' + pl.root; }
  function repoOf(snap, key) { return ((snap && snap.repos) || []).filter(function (r) { return r.key === key; })[0] || null; }
  function live(snap) { return (snap ? snap.sessions : []).filter(function (s) { return s.status !== 'ended' && s.place; }); }

  // ---------- function floors (#92) ----------
  // The floors of a building come from its archetype (the server's snapshot.layouts[building], archetypes.mjs layoutView):
  // the Lobby on the ground floor, the function floors, Records on top. A building the server has no layout for yet has
  // the Lobby only. DS floor ids are 1, 2, ... in that order for one mount; every match across mounts is by floor key
  // (the function id: 'lobby', 'engineering', ...).
  var LOBBY = 'lobby', RECEPTION = 'reception', SPARE = 'spare-';
  var WING_KEY = { '': 'ops', product: 'research', market: 'sales', corporate: 'content', operations: 'ops', leadership: 'hq' };
  var BARE = [{ id: LOBBY, name: 'Lobby', wing: '', wingName: '', role: 'planner', hidden: false, fixed: true }];
  function layoutOf(snap, repo) { var l = snap && snap.layouts && snap.layouts[repo]; return l && Array.isArray(l.floors) && l.floors.length ? l : null; }
  function shownFloors(snap, repo) { var l = layoutOf(snap, repo); return (l ? l.floors : BARE).filter(function (f) { return !f.hidden; }); }
  // The floor of a session: the server's seat (place.mjs seatOf), or the Lobby when the building does not show that floor.
  function seatOf(s, shown) { var f = s.seat && s.seat.floor; return f && shown.some(function (x) { return x.id === f; }) ? f : LOBBY; }
  function roomRec(snap, nk) { return (snap && snap.rooms && snap.rooms[nk]) || null; }
  // A room's name comes from its task (the server's room record, place.mjs roomTitle); the folder name until it has one.
  function titleOf(snap, pl) { var r = roomRec(snap, pl.noteKey); return clip((r && r.title && r.title.name) || pl.roomName, 40); }
  // A workspace two or more agents work in, or the main checkout (ad-hoc sessions there can collide), is shared. An isolated
  // room (an agent worktree with at most one agent) is private. A folder outside git with one agent has no tag.
  function tagOf(snap, pl) {
    var n = live(snap).filter(function (x) { var p = placeOf(x); return p.repo === pl.repo && p.root === pl.root; }).length;
    if (n >= 2 || (pl.repo && pl.root === pl.repo)) return 'shared';
    return pl.repo ? 'private' : '';
  }
  var TAG_WORD = { shared: 'Shared workspace', private: 'Private' };
  // The small print on the room sign: the branch (or the folder outside git) and the tag.
  function noteOf(snap, pl) { var t = TAG_WORD[tagOf(snap, pl)]; return clip(pl.repo ? pl.branch : base(pl.path), 28) + (t ? ' · ' + t : ''); }
  function floorDef(id, f, rooms) { return { id: id, key: WING_KEY[f.wing] || 'ops', name: clip(f.name, 22), wing: f.wing || '', wingName: f.wingName || '', fn: f.id, rooms: rooms }; }
  // A room is a workspace on one floor. A workspace with agents on two floors is a room on each; the first one (its home)
  // keeps the place room id, the other gets the floor key added, so DS room ids stay unique in the building.
  function roomIdOn(pl, fn, home) { return fn === home ? pl.roomId : pl.roomId + '~' + fn; }
  function baseRoomId(id) { return String(id || '').split('~')[0]; }
  var EMPTY_NOTE = 'No agents here. Click a desk to start one.';
  // role: the DS role of the floor; the open desks are its desk type
  function roomDef(snap, pl, id, role) { return { id: id, type: 'lab', name: titleOf(snap, pl), note: noteOf(snap, pl), bots: [], spare: 1, spareRole: role || 'coder' }; }
  function spareDef(fn, role) { return { id: SPARE + fn, type: 'lab', name: 'Open desks', note: EMPTY_NOTE, bots: [], spare: 2, spareRole: role || 'coder' }; }
  function receptionDef() { return { id: RECEPTION, type: 'lobby', name: 'Reception', note: 'Open desks for agents with no role', bots: [], spare: 2 }; }

  // The rooms a building wants now, in order, as [{ fn, pl }]: each worktree room on each floor its record names, then each
  // live session's room on the floor of its seat. homes: root -> the floor of its first room.
  function wanted(snap, repo, shown) {
    var out = [], seen = {}, homes = {}, has = function (fn) { return shown.some(function (f) { return f.id === fn; }); };
    function want(fn, pl) { var k = fn + '|' + pl.root; if (seen[k]) return; seen[k] = true; if (!homes[pl.root]) homes[pl.root] = fn; out.push({ fn: fn, pl: pl }); }
    var rp = repoOf(snap, repo);
    if (rp) rp.worktrees.forEach(function (w) {
      var pl = fromPlace(w.place), rec = roomRec(snap, pl.noteKey);
      if (rec && Array.isArray(rec.floors)) rec.floors.forEach(function (fn) { if (has(fn)) want(fn, pl); });
    });
    live(snap).slice().sort(function (a, b) { return (a.startedAt || 0) - (b.startedAt || 0); }).forEach(function (s) {
      var pl = placeOf(s);
      if (pl.repo === repo) want(seatOf(s, shown), pl);
    });
    return { list: out, homes: homes };
  }

  // Rooms that exist now for one building, as roots: worktrees and the folders of open sessions.
  function roomsNow(snap, repo) {
    var rp = repoOf(snap, repo), out = {};
    if (rp) rp.worktrees.forEach(function (w) { out[w.place.rootKey] = true; });
    live(snap).forEach(function (s) { var pl = placeOf(s); if (pl.repo === repo) out[pl.root] = true; });
    return out;
  }

  // The buildings: one per repository known or in use, busiest first. state: the worst state of its desks (the city windows).
  function buildings(snap) {
    var by = {};
    ((snap && snap.repos) || []).forEach(function (r) {
      by[r.key] = { key: r.key, name: r.name, path: r.path, sessions: 0, waiting: 0, last: 0, floors: shownFloors(snap, r.key).length, states: [] };
    });
    live(snap).forEach(function (s) {
      var pl = placeOf(s), b = by[pl.repo] || (by[pl.repo] = { key: pl.repo, name: pl.repoName, sessions: 0, waiting: 0, last: 0, floors: shownFloors(snap, pl.repo).length, states: [] });
      b.sessions++; b.last = Math.max(b.last, s.lastEvent || 0);
      b.waiting += V.requests(s).length;
      b.states.push(V.status(s).key);
    });
    return Object.keys(by).map(function (k) { var b = by[k]; b.state = worst(b.states); delete b.states; return b; })
      .sort(function (a, b) { return b.waiting - a.waiting || b.sessions - a.sessions || b.last - a.last || a.name.localeCompare(b.name); });
  }

  // ---------- paper flow (#93): a change is a folder that travels, agents and rooms stay ----------
  // The server reads `gh` (read-only) and the snapshot carries `changes` per building. A building with no read yet, a failed read or
  // a read older than STALE_MS is unknown: the page never shows old data as live. The folder shapes and words are OfficeVocab.folderOf.
  var STALE_MS = 3 * 60000;
  var ADVANCE = ['unknown', 'closed', 'merged', 'draft', 'open', 'conflict', 'checks', 'changes', 'review', 'approved', 'ready'];   // which folder shows when a desk has several
  var STAGES = [['intake', 'Intake'], ['build', 'Build'], ['check', 'Check'], ['review', 'Review'], ['gate', 'Gate'], ['merge', 'Merge'], ['release', 'Release'], ['record', 'Record']];
  // One building: { unknown, line, folders, tray, pipeline, mergedToday, at }. now: the clock, for tests.
  function changes(snap, key, now) {
    var e = snap && snap.changes && snap.changes[key], t = now == null ? Date.now() : now;
    var unknownOut = function (line) { return { unknown: true, line: line, folders: [], tray: [], mergedToday: 0, at: e ? e.at : 0, pipeline: STAGES.map(function (s) { return { id: s[0], name: s[1], count: 0, unknown: true }; }) }; };
    if (!e) return unknownOut('PR state unknown');
    if (!e.ok) return unknownOut(e.error || 'PR state unknown');
    if (t - e.at > STALE_MS) return unknownOut('PR state unknown');
    var folders = (e.prs || []).map(function (p) { var f = V.folderOf(p.state); return { number: p.number, title: p.title, head: p.head, base: p.base, url: p.url, state: p.state, stage: p.stage, checks: p.checks, reviewer: p.reviewer, diff: p.diff, word: f.word, place: f.place, mark: f.mark, glyph: f.glyph }; });
    var STAGE_HAS = { build: 1, check: 1, review: 1, gate: 1, merge: 1, record: 1 };
    var pipeline = STAGES.map(function (s) { return { id: s[0], name: s[1], count: folders.filter(function (f) { return f.stage === s[0] && f.state !== 'merged' && f.state !== 'closed'; }).length, unknown: !STAGE_HAS[s[0]] }; });
    return { unknown: false, line: '', folders: folders, tray: e.ready || [], pipeline: pipeline, mergedToday: e.mergedToday || 0, at: e.at };
  }
  // The folder on a desk or in a room, by its branch: the most advanced change shows, the rest are a count (`more`). null: none.
  function folderAt(c, branch) {
    var mine = ((c && c.folders) || []).filter(function (f) { return f.head === branch && f.state !== 'merged' && f.state !== 'closed'; });
    if (!mine.length) return null;
    mine.sort(function (a, b) { return ADVANCE.indexOf(b.state) - ADVANCE.indexOf(a.state) || b.number - a.number; });
    return Object.assign({}, mine[0], { more: mine.length - 1 });
  }
  // The Ready to merge entries of every building, oldest first: a decision with no session behind it (uid null). They count toward Needs you.
  function mergeRequests(snap, now) {
    var out = [];
    ((snap && snap.repos) || []).forEach(function (r) {
      var c = changes(snap, r.key, now);
      c.tray.forEach(function (m) { out.push(Object.assign({}, m, { uid: null, bot: 'Ready to merge', building: r.key, buildingName: r.name, roomName: '#' + m.number, t: c.at })); });
    });
    return out;
  }

  // Every open request and question of every building, oldest first. This is the Needs you list.
  // The rule for one session's items is OfficeVocab.requests (one owner); this adds who and where, and the
  // preview of a request. kind is 'permission' or 'question'; a question has no risk, so a bulk action never answers one.
  function requests(snap, now) {
    var out = [];
    live(snap).forEach(function (s) {
      var pl = placeOf(s), base = { uid: s.uid, bot: s.name, building: pl.repo, buildingName: pl.repoName, roomName: pl.roomName };
      V.requests(s).forEach(function (r) {
        var pend = (s.pending || []).filter(function (x) { return x.id === r.id; })[0];
        out.push(Object.assign({}, r, base, { preview: pend ? (pend.preview || pend.detail || '') : '' }));
      });
    });
    return out.concat(mergeRequests(snap, now)).sort(function (a, b) { return a.t - b.t; });
  }
  // The one queue (#146): everything that waits on the user, across buildings, oldest first. Every surface that shows a
  // request count or opens a request reads this, so the counts agree and no request is out of reach. reach(item) says how
  // an item opens with Approve and Decline in view: at its desk (a session), else in the Needs you list (a merge decision).
  function queue(snap, now) {
    var items = requests(snap, now);
    return {
      items: items, count: items.length, oldest: items[0] || null,
      find: function (id) { return items.filter(function (r) { return r.id === id; })[0] || null; },
      reach: function (r) { return !r ? null : r.uid ? { via: 'desk', uid: r.uid, id: r.id } : { via: 'list' }; }
    };
  }
  // Browser alerts for the page's one Notifier: each open request and each failed turn of every building.
  // An error id holds the error's own id, so a new failure is a new alert.
  function alerts(snap) {
    var out = requests(snap).map(function (r) { return { id: r.id, kind: 'request', bot: r.bot, risk: r.risk, text: r.buildingName + '. ' + r.text, uid: r.uid, building: r.building }; });
    live(snap).forEach(function (s) {
      if (!s.error) return;
      var pl = placeOf(s);
      out.push({ id: 'error:' + s.uid + ':' + s.error.id, kind: 'error', bot: s.name, text: pl.repoName + '. ' + s.error.text, uid: s.uid, building: pl.repo });
    });
    return out;
  }

  // A name no other bot of the building has (a folder name used twice gets a number): the rule of a scene's bot names.
  function previewName(taken, base) {
    var n = base || 'session', i = 2;
    while (taken[n]) n = base + ' ' + i++;
    taken[n] = true;
    return n;
  }

  // A building definition: the shown floors of its layout, bottom up. The Lobby holds the Security room, the Reception (open
  // desks for agents with no role) and the rooms of agents seated there. A function floor holds the rooms of its agents, or
  // one room of open desks when it has none. With bots, each room also lists its sessions (for previews); the scene gets
  // its bots from events instead.
  // Returns { def, floors: { fn: { id, rooms: { root: roomId }, spare } }, homes, keys: { roomId: noteKey }, roots: { roomId: root },
  //           security, sig }. sig: the floor keys in order (a change of it needs a new mount).
  function describe(repo, snap, withBots) {
    var name = repo ? '' : OTHER, bots = {}, taken = {};
    var shown = shownFloors(snap, repo), w = wanted(snap, repo, shown);
    live(snap).forEach(function (s) {
      var pl = placeOf(s);
      if (pl.repo === repo) name = pl.repoName;
      if (withBots && pl.repo === repo) {
        var fn = seatOf(s, shown), fl = shown.filter(function (f) { return f.id === fn; })[0];
        (bots[fn + '|' + pl.root] = bots[fn + '|' + pl.root] || []).push(withColor({ uid: s.uid, name: previewName(taken, s.name), role: (fl && fl.role) || 'coder', shape: shapeOf(s.uid), status: V.status(s).key, word: V.status(s).word, task: V.taskLine(s) }, s.uid));
      }
    });
    var rp = repoOf(snap, repo);
    if (rp) name = rp.name;
    var map = {}, keys = {}, roots = {}, signs = {}, places = {};
    var floors = shown.map(function (f, i) {
      var id = i + 1, rooms = [], m = map[f.id] = { id: id, rooms: {}, spare: false };
      w.list.forEach(function (x) {
        if (x.fn !== f.id) return;
        var rid = roomIdOn(x.pl, f.id, w.homes[x.pl.root]), r = roomDef(snap, x.pl, rid, f.role);
        m.rooms[x.pl.root] = rid; keys[rid] = x.pl.noteKey; roots[rid] = x.pl.root; places[rid] = x.pl; signs[rid] = r.name + '\n' + r.note;
        if (withBots) r.bots = bots[f.id + '|' + x.pl.root] || [];
        rooms.push(r);
      });
      if (f.id === LOBBY) rooms.unshift(receptionDef());
      else if (!rooms.length) { rooms.push(spareDef(f.id, f.role)); m.spare = true; }
      return floorDef(id, f, rooms);
    });
    var mine = live(snap).map(placeOf).filter(function (pl) { return pl.repo === repo && pl.securityRoomId; })[0];
    var sec = (rp && rp.securityRoomId) || (mine && mine.securityRoomId) || null;
    if (sec) floors[0].rooms.unshift(securityDef(sec));
    return { def: { name: name || (repo ? base(repo) : OTHER), sessions: 'agent', floors: floors }, floors: map, homes: w.homes, keys: keys, roots: roots, places: places, signs: signs, security: sec,
      sig: shown.map(function (f) { return f.id; }).join('|') };
  }

  function createStore(opts) {
    opts = opts || {};
    var now = opts.now || Date.now;
    var defer = opts.defer || function (fn) { setTimeout(fn, 0); };
    var later = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var latest = null, listeners = [], attached = [], mountSeq = 0;
    var store = {};

    store.latest = function () { return latest; };
    // The older replies of a session that the lean snapshot left out (#80). The page asks the server once (opts.fetchReplies(uid)
    // gives the session's whole reply list) and keeps the answer; a failure is told once (opts.onProblem(text)) and the chat
    // shows the newest replies. A new scene tries again (attach clears the failures), so a failure that stays tells the page once per scene,
    // one more error toast for each building change. Entries of sessions that are gone are dropped.
    var oldReplies = {}, oldAsked = {}, oldFailed = {}, FETCH_MS = 15000;
    // firstId: the id of the newest-window's first reply. Answers { list } (replies older than that, in order), { wait } or { none }.
    function loadOlder(uid, firstId) {
      var have = oldReplies[uid];
      if (have && have.length && have[have.length - 1].id < firstId - 1) have = oldReplies[uid] = null;   // replies came since: a gap, ask again
      if (have) return { list: have.filter(function (r) { return r.id < firstId; }) };
      if (!opts.fetchReplies || oldFailed[uid]) return { none: true };
      if (!oldAsked[uid]) {
        // A request that never answers fails after FETCH_MS, like one that fails: a held bot must not wait for ever.
        var token = oldAsked[uid] = {};
        var finish = function (list) {
          if (oldAsked[uid] !== token) return;   // settled already (the answer or the wait ran out)
          delete oldAsked[uid];
          if (list) oldReplies[uid] = Array.isArray(list) ? list : [];
          else {
            oldFailed[uid] = true;
            if (opts.onProblem) { try { opts.onProblem('The chat shows only the newest replies. The older replies did not load.'); } catch (x) { /* a bad listener must not stop the office */ } }
          }
          attached.slice().forEach(function (m) { m._follow(latest); });
        };
        Promise.resolve().then(function () { return opts.fetchReplies(uid); }).then(function (list) { finish(list || []); }, function () { finish(null); });
        later(function () { finish(null); }, FETCH_MS);
      }
      return { wait: true };
    }
    store.set = function (snap) {
      latest = snap;
      var live = {};
      (snap.sessions || []).forEach(function (s) { live[s.uid] = true; });
      [oldReplies, oldFailed].forEach(function (c) { Object.keys(c).forEach(function (u) { if (!live[u]) delete c[u]; }); });
      attached.slice().forEach(function (m) { m._follow(snap); });
      listeners.slice().forEach(function (fn) { try { fn(snap); } catch (x) { /* a bad listener must not stop the office */ } });
    };
    // One /events message (wire.js): a whole snapshot, or a patch on top of the latest one. False when a patch does
    // not start from the latest snapshot (nothing changes then): the caller connects again for a whole snapshot.
    store.receive = function (msg) {
      if (!msg || !msg.patch) { store.set(msg); return true; }
      if (!root.OfficeWire.fits(latest, msg)) return false;
      store.set(root.OfficeWire.apply(latest, msg));
      return true;
    };
    store.onSnapshot = function (fn) {
      listeners.push(fn);
      if (latest) { try { fn(latest); } catch (x) { /* a bad listener must not stop the office */ } }
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    };
    store.buildings = function (snap) { return buildings(snap || latest); };
    store.requests = function (snap) { return requests(snap || latest); };
    store.queue = function (snap) { return queue(snap || latest); };
    store.alerts = function (snap) { return alerts(snap || latest); };
    store.preview = function (repo, snap) { return describe(repo, snap || latest, true).def; };
    store.shapeOf = shapeOf;
    store.colorOf = colorOf;
    store.buildingOf = function (s) { return s.place ? s.place.buildingKey : ''; };
    store.sessionByUid = function (uid) { return latest && latest.sessions.filter(function (x) { return x.uid === uid; })[0] || null; };
    // The agent kinds the server runs (providers/index.mjs describe), and the kind of one session as a word (vocab.js).
    store.kinds = function () { return (latest && latest.kinds) || []; };
    store.kindWord = function (s) { return V.kindWord(s, store.kinds()); };
    // The building that is on screen: the one attached last.
    function current() { return attached.length ? attached[attached.length - 1] : null; }
    store.session = function (botName) { var m = current(); return m ? m.session(botName) : null; };
    store.lookup = function (botName) { var m = current(); return m ? m.lookup(botName) : null; };
    store.botName = function (uid) { var m = current(); return m ? m.botName(uid) : null; };

    store.mount = function (repo) {
      var d = describe(repo, latest, false);
      function freshLayout() { return { floors: JSON.parse(JSON.stringify(d.floors)), homes: Object.assign({}, d.homes), keys: Object.assign({}, d.keys), roots: Object.assign({}, d.roots), places: Object.assign({}, d.places), signs: Object.assign({}, d.signs) }; }
      var layout = freshLayout();
      // The shown floors this scene was built with: their keys in order (a change needs a new mount) and their names (a
      // rename is a floor.update in place).
      var shown0 = shownFloors(latest, repo), names = {};
      shown0.forEach(function (f) { names[f.id] = clip(f.name, 22); });
      // Rooms that were a worktree of this building. Only a worktree that goes makes the scene stale: a room a
      // session made stays on screen, empty, when the session ends, and the next session in that folder uses it.
      var wtSeen = {};
      function seeWorktrees(snap) { var rp = repoOf(snap, repo); if (rp) rp.worktrees.forEach(function (w) { wtSeen[w.place.rootKey] = true; }); }
      seeWorktrees(latest);
      var known = {};   // uid -> mirror of what the scene was told
      var taken = {};   // bot name -> true. A helper name stays here for the life of the mount (#94).
      var emitRef = null, lastUsage = { percent: null, t: 0 };
      var primed = false, seedSnap = null;   // the first pass ran; the snapshot it restores (the store's at attach)
      var m = { repo: repo, id: ++mountSeq, def: d.def };

      function uniqueName(b) {
        return previewName(taken, b);
      }
      // The room of a workspace on one floor of this building (fn: a shown floor key). Adds the room when it is new: the floor's
      // room of open desks becomes it (room.update), or it joins the floor (room.add). A room never changes floor.
      function roomOf(pl, fn, emit, snap) {
        var f = layout.floors[fn] || layout.floors[LOBBY];
        if (!layout.floors[fn]) fn = LOBBY;
        if (f.rooms[pl.root]) return f.rooms[pl.root];
        if (!layout.homes[pl.root]) layout.homes[pl.root] = fn;
        var fr = shownFloors(snap, repo).filter(function (x) { return x.id === fn; })[0];
        var id = roomIdOn(pl, fn, layout.homes[pl.root]), r = roomDef(snap, pl, id, fr && fr.role);
        layout.keys[id] = pl.noteKey; layout.roots[id] = pl.root; layout.places[id] = pl; layout.signs[id] = r.name + '\n' + r.note;
        f.rooms[pl.root] = id;
        if (f.spare) {
          f.spare = false;
          emit({ type: 'room.update', roomId: SPARE + fn, room: { id: id, name: r.name, note: r.note, spare: r.spare, spareRole: r.spareRole } });
          return id;
        }
        emit({ type: 'room.add', floorId: f.id, room: r });
        return id;
      }
      // Names and small print of the rooms on screen follow the snapshot (a first prompt names a room; a second agent makes it shared).
      function syncRooms(snap, emit) {
        Object.keys(layout.floors).forEach(function (fn) {
          var f = layout.floors[fn];
          Object.keys(f.rooms).forEach(function (root) {
            var id = f.rooms[root], pl = placeFor(snap, root);
            if (!pl) return;
            var name = titleOf(snap, pl), note = noteOf(snap, pl), sig = name + '\n' + note;
            if (layout.signs[id] === sig) return;
            layout.signs[id] = sig;
            emit({ type: 'room.update', roomId: id, room: { name: name, note: note } });
          });
        });
        shownFloors(snap, repo).forEach(function (fl) {
          var n = clip(fl.name, 22), f = layout.floors[fl.id];
          if (!f || names[fl.id] === n) return;
          names[fl.id] = n;
          emit({ type: 'floor.update', floorId: f.id, floor: { name: n } });
        });
      }
      // The place of a workspace of this building: a live session's, else its worktree's.
      function placeFor(snap, root) {
        var s0 = live(snap).filter(function (x) { var p = placeOf(x); return p.repo === repo && p.root === root; })[0];
        if (s0) return placeOf(s0);
        var rp = repoOf(snap, repo), w = rp && rp.worktrees.filter(function (x) { return x.place.rootKey === root; })[0];
        return w ? fromPlace(w.place) : null;
      }

      function syncHelpers(s, k, emit) {
        (s.agents || []).forEach(function (a) {
          var hn = k.helpers[a.call];
          if (!hn && !a.done) {
            hn = k.helpers[a.call] = uniqueName(k.name + ' ' + a.type);
            emit({ type: 'delegate', bot: k.name, roomId: k.room, spawn: { name: hn, role: helperRole(a.type), shape: 'blob' }, task: clip(a.task, 80) || 'Subagent task' });
          }
          if (hn && a.done && !k.helpersDone[a.call]) {
            k.helpersDone[a.call] = true;
            // The name stays taken: the bot walks out for a while, and a helper that got the same name would
            // be sent back in with it (#94).
            emit({ type: 'subagent.done', bot: hn, remove: true, result: a.ok ? 'Returned its result' : 'Stopped before it finished' });
          }
        });
        // The tracker keeps only the last 20 agents: an open helper it cut is gone from the list and never shows
        // as done, so send it away here, once (#116). The name stays taken (#94).
        var listed = {};
        (s.agents || []).forEach(function (a) { listed[a.call] = true; });
        Object.keys(k.helpers).forEach(function (call) {
          if (k.helpersDone[call] || listed[call]) return;
          k.helpersDone[call] = true;
          emit({ type: 'subagent.done', bot: k.helpers[call], remove: true, result: 'Stopped before it finished' });
        });
      }
      // The session leaves the scene (it moved, or the server forgot it): its helpers get no finish event from the
      // tracker, so send them away here. A helper that already finished is not told twice (#95). why is the result text:
      // a moved session keeps working, so its helpers are not "stopped"; they go on in the new room.
      function dismissHelpers(k, emit, why) {
        Object.keys(k.helpers).forEach(function (call) {
          if (k.helpersDone[call]) return;
          k.helpersDone[call] = true;
          emit({ type: 'subagent.done', bot: k.helpers[call], remove: true, result: why });
        });
      }
      // seat: for a bot seated again, { prev, out }: the mirror of its old seat and the live emitter. A call (or a
      // result) the old seat never showed is news and goes out live; the rest is a restore.
      function syncCalls(s, k, emit, quiet, seat) {
        var byAgent = {};
        (s.agents || []).forEach(function (a) { if (a.id && k.helpers[a.call] && !k.helpersDone[a.call]) byAgent[a.id] = k.helpers[a.call]; });
        (s.calls || []).forEach(function (c) {
          var seen = k.calls[c.id], old = seat && seat.prev.calls[c.id];
          if (!seen) {
            var who = (c.agent && byAgent[c.agent]) || k.name, fresh = !!seat && !old, ec = fresh ? seat.out : emit;
            seen = k.calls[c.id] = { bot: who, closed: false };
            ec(stamp({ type: 'tool.call', bot: who, id: c.id, tool: V.toolShort(c.name), kind: V.toolKind(c.name), args: argsOf(c), say: !quiet || fresh }, c.t));
            if (c.name === 'Skill' && c.detail) ec(stamp({ type: 'skill.load', bot: who, skill: c.detail }, c.t));
            if (c.name === 'WebFetch' && c.detail) ec(stamp({ type: 'knowledge', bot: who, source: hostOf(c.detail), text: c.detail }, c.t));
            if (c.name === 'WebSearch' && c.detail) ec(stamp({ type: 'knowledge', bot: who, source: 'Web search', text: c.detail }, c.t));
          }
          if (!seen.closed && c.ok !== null) {
            seen.closed = true;
            var r = { type: 'tool.result', bot: seen.bot, id: c.id, ok: c.ok };
            if (typeof c.ms === 'number') { r.ms = c.ms; stamp(r, c.t + c.ms); }
            if (c.err) r.summary = c.err;
            (seat && !(old && old.closed) ? seat.out : emit)(r);
          }
        });
      }
      function syncPlan(s, k, emit) {
        var todos = s.todos || [];
        if (!todos.length) return;
        var sig = todos.map(function (t) { return t.text; }).join('\n');
        if (sig !== k.planSig) {
          k.planSig = sig; k.planState = todos.map(function (t) { return t.status; });
          emit({ type: 'plan', bot: k.name, goal: clip(s.prompt, 120) || 'Plan', steps: todos.map(function (t, i) { return { id: 't' + i, text: t.text, status: V.todoStatus(t) }; }) });
          return;
        }
        todos.forEach(function (t, i) {
          if (k.planState[i] === t.status) return;
          k.planState[i] = t.status;
          emit({ type: 'plan.step', bot: k.name, id: 't' + i, status: V.todoStatus(t) });
        });
      }

      // seedAll: the first pass of a newly attached scene. Every event of it restores state the office already had,
      // so it carries seeded: true, with its real time (at) where the snapshot has one (DS Reference, Scene mount).
      // A restore inside a live pass (a bot seated again on another floor, an error a bot had before the scene saw it)
      // is seeded without at: a seeded event with at after the last visit is news to the DS, so it would be recorded twice.
      // out: the emitter of this pass.
      function apply(snapshot, out, seedAll) {
        var seen = {};
        var seeded = function (e) { e.seeded = true; out(e); };
        var restore = function (e) { delete e.at; seeded(e); };
        var base = seedAll ? seeded : out;
        // empty rooms: worktrees of this building that no session uses
        var shownNow = shownFloors(snapshot, repo), want = wanted(snapshot, repo, shownNow);
        want.list.forEach(function (x) { if (!layout.homes[x.pl.root] && want.homes[x.pl.root]) layout.homes[x.pl.root] = want.homes[x.pl.root]; });
        // rooms with no agent of this building on that floor (a worktree's record); a session's room comes when it is seated
        var seated = {};
        live(snapshot).forEach(function (s) { var p = placeOf(s); if (p.repo === repo) seated[seatOf(s, shownNow) + '|' + p.root] = true; });
        want.list.forEach(function (x) { if (!seated[x.fn + '|' + x.pl.root]) roomOf(x.pl, x.fn, base, snapshot); });
        syncRooms(snapshot, base);
        snapshot.sessions.forEach(function (s) {
          if (!s.place) return;   // wait until the server knows the repo and branch
          var pl = placeOf(s), k = known[s.uid], emit = base, prev = null, fn = pl.repo === repo ? seatOf(s, shownNow) : '';
          // the session checked out another branch, or moved to another folder: seat it again. So does a changed card line
          // (a supervision label: an agent whose config turned out not to ask; a Paperclip role and company, #76, once the office
          // watches that company): the DS sets the card's platform and owner lines only when the bot is added.
          if (k && !k.ended && (k.place !== placeKey(pl, fn) || k.sup !== V.supervision(s) || k.card !== cardOf(s))) {
            dismissHelpers(k, emit, 'Moved with its session');
            emit({ type: 'bot.remove', bot: k.name }); delete taken[k.name]; delete known[s.uid];
            prev = k; k = null;
            emit = restore;   // the scene showed this bot and what its old seat lists (prev) already
          }
          if (pl.repo !== repo) return;   // another building
          seen[s.uid] = true;
          // Per item of a bot seated again: what the old seat showed is a restore, anything else is news.
          var pick = function (old) { return prev && !old ? out : emit; };
          if (!k) {
            if (s.status === 'ended') return;
            var name = uniqueName(s.name);
            k = known[s.uid] = { asked: {}, inbox: 0, replySeen: 0, name: name, status: V.status(s).key, task: V.taskLine(s), calls: {}, helpers: {}, helpersDone: {}, planSig: '', planState: [], errorSeen: 0, olderDone: false, held: false, firstKind: seedAll ? 'seed' : 'restore', prevSeen: prev ? prev.replySeen : null, errKind: seedAll ? 'seed' : 'restore', errPrev: prev ? prev.errorSeen : null, model: s.model, ended: false, place: placeKey(pl, fn), sup: V.supervision(s), room: roomOf(pl, fn, emit, snapshot), fn: fn, card: cardOf(s) };
            // platform: the line on the bot's card: the supervision label of an ungated agent, else its agent kind (Claude Code,
            // Ollama, ...), the same word every list shows (vocab.js)
            // The old seat held its replies (the older ones were still loading), so it told none of them: this seat tells them
            // the way the old seat would have (a first sight, or what it had seen before), and keeps the wait for newer ones.
            // The same for its error: errKind and errPrev say how the error is told, because the pass that tells it may come later.
            if (prev && prev.held) { k.firstKind = prev.firstKind; k.prevSeen = prev.prevSeen; k.holdTop = prev.holdTop; k.errKind = prev.errKind; k.errPrev = prev.errPrev; k.errTop = prev.errTop; }
            var fdef = shownNow.filter(function (x) { return x.id === k.fn; })[0];
            var bot = withColor({ name: name, role: (fdef && fdef.role) || 'coder', shape: shapeOf(s.uid), status: k.status, task: k.task, platform: V.platform(s, snapshot.kinds), identity: s.cwd }, s.uid);
            // a Paperclip run (#76): the company and the Paperclip agent own it (its budget is on the stats display, terminal.js)
            if (s.hq) bot.owner = ownerOf(s);
            if (s.skills && s.skills.length) bot.skills = s.skills.slice(0, 16);
            if (s.scheduleId) bot.triggers = [s.name];
            emit(stamp({ type: 'bot.add', roomId: k.room, bot: bot }, s.startedAt));
            emit(stamp({ type: 'session.start', bot: name, session: s.uid, title: s.cwd }, s.startedAt));
            if (s.model) emit({ type: 'model', bot: name, model: s.model });
            if (s.scheduleId) emit(stamp({ type: 'trigger.run', job: s.name, bot: name }, s.startedAt));
            // A page opened mid-session: fill the trace with the plan and the last calls, without bubbles.
            // Older calls and finished subagents are history, not news. Open requests, replies and the error follow below.
            var calls = s.calls || [], from = Math.max(0, calls.length - HISTORY_CALLS);
            calls.forEach(function (c, i) { if (i < from && c.ok !== null) k.calls[c.id] = { bot: name, closed: true }; });
            (s.agents || []).forEach(function (a) { if (a.done) k.helpersDone[a.call] = true; });
            syncHelpers(s, k, emit);
            syncCalls(s, k, emit, true, prev && { prev: prev, out: out });
            syncPlan(s, k, emit);
          } else {
            if (k.ended) return;
            if (s.model && s.model !== k.model) { k.model = s.model; emit({ type: 'model', bot: k.name, model: s.model }); }
            syncHelpers(s, k, emit);
            syncCalls(s, k, emit);
            syncPlan(s, k, emit);
          }
          var bot0 = k.name;

          // permission prompts: each pending question becomes one request with Approve and Decline
          (s.pending || []).forEach(function (r) {
            if (k.asked[r.id]) return;
            k.asked[r.id] = true;
            pick(prev && prev.asked[r.id])(stamp({ type: 'request', bot: bot0, id: r.id, text: 'Allow ' + r.tool + (r.detail ? ': ' + clip(r.detail, 80) : '') + '?' + (r.reason ? ' Reason: ' + clip(r.reason, 160) : ''), risk: r.risk, tool: r.tool, preview: r.preview || r.detail }, r.t));
          });
          // free-form questions from the session (office_ask): answer with Yes or No, or reply in the chat
          (s.questions || []).forEach(function (q) {
            if (k.asked[q.id]) return;
            k.asked[q.id] = true;
            // no risk value: the DS bulk 'Approve all low-risk' must never answer a question the user did not read
            pick(prev && prev.asked[q.id])(stamp({ type: 'request', bot: bot0, id: q.id, text: q.text, tool: 'office_ask' }, q.t));
          });
          // what the session said (headless sessions only; a terminal session answers in its terminal).
          // Restored replies fill the chat without speech bubbles, like restored tool calls. The replies of a bot this
          // scene sees for the first time in a live pass are restored too (seeded, without at, like its error below): it
          // may have said them live here before (a round trip through another building, a reopened session that
          // carries its old replies), and a seeded event with at after the last visit would be recorded a second time (#58).
          // The snapshot is lean: a session with long replies carries only its newest ones and says how many it left out
          // (olderReplies, #80). The chat appends in event order, so a bot's replies wait until the older ones are here
          // (the store asks the server once), then all go in together, oldest first. k.firstKind and k.prevSeen keep how
          // the bot's first replies are told, because the pass that tells them may come later. A reply that arrives while
          // the older ones load (above holdTop) is news and speaks. If the older ones cannot load, the newest ones go in
          // and the store has told the page.
          var list = s.replies || [], hold = false;
          if (!k.olderDone) {
            if (!s.olderReplies) k.olderDone = true;
            else {
              var old = loadOlder(s.uid, list.length ? list[0].id : Infinity);
              if (old.wait) { hold = true; if (k.holdTop === undefined) { k.holdTop = list.length ? list[list.length - 1].id : 0; k.errTop = s.error ? s.error.id : 0; } }
              else { if (old.list) list = old.list.concat(list); k.olderDone = true; }
            }
          }
          k.held = hold;
          // The rest of the pass waits too: the error, the end and the status of a bot come after its replies in the chat. Every
          // path of the store's request ends with a pass over this snapshot, so nothing is lost (#80).
          if (hold) return;
          // How the error is told was fixed when the bot was seated (errKind, errPrev); from this pass on, a failure is news.
          // A failure that came during the hold (an id above errTop) is news, as a reply above holdTop is.
          var errKind = k.errKind, errPrev = k.errPrev, errTop = k.errTop;
          k.errKind = 'live'; k.errPrev = null; k.errTop = undefined;
          list.forEach(function (r) {
            if (r.id <= k.replySeen) return;
            k.replySeen = r.id;
            var kind = k.holdTop !== undefined && r.id > k.holdTop ? 'live' : k.prevSeen !== null ? (r.id <= k.prevSeen ? 'restore' : 'live') : k.firstKind;
            var e = kind === 'seed' ? seeded : kind === 'restore' ? restore : out, msg = stamp({ type: 'message', bot: bot0, text: r.text }, r.t);
            if (e !== out) msg.say = false;
            e(msg);
          });
          k.firstKind = 'live'; k.prevSeen = null; k.holdTop = undefined;
          // a queued message was read by the session
          var queued = (s.inbox || []).length;
          if (queued < k.inbox) emit({ type: 'message', bot: bot0, text: 'I read your message.', format: 'plain' });
          k.inbox = queued;

          var st = V.status(s).key, task = V.taskLine(s);
          if (s.status === 'ended') {
            k.ended = true;
            emit(stamp({ type: 'session.end', bot: bot0, session: s.uid, ok: !s.error }, s.endedAt));
            emit({ type: 'status', bot: bot0, status: 'resting', task: task });
            later(function () { if (emitRef !== out) return; out({ type: 'bot.remove', bot: bot0 }); delete taken[bot0]; }, REMOVE_AFTER_MS);
            return;
          }
          // a failed turn: the bot shows the error until a new turn starts, or Retry or Dismiss.
          // A bot first seen in a live pass (it moved in from another building) had its error before this scene saw it:
          // the error is restored, not news. A bot seated again restores the error its old seat showed. A bot of the first
          // pass has its error seeded, with its time. All of this holds when the pass that tells it comes after a hold.
          if (s.error && s.error.id > k.errorSeen) {
            k.errorSeen = s.error.id; k.status = 'error'; k.task = s.error.text;
            var ee = errTop !== undefined && s.error.id > errTop ? out : errPrev !== null ? (s.error.id <= errPrev ? restore : out) : errKind === 'seed' ? seeded : errKind === 'restore' ? restore : emit;
            ee(stamp({ type: 'error', bot: bot0, text: s.error.text }, s.error.at));
            return;
          }
          if (st !== k.status) { k.status = st; k.task = task; emit({ type: 'status', bot: bot0, status: st, task: task }); }
          else if (task !== k.task) { k.task = task; emit({ type: 'status', bot: bot0, status: st, task: task, quiet: true }); }
        });
        // sessions the server forgot
        Object.keys(known).forEach(function (uid) {
          if (seen[uid]) return;
          var k = known[uid];
          if (!k.ended) { dismissHelpers(k, base, 'Stopped before it finished'); base({ type: 'bot.remove', bot: k.name }); delete taken[k.name]; }
          delete known[uid];
        });
      }
      // The engine adds a little usage while bots work (demo drift), so send the real figure again every 15 s.
      function syncUsage(snap, emit) {
        var w = snap.plan && snap.plan.week;
        if (!w) return;
        var t = now();
        if (w.percent === lastUsage.percent && t - lastUsage.t < USAGE_REPEAT_MS) return;
        lastUsage = { percent: w.percent, t: t };
        emit({ type: 'usage', percent: w.percent });
      }

      // The first pass restores the scene: the snapshot the store had at attach, every event seeded (DS Reference,
      // Scene mount). It runs once, from the deferred call or from the first snapshot that arrives before it, whichever
      // comes first; a snapshot after attach is applied live on top of it, so only what changed since then is news.
      function prime(emit) {
        if (primed) return;
        primed = true;
        var s0 = seedSnap; seedSnap = null;
        if (s0) { apply(s0, emit, true); syncUsage(s0, function (e) { e.seeded = true; emit(e); }); }
      }
      m._follow = function (snap) { seeWorktrees(snap); if (emitRef) { prime(emitRef); apply(snap, emitRef); syncUsage(snap, emitRef); } };
      m.attach = function (emit) {
        known = {}; taken = {}; layout = freshLayout(); lastUsage = { percent: null, t: 0 }; oldFailed = {};
        emitRef = emit; primed = false; seedSnap = latest;
        if (attached.indexOf(m) < 0) attached.push(m);
        defer(function () { if (emitRef === emit) prime(emit); });
      };
      m.detach = function () {
        emitRef = null;
        attached = attached.filter(function (x) { return x !== m; });
      };

      // The id of this building's Security room, or null (the server gave none: a building with no place yet).
      m.securityRoom = function () { return d.security; };
      // The workspaces on screen, as roots (a workspace with rooms on two floors once).
      m.roomsShown = function () {
        var out = {};
        Object.keys(layout.floors).forEach(function (fn) { Object.keys(layout.floors[fn].rooms).forEach(function (root) { out[root] = true; }); });
        return Object.keys(out);
      };
      // The floor key ('lobby', 'engineering', ...) a DS floor id stands for in this scene, or null.
      m.floorKey = function (id) {
        for (var fn in layout.floors) { if (layout.floors[fn].id === id) return fn; }
        return null;
      };
      // The DS id of a floor key in this scene, or null.
      m.floorId = function (fn) { var f = layout.floors[fn]; return f ? f.id : null; };
      // The floor key of a DS room id in this scene (a room of open desks too), or null.
      m.roomFloor = function (roomId) {
        if (roomId === RECEPTION) return LOBBY;
        if (String(roomId).indexOf(SPARE) === 0 && layout.floors[String(roomId).slice(SPARE.length)]) return String(roomId).slice(SPARE.length);
        for (var fn in layout.floors) { var rs = layout.floors[fn].rooms; for (var r in rs) if (rs[r] === roomId) return fn; }
        return null;
      };
      // The floors this scene shows, bottom up: { id, key, name, wing, wingName, role }.
      m.floors = function () { return shown0.map(function (f) { return { id: layout.floors[f.id].id, key: f.id, name: names[f.id] || f.name, wing: f.wing, wingName: f.wingName, role: f.role }; }); };
      // True when the scene shows a worktree room that is gone, or the building's floors are not the ones it was built with
      // (an archetype switch, a floor added, hidden or moved: the DS has no event that removes or moves a floor).
      m.stale = function (snap) {
        var sn = snap || latest, nowRooms = roomsNow(sn, repo);
        seeWorktrees(sn);
        if (m.roomsShown().some(function (k) { return !nowRooms[k] && wtSeen[k]; })) return true;
        return shownFloors(sn, repo).map(function (f) { return f.id; }).join('|') !== d.sig;
      };
      // The empty building has no workspace room: only rooms of open desks and the Reception, which hold no board, notes or room tools.
      m.spare = function () { return !Object.keys(layout.keys).length; };
      m.usable = function (roomId, snap) { return !!m.noteKey(roomId, snap); };
      // The open sessions in one room of this building, and that room's place. A room on a second floor shows only the
      // sessions seated on that floor.
      m.roomInfo = function (roomId, snap) {
        var s = snap || latest, out = { sessions: [], place: null }, root = layout.roots[roomId], fn = m.roomFloor(roomId), sh = shownFloors(s, repo);
        if (!root) return out;
        live(s).forEach(function (x) { var pl = placeOf(x); if (pl.repo === repo && pl.root === root) { out.place = pl; if (seatOf(x, sh) === fn) out.sessions.push(x); } });
        if (!out.place) out.place = placeFor(s, root) || layout.places[roomId] || null;   // a room a session made, empty now: the layout remembers its place
        return out;
      };
      // The names of the bots seated on each floor of this scene: { floorId: [names] } (the directory board).
      m.agentsByFloor = function () {
        var out = {};
        Object.keys(known).forEach(function (uid) { var k = known[uid], f = layout.floors[k.fn] || layout.floors[LOBBY]; if (!k.ended) (out[f.id] = out[f.id] || []).push(k.name); });
        return out;
      };
      // The room of open desks of a floor while it has no agent room, else its first room (an open desk is in every room), or null.
      m.spareRoomOf = function (fn) {
        var f = layout.floors[fn];
        if (!f) return null;
        if (f.spare) return SPARE + fn;
        if (fn === LOBBY) return RECEPTION;
        var ids = Object.keys(f.rooms).map(function (r) { return f.rooms[r]; });
        return ids[0] || null;
      };
      // The desk objects of this building (#90), from a snapshot: a paper for each permission request and a note for each question
      // of a seated agent, and the open desks of each floor. A paper: { uid, bot, id, tool, text, reason, risk, high, always, t, until }.
      // A high-risk paper has no always (never offered). until: when the office stops holding it (vocab holdMs). A note: { uid, bot,
      // id, text, t, until }. An open desk entry: { floorId, floorKey, name, wing, roomId, role }, the room whose open desk starts an agent.
      m.deskTargets = function (snap) {
        var s = snap || latest, out = { papers: [], notes: [], empty: [] };
        live(s).forEach(function (x) {
          var k = known[x.uid];
          if (!k || k.ended) return;
          V.requests(x).forEach(function (r) {
            var until = r.t ? r.t + V.holdMs(x) : 0, base = { uid: x.uid, bot: k.name, id: r.id, text: r.text, t: r.t, until: until };
            if (r.kind === 'question') out.notes.push(base);
            else out.papers.push(Object.assign(base, { tool: r.tool, reason: r.reason, risk: r.risk || 'low', high: r.risk === 'high', always: r.risk === 'high' ? null : r.always }));
          });
        });
        m.floors().forEach(function (f) { var rid = m.spareRoomOf(f.key); if (rid) out.empty.push({ floorId: f.id, floorKey: f.key, name: f.name, wing: f.wingName, roomId: rid, role: f.role }); });
        return out;
      };
      // The worst state of the desks of this building, its floors and its rooms (vocab.js worst): the room doors, the elevator
      // buttons and the city windows. { building, floors: { floorId: state }, rooms: { roomId: state } }; null where no desk is.
      m.rollup = function () {
        var rooms = {}, floors = {}, all = [];
        Object.keys(known).forEach(function (uid) {
          var k = known[uid];
          if (k.ended) return;
          (rooms[k.room] = rooms[k.room] || []).push(k.status);
          var f = layout.floors[k.fn] || layout.floors[LOBBY];
          (floors[f.id] = floors[f.id] || []).push(k.status);
          all.push(k.status);
        });
        var out = { building: worst(all), floors: {}, rooms: {} };
        Object.keys(rooms).forEach(function (r) { out.rooms[r] = worst(rooms[r]); });
        Object.keys(floors).forEach(function (f) { out.floors[f] = worst(floors[f]); });
        return out;
      };
      // The key of a room's notes board and pin, from the server (the layout remembers it for a room the snapshot dropped).
      m.noteKey = function (roomId, snap) { var p = m.roomInfo(roomId, snap).place; return p ? p.noteKey : (layout.keys[roomId] || ''); };
      // The DS room id of a place room id on screen (its home room), or null.
      m.dsRoom = function (placeRoomId) { for (var id in layout.roots) if (baseRoomId(id) === placeRoomId) return id; return null; };
      // The server's figures for one room (computed once per snapshot, keyed by the notes key). Zeros for a room with no session.
      m.figures = function (roomId, snap) {
        var s = snap || latest, nk = m.noteKey(roomId, s);
        return (s && s.figures && s.figures[nk]) || V.figures([]);
      };
      m.agentName = function (snap) {
        var sn = snap || latest, kinds = (sn && sn.kinds) || [];
        var mine = live(sn).filter(function (x) { return placeOf(x).repo === repo; });
        return V.kindsWord(mine, kinds) || (kinds[0] && kinds[0].label) || '';
      };
      // the name the scene gives a bot (a folder name used twice gets a number), or null when it is not seated
      m.botName = function (uid) { var k = known[uid]; return k && !k.ended ? k.name : null; };
      m.session = function (botName) {
        for (var uid in known) { if (known[uid].name === botName && !known[uid].ended) return store.sessionByUid(uid); }
        return null;
      };
      // The uid, commands and skills of the open session a bot name stands for, or null.
      m.lookup = function (botName) {
        var s = m.session(botName);
        return s ? { uid: s.uid, commands: s.commands || [], skills: s.skills || [] } : null;
      };
      // The uids of the open sessions a command is for (cmd.bots or cmd.bot hold bot names).
      m.uidsOf = function (cmd) {
        var names = cmd.bots && cmd.bots.length ? cmd.bots : (cmd.bot ? [cmd.bot] : []);
        return Object.keys(known).filter(function (u) { return names.indexOf(known[u].name) >= 0 && !known[u].ended; });
      };
      return m;
    };
    return store;
  }

  // The floor a new scene of a building starts on (#85, #111), as { id, key } (key: the floor key, 'lobby', 'engineering', ...).
  // The page always gets a floor, so it never relies on the DS default. Null only for no mount. In this order:
  //   was     the floor on screen before a rebuild of the same building (#85); null for another building or the city
  //   busy    the floor with the most live sessions (by seat); a tie goes to the lower floor
  //   picked  the floor the user chose last in this building
  //   first   the ground floor (the Lobby)
  // Floor ids are new for each mount, so every match is by floor key.
  function startFloor(toMount, snap, was, picked) {
    if (!toMount) return null;
    function by(key) { var id = key == null ? null : toMount.floorId(key); return id == null ? null : { id: id, key: key }; }
    var hit = by(was);
    if (hit) return hit;
    var count = {}, best = null, shown = shownFloors(snap, toMount.repo);
    live(snap).forEach(function (s) { var pl = placeOf(s); if (pl.repo === toMount.repo) { var fn = seatOf(s, shown); count[fn] = (count[fn] || 0) + 1; } });
    Object.keys(count).forEach(function (fn) {
      var bid = toMount.floorId(fn);
      if (bid == null) return;
      if (!best || count[fn] > best.n || (count[fn] === best.n && bid < best.id)) best = { id: bid, key: fn, n: count[fn] };
    });
    if (best) return { id: best.id, key: best.key };
    hit = by(picked);
    if (hit) return hit;
    var f0 = toMount.def && toMount.def.floors && toMount.def.floors[0];
    return f0 ? { id: f0.id, key: toMount.floorKey(f0.id) } : null;
  }

  // What the page remembers of floors, per building, for the life of the page (#111). One rule owns the whole choice:
  //   start(mount, snap, was)  the floor a new scene opens on (startFloor); the page opens exactly that floor
  //   see(repo, key)           the floor on screen now (a poll while the scene shows, and when it is left). A floor
  //                            other than the last one seen is a move of the user: the page itself moves nobody. The
  //                            floor the page opened is not a pick. null (the building view) changes nothing.
  //   picked(repo)             the floor key the user moved to last, or null
  function floorMemory() {
    var picked = {}, last = {};
    return {
      start: function (mount, snap, was) {
        var f = startFloor(mount, snap, was, mount ? picked[mount.repo] : null);
        if (mount) last[mount.repo] = f ? f.key : null;
        return f;
      },
      see: function (repo, key) {
        if (key == null) return;
        if (last[repo] != null && key !== last[repo]) picked[repo] = key;
        last[repo] = key;
      },
      picked: function (repo) { return picked[repo] == null ? null : picked[repo]; }
    };
  }

  root.OfficeBuilding = { createStore: createStore, startFloor: startFloor, floorMemory: floorMemory, shapeOf: shapeOf, colorOf: colorOf, buildings: buildings, requests: requests, queue: queue, changes: changes, folderAt: folderAt, describe: describe, roomsNow: roomsNow, tagOf: tagOf, baseRoomId: baseRoomId, EMPTY_NOTE: EMPTY_NOTE };
})(typeof globalThis !== 'undefined' ? globalThis : window);
