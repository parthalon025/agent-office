/* Agent Office adapter x0.2 for Claude Code (bridge pattern, hooks in, process control out).
   The server (src/server.mjs) turns Claude Code hook events into session snapshots and streams them
   over SSE. This file is the browser side: the event stream, the REST calls for DS commands and the
   window.officeAdapter facade. The snapshot store and the per-building adapter are in building.js, where the
   rules below live and the tests run (test/building.test.mjs). The rules:
   - Git repository -> building, branch -> floor, worktree -> room. The page shows one building at a
     time (officeAdapter.mount); new branches and worktrees arrive as floor.add and room.add.
     A folder outside git goes to the "Other folders" building, one room per folder.
   - Claude Code session -> bot in the room of its worktree.
   - Tool use -> tool.call / tool.result (arguments, time, failure). Skill -> skill.load. Web reads -> knowledge.
   - Subagent (Task or Agent tool) -> delegate with a spawned helper; its own tool calls show on the helper;
     subagent.done when it returns.
   - TodoWrite -> plan and plan.step. A failed turn or a spending limit -> error (Retry, Dismiss).
   - A run started by a schedule -> trigger.run. Plan usage from the status line file -> usage.
   - Permission prompt (PermissionRequest hook) -> request with Approve and Decline. It waits for the
     office; if nobody answers in time, the question goes back to the terminal dialog.
   Access (auth.mjs on the server): the page holds no token. The launch link the server opens carries a one-time
   code (#n=<code>). The page takes the code out of the address bar and trades it for an HttpOnly cookie with
   POST /launch. Every later call and the event stream send the cookie by themselves, so a reload keeps working.
   Without a working cookie the page says so (officeAdapter.onAuth) and asks again every 5 s: a launch link opened
   in another tab gives this tab the new cookie too. On the remote address (#133) the cookie comes from POST /remote/signin
   instead: Cloudflare Access adds its login to every request, and the server checks it.
   window.officeAdapter is the facade: the store plus mount(repo), which adds the DS adapter as .adapter. ready and
   onAuth(fn) are for access. onProblem(fn) fires when the older replies of a chat did not load (#80). The one client
   (officeAdapter.client) is made here; page-core.js hands it to the dialogs as O.client. DS commands go out as client
   calls (client.js). */
(function () {
  var problemFns = [];
  var ready;   // set below, once the access flow starts; the client reads it at each call
  var client = window.OfficeClient.createClient({ fetch: function (p, o) { return window.fetch(p, o); }, ready: function () { return ready; } });
  // The lean snapshot leaves out the oldest replies of a session with long replies (wire.js olderReplies). The store asks for
  // them here before a chat fills (#80): the whole reply list of one session, from the session read.
  var store = window.OfficeBuilding.createStore({
    fetchReplies: function (uid) {
      return client.get('session', { uid: uid }).catch(function () { throw new Error('No session.'); })
        .then(function (j) { return (j.session && j.session.replies) || []; });
    },
    onProblem: function (text) { problemFns.forEach(function (fn) { fn(text); }); }
  });

  var authFns = [], auth = null, es = null, retry = null;
  function setAuth(a) {
    if (auth && auth.ok === a.ok && auth.reason === a.reason) return;
    auth = a;
    authFns.forEach(function (fn) { fn(a); });
  }
  function probe() {
    return client.auth().then(function (r) { return r.ok ? { ok: true } : { ok: false, status: r.status, reason: r.body.error || 'No access.' }; },
      function () { return { ok: false, reason: 'The office server is not reachable.' }; });
  }
  // On the remote address (https; the local office is http) a page with no cookie asks for one with its Cloudflare Access
  // login: POST /remote/signin, no code. The server checks the login itself. Without a valid login it answers 403, and the
  // page says it has no access.
  function check() {
    return probe().then(function (a) {
      if (a.ok || a.status !== 401 || location.protocol !== 'https:') return a;
      return client.signin().then(function (r) { return r.ok ? probe() : a; }, function () { return a; });
    });
  }
  var code = /^#n=([0-9a-f]{32})$/.exec(location.hash);
  if (code) history.replaceState(null, '', location.pathname + location.search);   // the code works once; keep it out of history
  ready = !code ? check() : client.launch(code[1])
    .then(function (r) {
      // A used or old code: a cookie from an earlier link may still work.
      return r.ok ? { ok: true } : check().then(function (c) { return c.ok ? c : { ok: false, reason: r.body.error || c.reason }; });
    }, check);
  function connect() {
    var src = es = new EventSource(client.url('events'));
    // The first message is the whole snapshot, the next ones are patches (wire.js). A patch that does not fit the
    // snapshot the page has: connect again, and the server sends it whole.
    src.onmessage = function (e) {
      if (store.receive(JSON.parse(e.data)) || es !== src) return;
      src.close(); es = null; connect();
    };
    src.onopen = function () { setAuth({ ok: true }); };
    // CLOSED means the server refused the stream (no access, for example after a restart). On a lost connection the
    // browser tries again by itself, and the state stays CONNECTING.
    src.onerror = function () { if (src.readyState === 2 && es === src) { es = null; recheck(); } };
  }
  function recheck() {
    clearTimeout(retry);
    check().then(function (a) { if (a.ok) connect(); else { setAuth(a); retry = setTimeout(recheck, 5000); } });
  }
  ready.then(function (a) { if (a.ok) connect(); else { setAuth(a); retry = setTimeout(recheck, 5000); } });

  // A DS command's call, as the DS expects it: { ok } or { ok: false, reason }. A rejected command has the server's text; a call
  // that never got an answer has no status.
  function post(name, body) {
    return client.send(name, body).then(function () { return { ok: true }; },
      function (e) { return e.status ? { ok: false, reason: (e.body && e.body.error) || 'The office could not do that.' } : { ok: false, reason: 'The office server is not reachable.' }; });
  }
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
    return Promise.all(uids.map(function (u) { return post('message', Object.assign({ uid: u }, body)); }))
      .then(function (rs) { return rs.every(function (r) { return r.ok; }) ? { ok: true } : rs.filter(function (r) { return !r.ok; })[0]; });
  }

  // The DS commands of one mounted building, as REST calls.
  function send(m, cmd) {
    var uids, uidsOf = m.uidsOf, sessionOf = store.sessionByUid;
    switch (cmd.type) {
      case 'session.stop': return post('close', { uid: cmd.session });
      case 'approve': case 'decline': return post('answer', { id: cmd.requestId, allow: cmd.type === 'approve' });
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
        return uids.length ? post('interrupt', { uid: uids[0] }) : Promise.resolve({ ok: false, reason: 'No open session.' });
      case 'resume':
        uids = uidsOf(cmd);
        return uids.length ? sendAll(uids, { text: 'Continue.', answers: false }) : Promise.resolve({ ok: false, reason: 'No open session.' });
      case 'retry': {
        uids = uidsOf(cmd);
        var last = uids.length && sessionOf(uids[0]);
        return last && last.prompt ? sendAll(uids, { text: last.prompt, answers: false }) : Promise.resolve({ ok: false, reason: 'Nothing to run again.' });
      }
      case 'dismiss': {   // the server clears the error; the next snapshot moves every surface off Error
        var du = uidsOf(cmd)[0];
        return du ? post('dismiss', { uid: du }) : Promise.resolve({ ok: true });
      }
      default: return Promise.resolve({ ok: false, reason: 'The office does not support this command.' });
    }
  }

  // The facade the page and the scene modules use: the store, plus mount(repo).
  // mount(repo) makes a building adapter for one scene; pass its .adapter to OfficeScene and its .def as the building.
  var facade = Object.create(store);
  facade.client = client;   // the page's one client (client.js)
  facade.ready = ready;   // settles once the page knows whether it has access: { ok, reason }
  // fn({ ok, reason }) at once when access is known, and on each change. Returns the unsubscribe.
  facade.onAuth = function (fn) {
    authFns.push(fn);
    if (auth) fn(auth);
    return function () { authFns = authFns.filter(function (f) { return f !== fn; }); };
  };
  // fn(text) when the page could not load something it needs to show a bot's chat in full (older replies). Returns the unsubscribe.
  facade.onProblem = function (fn) {
    problemFns.push(fn);
    return function () { problemFns = problemFns.filter(function (f) { return f !== fn; }); };
  };
  facade.mount = function (repo) {
    var m = store.mount(repo);
    m.adapter = AgentOffice.adapters.create({
      subscribe: m.attach,
      send: function (cmd) { return send(m, cmd); },
      dispose: m.detach
    });
    // The HUD names the adapter ("Connected: ..."). The DS reads adapter.name each time it draws, so the name follows
    // the agent kinds of the building's open sessions (building.js agentName) instead of a fixed 'Claude Code'.
    Object.defineProperty(m.adapter, 'name', { configurable: true, enumerable: true, get: function () { return m.agentName() || 'Agent Office'; } });
    return m;
  };
  window.officeAdapter = facade;
})();
