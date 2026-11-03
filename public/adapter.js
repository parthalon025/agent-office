/* Agent Office adapter x0.1 for Claude Code (bridge pattern, hooks in, process control out).
   The server (server.mjs) turns Claude Code hook events into session snapshots and streams them
   over SSE. This file turns each snapshot into Agent Office events:
   - Project folder -> room (room.add). Claude Code session -> bot in its project room.
   - Tool use -> tool.call / tool.result (arguments, time, failure). Skill -> skill.load. Web reads -> knowledge.
   - Subagent (Task or Agent tool) -> delegate with a spawned helper; its own tool calls show on the helper;
     subagent.done when it returns.
   - TodoWrite -> plan and plan.step. A failed turn or a spending limit -> error (Retry, Dismiss).
   - A run started by a schedule -> trigger.run.
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

  var known = {};   // uid -> mirror of what the office was told
  var taken = {};   // bot name -> true
  var rooms = {};   // room id -> true, for rooms this page added
  var emitRef = null;
  function uniqueName(base) {
    var n = base || 'session', i = 2;
    while (taken[n]) n = base + ' ' + i++;
    taken[n] = true;
    return n;
  }
  // One room per project. A worktree session sits with its main repository.
  function roomOf(s, emit) {
    var name = base(s.worktree && s.worktree.repo) || base(s.cwd) || 'Claude Code';
    var id = 'p-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root');
    if (!rooms[id]) { rooms[id] = true; emit({ type: 'room.add', floorId: 1, room: { id: id, type: 'lab', name: name, bots: [] } }); }
    return id;
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
    snapshot.sessions.forEach(function (s) {
      seen[s.uid] = true;
      var k = known[s.uid];
      if (!k) {
        if (s.status === 'ended') return;
        var name = uniqueName(s.name);
        k = known[s.uid] = { asked: {}, inbox: 0, replySeen: 0, name: name, status: mapStatus(s), task: taskOf(s), calls: {}, helpers: {}, helpersDone: {}, planSig: '', planState: [], errorSeen: 0, model: s.model, ended: false, room: roomOf(s, emit) };
        var bot = { name: name, role: 'coder', shape: SHAPES[hash(s.uid) % SHAPES.length], status: k.status, task: k.task, platform: 'Claude Code', identity: s.cwd };
        if (s.skills && s.skills.length) bot.skills = s.skills.slice(0, 16);
        if (s.scheduleId) bot.triggers = [s.name];
        emit({ type: 'bot.add', roomId: k.room, bot: bot });
        emit({ type: 'session.start', bot: name, session: s.uid, title: s.worktree ? s.cwd + ' (' + s.worktree.branch + ')' : s.cwd });
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
        setTimeout(function () { emit({ type: 'bot.remove', bot: bot0 }); delete taken[bot0]; }, REMOVE_AFTER_MS);
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

  var es = null;
  var latest = null;
  var listeners = [];

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
    subscribe: function (emit) {
      emitRef = emit;
      es = new EventSource('/events?t=' + encodeURIComponent(TOKEN));
      es.onmessage = function (e) {
        latest = JSON.parse(e.data);
        apply(latest, emit);
        listeners.forEach(function (fn) { try { fn(latest); } catch (x) { /* a bad listener must not stop the office */ } });
      };
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
    dispose: function () { if (es) es.close(); }
  });

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
