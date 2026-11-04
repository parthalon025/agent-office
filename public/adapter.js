/* Agent Office adapter x0.1 for Claude Code (bridge pattern, hooks in, process control out).
   The server (server.mjs) turns Claude Code hook events into session snapshots and streams them
   over SSE. This file turns each snapshot into Agent Office events:
   - Git repository -> building, branch -> floor, worktree -> room. The page shows one building at a
     time (buildingFor); new branches and worktrees arrive as floor.add and room.add.
     A folder outside git goes to the "Other folders" building, one room per folder.
   - Claude Code session -> bot in the room of its worktree.
   - Tool use -> tool.call / tool.result (arguments, time, failure). Skill -> skill.load. Web reads -> knowledge.
   - Subagent (Task or Agent tool) -> delegate with a spawned helper; its own tool calls show on the helper;
     subagent.done when it returns.
   - TodoWrite -> plan and plan.step. A failed turn or a spending limit -> error (Retry, Dismiss).
   - A run started by a schedule -> trigger.run. Plan usage from the status line file -> usage.
   - Permission prompt (PermissionRequest hook) -> request with Approve and Decline. It waits for the
     office; if nobody answers in time, the question goes back to the terminal dialog. */
(function () {
  var TOKEN = document.querySelector('meta[name="office-token"]').content;
  var SHAPES = ['cone', 'blob', 'octa', 'capsule'];
  var KIND = { Bash: 'terminal', PowerShell: 'terminal', WebFetch: 'browser', WebSearch: 'search', Grep: 'search', Glob: 'search', Read: 'code', Edit: 'code', Write: 'code', MultiEdit: 'code', NotebookEdit: 'code', Task: 'flow', Agent: 'flow', Skill: 'skill', TodoWrite: 'memory' };
  var ARG = { Bash: 'command', PowerShell: 'command', Read: 'file', Edit: 'file', Write: 'file', MultiEdit: 'file', NotebookEdit: 'file', Grep: 'pattern', Glob: 'pattern', WebFetch: 'url', WebSearch: 'query', Task: 'task', Agent: 'task', Skill: 'skill' };
  var TODO = { pending: 'resting', in_progress: 'working', completed: 'finished' };
  var REMOVE_AFTER_MS = 6000;
  var HISTORY_CALLS = 12; // calls shown in the trace when the page opens mid-session

  function shapeOf(uid) { return SHAPES[hash(String(uid)) % SHAPES.length]; }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function kindOf(tool) { return KIND[tool] || (String(tool).indexOf('mcp__') === 0 ? 'mcp' : 'api'); }
  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function base(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; }
  function mapStatus(s) {
    if (s.status === 'working' || s.status === 'waiting') return s.status;
    if (s.status === 'idle') return s.turns > 0 ? 'finished' : 'resting';
    return 'resting';
  }
  // The HUD adds the state word ("Working · ..."), so the task text carries only the task.
  function taskOf(s) {
    if (s.status === 'waiting') return clip(s.note, 90) || 'Needs your attention';
    if (s.status === 'working' && s.live) return clip(s.live.replace(/\s+/g, ' ').slice(-90), 90);
    if (s.status === 'working') return s.tool ? s.tool.name + (s.tool.detail ? ' ' + clip(s.tool.detail, 60) : '') : (clip(s.prompt, 70) || 'Thinking');
    if (s.status === 'starting') return 'Waiting for the first hook';
    if (s.status === 'ended') return 'Left the office';
    return s.turns > 0 ? (clip(s.prompt, 60) || 'Last turn') : 'Waiting for a prompt';
  }
  // A subagent's type picks its role: the workstation and the icon.
  function helperRole(type) {
    if (/explore|research|search|guide/i.test(type)) return 'research';
    if (/plan|architect/i.test(type)) return 'planner';
    if (/review|verif|audit|security/i.test(type)) return 'analyst';
    if (/doc|writ/i.test(type)) return 'writer';
    return 'coder';
  }
  function argsOf(c) { if (!c.detail) return undefined; var a = {}; a[ARG[c.name] || 'input'] = c.detail; return a; }
  function hostOf(url) { return String(url).replace(/^https?:\/\//, '').split('/')[0] || String(url); }

  var FLOOR_KEYS = ['ops', 'sales', 'research', 'content', 'hq'];
  var OTHER = 'Other folders';
  // Per mounted scene. subscribe() resets them, so a remount (another building) starts clean.
  var known = {};   // uid -> mirror of what the office was told
  var taken = {};   // bot name -> true
  var layout = { repo: null, floors: {}, nextId: 1 };   // branch -> { id, rooms: { root: roomId } }
  var emitRef = null, gen = 0;
  function uniqueName(base) {
    var n = base || 'session', i = 2;
    while (taken[n]) n = base + ' ' + i++;
    taken[n] = true;
    return n;
  }
  function slug(t) { return String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'; }
  // Where a session sits: building (repo), floor (branch), room (worktree folder).
  function placeOf(s) {
    var g = s.git;
    if (!g) return { repo: '', repoName: OTHER, branch: 'No branch', root: String(s.cwd || '').toLowerCase(), roomName: base(s.cwd) || 'Folder' };
    return { repo: g.repo.toLowerCase(), repoName: base(g.repo), branch: g.branch, root: g.root.toLowerCase(), roomName: base(g.root) };
  }
  function placeKey(pl) { return pl.repo + '|' + pl.branch + '|' + pl.root; }
  // Rooms that exist in git (worktrees), with or without a session in them.
  function repoOf(snap, key) { return ((snap && snap.repos) || []).filter(function (r) { return r.key === key; })[0] || null; }
  function wtPlace(r, w) { return { repo: r.key, repoName: r.name, branch: w.branch, root: w.root.toLowerCase(), roomName: base(w.root) }; }
  function live(snap) { return (snap ? snap.sessions : []).filter(function (s) { return s.status !== 'ended' && s.placed; }); }
  function floorDef(id, branch, rooms) { return { id: id, key: FLOOR_KEYS[(id - 1) % FLOOR_KEYS.length], name: clip(branch, 22), rooms: rooms }; }  // long branch names overlap the floor tag
  function roomDef(pl) { return { id: 'w-' + slug(pl.root).slice(-48), type: 'lab', name: pl.roomName, bots: [] }; }
  // The room of a session in the shown building. Adds its floor or room when it is new.
  function roomOf(pl, emit) {
    var f = layout.floors[pl.branch];
    if (!f) {
      var r = roomDef(pl);
      f = layout.floors[pl.branch] = { id: layout.nextId++, rooms: {} };
      f.rooms[pl.root] = r.id;
      emit({ type: 'floor.add', floor: floorDef(f.id, pl.branch, [r]) });
      return r.id;
    }
    if (!f.rooms[pl.root]) {
      var r2 = roomDef(pl);
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
        emit({ type: 'tool.call', bot: who, id: c.id, tool: c.name, kind: kindOf(c.name), args: argsOf(c), say: !quiet });
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
      emit({ type: 'plan', bot: k.name, goal: clip(s.prompt, 120) || 'Plan', steps: todos.map(function (t, i) { return { id: 't' + i, text: t.text, status: TODO[t.status] || 'resting' }; }) });
      return;
    }
    todos.forEach(function (t, i) {
      if (k.planState[i] === t.status) return;
      k.planState[i] = t.status;
      emit({ type: 'plan.step', bot: k.name, id: 't' + i, status: TODO[t.status] || 'resting' });
    });
  }

  function apply(snapshot, emit) {
    var seen = {};
    // empty rooms: worktrees of the shown repository that no session uses
    var rp = repoOf(snapshot, layout.repo);
    if (rp) rp.worktrees.forEach(function (w) { roomOf(wtPlace(rp, w), emit); });
    snapshot.sessions.forEach(function (s) {
      if (!s.placed) return;   // wait until the server knows the repo and branch
      var pl = placeOf(s), k = known[s.uid];
      // the session checked out another branch, or moved to another folder: seat it again
      if (k && !k.ended && k.place !== placeKey(pl)) {
        emit({ type: 'bot.remove', bot: k.name }); delete taken[k.name]; delete known[s.uid]; k = null;
      }
      if (pl.repo !== layout.repo) return;   // another building
      seen[s.uid] = true;
      if (!k) {
        if (s.status === 'ended') return;
        var name = uniqueName(s.name);
        k = known[s.uid] = { asked: {}, inbox: 0, replySeen: 0, name: name, status: mapStatus(s), task: taskOf(s), calls: {}, helpers: {}, helpersDone: {}, planSig: '', planState: [], errorSeen: 0, model: s.model, ended: false, place: placeKey(pl), room: roomOf(pl, emit) };
        var bot = { name: name, role: 'coder', shape: shapeOf(s.uid), status: k.status, task: k.task, platform: 'Claude Code', identity: s.cwd };
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
        emit({ type: 'request', bot: bot0, id: q.id, text: q.text, risk: 'low', tool: 'office_ask' });
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

      var st = mapStatus(s), task = taskOf(s);
      if (s.status === 'ended') {
        k.ended = true;
        emit({ type: 'session.end', bot: bot0, session: s.uid, ok: !s.error });
        emit({ type: 'status', bot: bot0, status: 'resting', task: task });
        var g0 = gen;
        setTimeout(function () { if (g0 !== gen) return; emit({ type: 'bot.remove', bot: bot0 }); delete taken[bot0]; }, REMOVE_AFTER_MS);
        return;
      }
      // a failed turn: the bot shows the error until a new turn starts, or Retry or Dismiss
      if (s.error && s.error.id > k.errorSeen) {
        k.errorSeen = s.error.id; k.status = 'error'; k.task = s.error.text;
        emit({ type: 'error', bot: bot0, text: s.error.text });
        return;
      }
      if (k.status === 'error' && st !== 'working') return;
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

  var latest = null;
  var listeners = [];
  var lastUsage = { percent: null, t: 0 };
  // The engine adds a little usage while bots work (demo drift), so send the real figure again every 15 s.
  function syncUsage(snap, emit) {
    var w = snap.plan && snap.plan.week;
    if (!w) return;
    var now = Date.now();
    if (w.percent === lastUsage.percent && now - lastUsage.t < 15000) return;
    lastUsage = { percent: w.percent, t: now };
    emit({ type: 'usage', percent: w.percent });
  }
  var es = new EventSource('/events?t=' + encodeURIComponent(TOKEN));
  es.onmessage = function (e) {
    latest = JSON.parse(e.data);
    if (emitRef) { apply(latest, emitRef); syncUsage(latest, emitRef); }
    listeners.forEach(function (fn) { try { fn(latest); } catch (x) { /* a bad listener must not stop the office */ } });
  };

  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': TOKEN }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return r.ok ? { ok: true } : { ok: false, reason: j.error || 'The office could not do that.' }; }); },
            function () { return { ok: false, reason: 'The office server is not reachable.' }; });
  }
  function uidsOf(cmd) {
    var names = cmd.bots && cmd.bots.length ? cmd.bots : (cmd.bot ? [cmd.bot] : []);
    return Object.keys(known).filter(function (u) { return names.indexOf(known[u].name) >= 0 && !known[u].ended; });
  }
  function sessionOf(uid) { return latest && latest.sessions.filter(function (x) { return x.uid === uid; })[0] || null; }
  // The chat hands over data: or blob: URLs. The server needs the bytes.
  function readAttachments(list) {
    return Promise.all((list || []).map(function (a) {
      return fetch(a.url).then(function (r) { return r.blob(); }).then(function (b) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve({ name: a.name || 'file', mime: a.mime || b.type || '', data: String(fr.result).split(',')[1] || '' }); };
          fr.onerror = reject;
          fr.readAsDataURL(b);
        });
      });
    }));
  }
  function sendAll(uids, body) {
    return Promise.all(uids.map(function (u) { return post('/api/message', Object.assign({ uid: u }, body)); }))
      .then(function (rs) { return rs.every(function (r) { return r.ok; }) ? { ok: true } : rs.filter(function (r) { return !r.ok; })[0]; });
  }

  window.officeAdapter = AgentOffice.adapters.create({
    name: 'Claude Code',
    // Called each time a scene mounts. buildingFor() set the layout of the building it shows.
    subscribe: function (emit) {
      gen++; emitRef = emit; known = {}; taken = {}; lastUsage = { percent: null, t: 0 };
      var g0 = gen;
      setTimeout(function () { if (g0 === gen && latest) { apply(latest, emit); syncUsage(latest, emit); } }, 0);
    },
    send: function (cmd) {
      var uids;
      switch (cmd.type) {
        case 'session.stop': return post('/api/close', { uid: cmd.session });
        case 'approve': case 'decline': return post('/api/answer', { id: cmd.requestId, allow: cmd.type === 'approve' });
        case 'message':
          uids = uidsOf(cmd);
          if (!uids.length) return Promise.resolve({ ok: false, reason: 'No open session to send to.' });
          if (cmd.attachments && cmd.attachments.length) {
            return readAttachments(cmd.attachments).then(function (files) { return sendAll(uids, { text: cmd.text || '', attachments: files }); },
              function () { return { ok: false, reason: 'Could not read the attachment.' }; });
          }
          return sendAll(uids, { text: cmd.text });
        case 'pause':   // stops the turn that is running; the session stays open
          uids = uidsOf(cmd);
          return uids.length ? post('/api/interrupt', { uid: uids[0] }) : Promise.resolve({ ok: false, reason: 'No open session.' });
        case 'resume':
          uids = uidsOf(cmd);
          return uids.length ? sendAll(uids, { text: 'Continue.' }) : Promise.resolve({ ok: false, reason: 'No open session.' });
        case 'retry': {
          uids = uidsOf(cmd);
          var last = uids.length && sessionOf(uids[0]);
          return last && last.prompt ? sendAll(uids, { text: last.prompt }) : Promise.resolve({ ok: false, reason: 'Nothing to run again.' });
        }
        case 'dismiss': {
          var du = uidsOf(cmd)[0], d = du && known[du];
          if (d && d.status === 'error' && emitRef) {
            var last = sessionOf(du);
            d.status = last ? mapStatus(last) : 'resting'; d.task = last ? taskOf(last) : '';
            emitRef({ type: 'status', bot: d.name, status: d.status, task: d.task });
          }
          return Promise.resolve({ ok: true });
        }
        default: return Promise.resolve({ ok: false, reason: 'Not available for Claude Code sessions.' });
      }
    },
    dispose: function () { emitRef = null; gen++; }
  });

  // The buildings: one per repository with an open session, busiest first.
  window.officeAdapter.buildings = function (snap) {
    var by = {};
    snap = snap || latest;
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
  };
  // The building definition for one repository, with a floor per branch and a room per worktree.
  // The default branch is the ground floor. Mount the scene right after this call.
  // A building definition: a floor per branch, a room per worktree, the default branch at the bottom.
  // With bots, each room also lists its sessions (for previews such as BuildingView); the scene gets
  // its bots from events instead. Returns { def, floors: { branch: { id, rooms: { root: roomId } } }, nextId }.
  function describe(repo, snap, withBots) {
    var byBranch = {}, order = [], name = repo ? base(repo) : OTHER, bots = {};
    var rp = repoOf(snap, repo), places = rp ? rp.worktrees.map(function (w) { return wtPlace(rp, w); }) : [];
    live(snap).forEach(function (s) {
      var pl = placeOf(s);
      places.push(pl);
      if (withBots && pl.repo === repo) (bots[pl.root] = bots[pl.root] || []).push({ name: s.name, role: 'coder', shape: shapeOf(s.uid), status: mapStatus(s), task: taskOf(s) });
    });
    places.forEach(function (pl) {
      if (pl.repo !== repo) return;
      name = pl.repoName;
      if (!byBranch[pl.branch]) { byBranch[pl.branch] = {}; order.push(pl.branch); }
      byBranch[pl.branch][pl.root] = pl;
    });
    order.sort(function (a, b) { return (/^(main|master|trunk)$/.test(b) ? 1 : 0) - (/^(main|master|trunk)$/.test(a) ? 1 : 0); });
    var map = {}, nextId = 1;
    var floors = order.map(function (br) {
      var f = map[br] = { id: nextId++, rooms: {} };
      var rooms = Object.keys(byBranch[br]).map(function (root) {
        var r = roomDef(byBranch[br][root]); f.rooms[root] = r.id;
        if (withBots) r.bots = bots[root] || [];
        return r;
      });
      return floorDef(f.id, br, rooms);
    });
    // An empty building still needs a floor to stand on.
    if (!floors.length) { floors = [floorDef(1, 'No sessions', [])]; nextId = 2; }
    return { def: { name: name || OTHER, sessions: 'agent', floors: floors }, floors: map, nextId: nextId };
  }
  // The building the scene shows. Mount the scene right after this call.
  window.officeAdapter.buildingFor = function (repo) {
    var d = describe(repo, latest, false);
    layout = { repo: repo, floors: d.floors, nextId: d.nextId };
    return d.def;
  };
  // A building with its bots, for a preview. It does not change what the scene shows.
  window.officeAdapter.preview = function (repo, snap) { return describe(repo, snap || latest, true).def; };
  window.officeAdapter.shapeOf = function (uid) { return shapeOf(uid); };
  window.officeAdapter.shown = function () { return layout.repo; };
  // Rooms in the shown scene, as "branch|root". The page rebuilds the scene when one of them is gone,
  // because the design system has no event that removes a floor or a room.
  window.officeAdapter.roomsShown = function () {
    var out = [];
    Object.keys(layout.floors).forEach(function (br) { Object.keys(layout.floors[br].rooms).forEach(function (root) { out.push(br + '|' + root); }); });
    return out;
  };
  // Rooms that exist now for one repository: worktrees and the folders of open sessions.
  window.officeAdapter.roomsNow = function (snap, repo) {
    var rp = repoOf(snap, repo), out = {};
    if (rp) rp.worktrees.forEach(function (w) { out[w.branch + '|' + w.root.toLowerCase()] = true; });
    live(snap).forEach(function (s) { var pl = placeOf(s); if (pl.repo === repo) out[pl.branch + '|' + pl.root] = true; });
    return out;
  };

  // Read access for the page: the latest snapshot, one bot's session, and a change hook.
  window.officeAdapter.onSnapshot = function (fn) { listeners.push(fn); if (latest) fn(latest); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; };
  window.officeAdapter.session = function (botName) {
    for (var uid in known) { if (known[uid].name === botName && !known[uid].ended) return sessionOf(uid); }
    return null;
  };
  // Commands and skills a bot's session reported (sessions that run inside the office only).
  window.officeAdapter.lookup = function (botName) {
    var s = window.officeAdapter.session(botName);
    return s ? { uid: s.uid, commands: s.commands || [], skills: s.skills || [] } : null;
  };
})();
