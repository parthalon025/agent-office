/* Agent Office adapter x0.1 for Claude Code (bridge pattern, hooks in, process control out).
   The server (server.mjs) turns Claude Code hook events into session snapshots and streams them
   over SSE. This file turns each snapshot into Agent Office events.
   Claude Code session -> bot in the Lab room. Subagent (Task/Agent tool) -> spawned helper.
   Tool use -> tool.call / tool.result. Permission prompt (PermissionRequest hook) -> request with Approve and Decline.
   Permission prompts use the PermissionRequest hook, which waits for the office. If nobody answers in
   time, the question goes back to the terminal dialog. */
(function () {
  var TOKEN = document.querySelector('meta[name="office-token"]').content;
  var ROOM = 'lab';
  var SHAPES = ['cone', 'blob', 'octa', 'capsule'];
  var KIND = { Bash: 'terminal', WebFetch: 'browser', WebSearch: 'search', Grep: 'search', Glob: 'search', Read: 'code', Edit: 'code', Write: 'code', MultiEdit: 'code', NotebookEdit: 'code', Task: 'flow', Agent: 'flow', Skill: 'skill' };
  var REMOVE_AFTER_MS = 6000;

  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function kindOf(tool) { return KIND[tool] || (String(tool).indexOf('mcp__') === 0 ? 'mcp' : 'api'); }
  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
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

  var known = {};   // uid -> mirror of what the office was told
  var taken = {};   // bot name -> true
  function uniqueName(base) {
    var n = base || 'session', i = 2;
    while (taken[n]) n = base + ' ' + i++;
    taken[n] = true;
    return n;
  }

  function apply(snapshot, emit) {
    var seen = {};
    snapshot.sessions.forEach(function (s) {
      seen[s.uid] = true;
      var k = known[s.uid];
      if (!k) {
        if (s.status === 'ended') return;
        var name = uniqueName(s.name);
        k = known[s.uid] = { asked: {}, inbox: 0, replySeen: 0, name: name, status: mapStatus(s), task: taskOf(s), tools: s.tools, helpers: [], call: null, seq: 0, model: s.model, ended: false };
        emit({ type: 'bot.add', roomId: ROOM, bot: { name: name, role: 'coder', shape: SHAPES[hash(s.uid) % SHAPES.length], status: k.status, task: k.task } });
        emit({ type: 'session.start', bot: name, session: s.uid, title: s.cwd });
        if (s.model) emit({ type: 'model', bot: name, model: s.model });
        return;
      }
      if (k.ended) return;
      var bot = k.name;
      if (s.model && s.model !== k.model) { k.model = s.model; emit({ type: 'model', bot: bot, model: s.model }); }

      // tool calls: a call opens when s.tool appears and closes when the counter moves
      if (s.tool && !k.call) { k.call = 'c' + s.uid + '-' + (++k.seq); emit({ type: 'tool.call', bot: bot, id: k.call, tool: s.tool.name, kind: kindOf(s.tool.name) }); }
      if (s.tools > k.tools) {
        if (!k.call) { k.call = 'c' + s.uid + '-' + (++k.seq); emit({ type: 'tool.call', bot: bot, id: k.call, tool: 'Tool', kind: 'api' }); }
        emit({ type: 'tool.result', bot: bot, id: k.call, ok: true });
        k.call = null; k.tools = s.tools;
        if (s.tool) { k.call = 'c' + s.uid + '-' + (++k.seq); emit({ type: 'tool.call', bot: bot, id: k.call, tool: s.tool.name, kind: kindOf(s.tool.name) }); }
      }

      // subagents: one spawned helper per running Task or Agent call
      while (k.helpers.length < s.helpers) {
        var hn = uniqueName(bot + ' helper');
        k.helpers.push(hn);
        emit({ type: 'delegate', bot: bot, roomId: ROOM, spawn: { name: hn, role: 'research', shape: 'blob' }, task: s.tool ? clip(s.tool.detail, 60) : 'Subagent task' });
      }
      while (k.helpers.length > s.helpers) {
        var gone = k.helpers.pop(); delete taken[gone];
        emit({ type: 'subagent.done', bot: gone, remove: true, result: 'Done' });
      }

      // permission prompts: each pending question becomes one request with Approve and Decline
      (s.pending || []).forEach(function (r) {
        if (k.asked[r.id]) return;
        k.asked[r.id] = true;
        emit({ type: 'request', bot: bot, id: r.id, text: 'Allow ' + r.tool + (r.detail ? ': ' + clip(r.detail, 80) : '') + '?', risk: r.risk, tool: r.tool, preview: r.preview || r.detail });
      });

      // free-form questions from the session (office_ask): answer with Yes or No, or reply in the chat
      (s.questions || []).forEach(function (q) {
        if (k.asked[q.id]) return;
        k.asked[q.id] = true;
        emit({ type: 'request', bot: bot, id: q.id, text: q.text, risk: 'low', tool: 'office_ask' });
      });
      // what the session said (headless sessions only; a terminal session answers in its terminal)
      (s.replies || []).forEach(function (r) {
        if (r.id <= k.replySeen) return;
        k.replySeen = r.id;
        emit({ type: 'message', bot: bot, text: r.text });
      });
      // a queued message was read by the session
      var queued = (s.inbox || []).length;
      if (queued < k.inbox) emit({ type: 'message', bot: bot, text: 'I read your message.', format: 'plain' });
      k.inbox = queued;

      var st = mapStatus(s), task = taskOf(s);
      if (s.status === 'ended') {
        k.ended = true;
        emit({ type: 'session.end', bot: bot, session: s.uid, ok: true });
        emit({ type: 'status', bot: bot, status: 'resting', task: task });
        setTimeout(function () { emit({ type: 'bot.remove', bot: bot }); delete taken[bot]; }, REMOVE_AFTER_MS);
        return;
      }
      if (st !== k.status) { k.status = st; k.task = task; emit({ type: 'status', bot: bot, status: st, task: task }); }
      else if (task !== k.task) { k.task = task; emit({ type: 'status', bot: bot, status: st, task: task, quiet: true }); }
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
        case 'dismiss': return Promise.resolve({ ok: true });
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
