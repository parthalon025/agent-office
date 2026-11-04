/* Agent Office for Claude Code x0.1: snapshot store and building adapters.
   Two parts, no DOM, no EventSource, no network, no timers of its own (they are injected). The page loads it as a
   script (window.OfficeBuilding). The tests import it for its side effect and read globalThis.OfficeBuilding.

   Snapshot store (createStore): owns the latest snapshot, the people who listen to it, and the building
   adapters that are on screen.
     set(snap)             the SSE feed calls this for each snapshot
     latest()              the newest snapshot, or null
     onSnapshot(fn)        fn(snap) now (when there is one) and on each snapshot; returns an unsubscribe function
     buildings(snap?)      the buildings, busiest first
     preview(repo, snap?)  a building definition with its bots (cards and the city); it mounts nothing
     session(botName)      the open session of a bot in the building that is on screen
     lookup(botName)       the commands and skills of that session
     botName(uid)          the scene name of a seated bot
     mount(repo)           a new building adapter for one building (below)

   Building adapter (store.mount(repo)): made once per mounted scene. It owns the mirror of what the scene was
   told, the layout of its floors and rooms, and the names of its bots. Nothing is shared between two of them, so a
   new building starts clean and there is no reset call.
     repo, id              the building key and a number that is new for each mount
     def                   the building definition for the scene (fixed at mount time)
     attach(emit)          the scene starts: replay the latest snapshot as DS events, then follow the store
     detach()              the scene stops: later snapshots and timers do nothing
     stale(snap?)          true when the scene shows a room that is gone, or was empty and now has rooms.
                           The DS has no event that removes a floor or a room, so the page mounts a new adapter.
     roomInfo(roomId)      { sessions, place } of one room of this building
     figures(roomId)       the server's figures for that room
     noteKey(roomId)       the server's notes key for that room
     session(botName), lookup(botName), uidsOf(cmd), roomsShown()
   The scene's events are the DS events (kit/schema.json). */
(function (root) {
  'use strict';
  var V = root.OfficeVocab;
  var SHAPES = ['cone', 'blob', 'octa', 'capsule'];
  var FLOOR_KEYS = ['ops', 'sales', 'research', 'content', 'hq'];
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
  function hostOf(url) { return String(url).replace(/^https?:\/\//, '').split('/')[0] || String(url); }

  // Where a session sits: building (repo), floor (branch), room (worktree folder). The server computes it
  // (place.mjs) and sends it as session.place and worktree.place; this only renames the fields.
  function fromPlace(p) {
    return { repo: p.buildingKey, repoName: p.building, branch: p.floor, root: p.rootKey, roomName: p.room, roomId: p.roomId, noteKey: p.noteKey, path: p.root };
  }
  function placeOf(s) { return fromPlace(s.place); }
  function placeKey(pl) { return pl.repo + '|' + pl.branch + '|' + pl.root; }
  function repoOf(snap, key) { return ((snap && snap.repos) || []).filter(function (r) { return r.key === key; })[0] || null; }
  function live(snap) { return (snap ? snap.sessions : []).filter(function (s) { return s.status !== 'ended' && s.place; }); }
  function floorDef(id, branch, rooms) { return { id: id, key: FLOOR_KEYS[(id - 1) % FLOOR_KEYS.length], name: clip(branch, 22), rooms: rooms }; }  // long branch names overlap the floor tag
  function roomDef(pl) { return { id: pl.roomId, type: 'lab', name: pl.roomName, bots: [] }; }

  // Rooms that exist now for one building, as "branch|root": worktrees and the folders of open sessions.
  function roomsNow(snap, repo) {
    var rp = repoOf(snap, repo), out = {};
    if (rp) rp.worktrees.forEach(function (w) { out[w.place.floor + '|' + w.place.rootKey] = true; });
    live(snap).forEach(function (s) { var pl = placeOf(s); if (pl.repo === repo) out[pl.branch + '|' + pl.root] = true; });
    return out;
  }

  // The buildings: one per repository known or in use, busiest first.
  function buildings(snap) {
    var by = {};
    ((snap && snap.repos) || []).forEach(function (r) {
      var b = by[r.key] = { key: r.key, name: r.name, path: r.path, sessions: 0, waiting: 0, last: 0, branches: {} };
      r.worktrees.forEach(function (w) { b.branches[w.branch] = true; });
    });
    live(snap).forEach(function (s) {
      var pl = placeOf(s), b = by[pl.repo] || (by[pl.repo] = { key: pl.repo, name: pl.repoName, sessions: 0, waiting: 0, last: 0, branches: {} });
      b.sessions++; b.branches[pl.branch] = true; b.last = Math.max(b.last, s.lastEvent || 0);
      b.waiting += (s.pending || []).length + (s.questions || []).length;
    });
    return Object.keys(by).map(function (k) { var b = by[k]; b.branches = Object.keys(b.branches).length; return b; })
      .sort(function (a, b) { return b.waiting - a.waiting || b.sessions - a.sessions || b.last - a.last || a.name.localeCompare(b.name); });
  }

  // A building definition: a floor per branch, a room per worktree, the default branch at the bottom.
  // With bots, each room also lists its sessions (for previews); the scene gets its bots from events instead.
  // Returns { def, floors: { branch: { id, rooms: { root: roomId } } }, nextId, keys: { roomId: noteKey }, empty }.
  function describe(repo, snap, withBots) {
    var byBranch = {}, order = [], name = repo ? '' : OTHER, bots = {};
    var rp = repoOf(snap, repo), places = rp ? rp.worktrees.map(function (w) { return fromPlace(w.place); }) : [];
    live(snap).forEach(function (s) {
      var pl = placeOf(s);
      places.push(pl);
      if (withBots && pl.repo === repo) (bots[pl.root] = bots[pl.root] || []).push(withColor({ name: s.name, role: 'coder', shape: shapeOf(s.uid), status: V.status(s).key, word: V.status(s).word, task: V.taskLine(s) }, s.uid));
    });
    places.forEach(function (pl) {
      if (pl.repo !== repo) return;
      name = pl.repoName;
      if (!byBranch[pl.branch]) { byBranch[pl.branch] = {}; order.push(pl.branch); }
      byBranch[pl.branch][pl.root] = pl;
    });
    order.sort(function (a, b) { return (/^(main|master|trunk)$/.test(b) ? 1 : 0) - (/^(main|master|trunk)$/.test(a) ? 1 : 0); });
    var map = {}, nextId = 1, keys = {};
    var floors = order.map(function (br) {
      var f = map[br] = { id: nextId++, rooms: {} };
      var rooms = Object.keys(byBranch[br]).map(function (rootKey) {
        var r = roomDef(byBranch[br][rootKey]); f.rooms[rootKey] = r.id; keys[r.id] = byBranch[br][rootKey].noteKey;
        if (withBots) r.bots = bots[rootKey] || [];
        return r;
      });
      return floorDef(f.id, br, rooms);
    });
    // An empty building still needs a floor to stand on.
    var empty = !floors.length;
    if (empty) { floors = [floorDef(1, 'No sessions', [])]; nextId = 2; }
    return { def: { name: name || (repo ? base(repo) : OTHER), sessions: 'agent', floors: floors }, floors: map, nextId: nextId, keys: keys, empty: empty };
  }

  function createStore(opts) {
    opts = opts || {};
    var now = opts.now || Date.now;
    var defer = opts.defer || function (fn) { setTimeout(fn, 0); };
    var later = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var latest = null, listeners = [], attached = [], mountSeq = 0;
    var store = {};

    store.latest = function () { return latest; };
    store.set = function (snap) {
      latest = snap;
      attached.slice().forEach(function (m) { m._follow(snap); });
      listeners.slice().forEach(function (fn) { try { fn(snap); } catch (x) { /* a bad listener must not stop the office */ } });
    };
    store.onSnapshot = function (fn) {
      listeners.push(fn);
      if (latest) { try { fn(latest); } catch (x) { /* a bad listener must not stop the office */ } }
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    };
    store.buildings = function (snap) { return buildings(snap || latest); };
    store.preview = function (repo, snap) { return describe(repo, snap || latest, true).def; };
    store.shapeOf = shapeOf;
    store.colorOf = colorOf;
    store.buildingOf = function (s) { return s.place ? s.place.buildingKey : ''; };
    store.sessionByUid = function (uid) { return latest && latest.sessions.filter(function (x) { return x.uid === uid; })[0] || null; };
    // The building that is on screen: the one attached last.
    function current() { return attached.length ? attached[attached.length - 1] : null; }
    store.session = function (botName) { var m = current(); return m ? m.session(botName) : null; };
    store.lookup = function (botName) { var m = current(); return m ? m.lookup(botName) : null; };
    store.botName = function (uid) { var m = current(); return m ? m.botName(uid) : null; };

    store.mount = function (repo) {
      var d = describe(repo, latest, false);
      function freshLayout() { return { floors: JSON.parse(JSON.stringify(d.floors)), nextId: d.nextId, keys: Object.assign({}, d.keys) }; }
      var layout = freshLayout();
      var startedEmpty = d.empty;
      var known = {};   // uid -> mirror of what the scene was told
      var taken = {};   // bot name -> true
      var emitRef = null, lastUsage = { percent: null, t: 0 };
      var m = { repo: repo, id: ++mountSeq, def: d.def };

      function uniqueName(b) {
        var n = b || 'session', i = 2;
        while (taken[n]) n = b + ' ' + i++;
        taken[n] = true;
        return n;
      }
      // The room of a session in this building. Adds its floor or room when it is new.
      function roomOf(pl, emit) {
        var f = layout.floors[pl.branch];
        if (!f) {
          var r = roomDef(pl);
          layout.keys[r.id] = pl.noteKey;
          f = layout.floors[pl.branch] = { id: layout.nextId++, rooms: {} };
          f.rooms[pl.root] = r.id;
          emit({ type: 'floor.add', floor: floorDef(f.id, pl.branch, [r]) });
          return r.id;
        }
        if (!f.rooms[pl.root]) {
          var r2 = roomDef(pl);
          layout.keys[r2.id] = pl.noteKey;
          f.rooms[pl.root] = r2.id;
          emit({ type: 'room.add', floorId: f.id, room: r2 });
        }
        return f.rooms[pl.root];
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
            emit({ type: 'subagent.done', bot: hn, remove: true, result: a.ok ? 'Returned its result' : 'Stopped before it finished' });
            delete taken[hn];
          }
        });
      }
      function syncCalls(s, k, emit, quiet) {
        var byAgent = {};
        (s.agents || []).forEach(function (a) { if (a.id && k.helpers[a.call] && !k.helpersDone[a.call]) byAgent[a.id] = k.helpers[a.call]; });
        (s.calls || []).forEach(function (c) {
          var seen = k.calls[c.id];
          if (!seen) {
            var who = (c.agent && byAgent[c.agent]) || k.name;
            seen = k.calls[c.id] = { bot: who, closed: false };
            emit({ type: 'tool.call', bot: who, id: c.id, tool: V.toolShort(c.name), kind: V.toolKind(c.name), args: argsOf(c), say: !quiet });
            if (c.name === 'Skill' && c.detail) emit({ type: 'skill.load', bot: who, skill: c.detail });
            if (c.name === 'WebFetch' && c.detail) emit({ type: 'knowledge', bot: who, source: hostOf(c.detail), text: c.detail });
            if (c.name === 'WebSearch' && c.detail) emit({ type: 'knowledge', bot: who, source: 'Web search', text: c.detail });
          }
          if (!seen.closed && c.ok !== null) {
            seen.closed = true;
            var r = { type: 'tool.result', bot: seen.bot, id: c.id, ok: c.ok };
            if (typeof c.ms === 'number') r.ms = c.ms;
            if (c.err) r.summary = c.err;
            emit(r);
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

      function apply(snapshot, emit) {
        var seen = {};
        // empty rooms: worktrees of this building that no session uses
        var rp = repoOf(snapshot, repo);
        if (rp) rp.worktrees.forEach(function (w) { roomOf(fromPlace(w.place), emit); });
        snapshot.sessions.forEach(function (s) {
          if (!s.place) return;   // wait until the server knows the repo and branch
          var pl = placeOf(s), k = known[s.uid];
          // the session checked out another branch, or moved to another folder: seat it again
          if (k && !k.ended && k.place !== placeKey(pl)) {
            emit({ type: 'bot.remove', bot: k.name }); delete taken[k.name]; delete known[s.uid]; k = null;
          }
          if (pl.repo !== repo) return;   // another building
          seen[s.uid] = true;
          if (!k) {
            if (s.status === 'ended') return;
            var name = uniqueName(s.name);
            k = known[s.uid] = { asked: {}, inbox: 0, replySeen: 0, name: name, status: V.status(s).key, task: V.taskLine(s), calls: {}, helpers: {}, helpersDone: {}, planSig: '', planState: [], errorSeen: 0, model: s.model, ended: false, place: placeKey(pl), room: roomOf(pl, emit) };
            var bot = withColor({ name: name, role: 'coder', shape: shapeOf(s.uid), status: k.status, task: k.task, platform: 'Claude Code', identity: s.cwd }, s.uid);
            if (s.skills && s.skills.length) bot.skills = s.skills.slice(0, 16);
            if (s.scheduleId) bot.triggers = [s.name];
            emit({ type: 'bot.add', roomId: k.room, bot: bot });
            emit({ type: 'session.start', bot: name, session: s.uid, title: s.cwd });
            if (s.model) emit({ type: 'model', bot: name, model: s.model });
            if (s.scheduleId) emit({ type: 'trigger.run', job: s.name, bot: name });
            // A page opened mid-session: fill the trace with the plan and the last calls, without bubbles.
            // Older calls and finished subagents are history, not news.
            var calls = s.calls || [], from = Math.max(0, calls.length - HISTORY_CALLS);
            calls.forEach(function (c, i) { if (i < from && c.ok !== null) k.calls[c.id] = { bot: name, closed: true }; });
            (s.agents || []).forEach(function (a) { if (a.done) k.helpersDone[a.call] = true; });
            if (s.error) k.errorSeen = s.error.id;
            syncHelpers(s, k, emit);
            syncCalls(s, k, emit, true);
            syncPlan(s, k, emit);
            return;
          }
          if (k.ended) return;
          var bot0 = k.name;
          if (s.model && s.model !== k.model) { k.model = s.model; emit({ type: 'model', bot: bot0, model: s.model }); }

          syncHelpers(s, k, emit);
          syncCalls(s, k, emit);
          syncPlan(s, k, emit);

          // permission prompts: each pending question becomes one request with Approve and Decline
          (s.pending || []).forEach(function (r) {
            if (k.asked[r.id]) return;
            k.asked[r.id] = true;
            emit({ type: 'request', bot: bot0, id: r.id, text: 'Allow ' + r.tool + (r.detail ? ': ' + clip(r.detail, 80) : '') + '?', risk: r.risk, tool: r.tool, preview: r.preview || r.detail });
          });
          // free-form questions from the session (office_ask): answer with Yes or No, or reply in the chat
          (s.questions || []).forEach(function (q) {
            if (k.asked[q.id]) return;
            k.asked[q.id] = true;
            // no risk value: the DS bulk 'Approve all low-risk' must never answer a question the user did not read
            emit({ type: 'request', bot: bot0, id: q.id, text: q.text, tool: 'office_ask' });
          });
          // what the session said (headless sessions only; a terminal session answers in its terminal)
          (s.replies || []).forEach(function (r) {
            if (r.id <= k.replySeen) return;
            k.replySeen = r.id;
            emit({ type: 'message', bot: bot0, text: r.text });
          });
          // a queued message was read by the session
          var queued = (s.inbox || []).length;
          if (queued < k.inbox) emit({ type: 'message', bot: bot0, text: 'I read your message.', format: 'plain' });
          k.inbox = queued;

          var st = V.status(s).key, task = V.taskLine(s);
          if (s.status === 'ended') {
            k.ended = true;
            emit({ type: 'session.end', bot: bot0, session: s.uid, ok: !s.error });
            emit({ type: 'status', bot: bot0, status: 'resting', task: task });
            later(function () { if (emitRef !== emit) return; emit({ type: 'bot.remove', bot: bot0 }); delete taken[bot0]; }, REMOVE_AFTER_MS);
            return;
          }
          // a failed turn: the bot shows the error until a new turn starts, or Retry or Dismiss
          if (s.error && s.error.id > k.errorSeen) {
            k.errorSeen = s.error.id; k.status = 'error'; k.task = s.error.text;
            emit({ type: 'error', bot: bot0, text: s.error.text });
            return;
          }
          if (st !== k.status) { k.status = st; k.task = task; emit({ type: 'status', bot: bot0, status: st, task: task }); }
          else if (task !== k.task) { k.task = task; emit({ type: 'status', bot: bot0, status: st, task: task, quiet: true }); }
        });
        // sessions the server forgot
        Object.keys(known).forEach(function (uid) {
          if (seen[uid]) return;
          var k = known[uid];
          if (!k.ended) { emit({ type: 'bot.remove', bot: k.name }); delete taken[k.name]; }
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

      m._follow = function (snap) { if (emitRef) { apply(snap, emitRef); syncUsage(snap, emitRef); } };
      m.attach = function (emit) {
        known = {}; taken = {}; layout = freshLayout(); lastUsage = { percent: null, t: 0 };
        emitRef = emit;
        if (attached.indexOf(m) < 0) attached.push(m);
        defer(function () { if (emitRef === emit && latest) { apply(latest, emit); syncUsage(latest, emit); } });
      };
      m.detach = function () {
        emitRef = null;
        attached = attached.filter(function (x) { return x !== m; });
      };

      m.roomsShown = function () {
        var out = [];
        Object.keys(layout.floors).forEach(function (br) { Object.keys(layout.floors[br].rooms).forEach(function (root) { out.push(br + '|' + root); }); });
        return out;
      };
      m.stale = function (snap) {
        var nowRooms = roomsNow(snap || latest, repo);
        if (m.roomsShown().some(function (k) { return !nowRooms[k]; })) return true;
        return startedEmpty && Object.keys(nowRooms).length > 0;
      };
      // The open sessions in one room of this building, and that room's place.
      m.roomInfo = function (roomId, snap) {
        var s = snap || latest, out = { sessions: [], place: null };
        live(s).forEach(function (x) { var pl = placeOf(x); if (pl.repo === repo && pl.roomId === roomId) { out.sessions.push(x); out.place = pl; } });
        if (!out.place) {
          var rp = repoOf(s, repo);
          (rp ? rp.worktrees : []).forEach(function (w) { var pl = fromPlace(w.place); if (pl.roomId === roomId) out.place = pl; });
        }
        return out;
      };
      // The key of a room's notes board and pin, from the server (the layout remembers it for a room the snapshot dropped).
      m.noteKey = function (roomId, snap) { var p = m.roomInfo(roomId, snap).place; return p ? p.noteKey : (layout.keys[roomId] || ''); };
      // The server's figures for one room (computed once per snapshot, keyed by the notes key). Zeros for a room with no session.
      m.figures = function (roomId, snap) {
        var s = snap || latest, nk = m.noteKey(roomId, s);
        return (s && s.figures && s.figures[nk]) || V.figures([]);
      };
      // the name the scene gives a bot (a folder name used twice gets a number), or null when it is not seated
      m.botName = function (uid) { var k = known[uid]; return k && !k.ended ? k.name : null; };
      m.session = function (botName) {
        for (var uid in known) { if (known[uid].name === botName && !known[uid].ended) return store.sessionByUid(uid); }
        return null;
      };
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

  root.OfficeBuilding = { createStore: createStore, shapeOf: shapeOf, colorOf: colorOf, buildings: buildings, describe: describe, roomsNow: roomsNow };
})(typeof globalThis !== 'undefined' ? globalThis : window);
