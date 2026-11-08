/* Agent Office for Claude Code x0.2: the page client (#178).
   The one Module that knows the office's routes. The page calls named commands and never writes a route string:
     const client = OfficeClient.createClient({ fetch, ready })      fetch and ready are injected (tests pass fakes)
     client.open(body)  client.merge(body)  ...                       one method per POST route, named in ROUTES
     client.send(name, body)                                          the same by name, for a helper that takes a command
     client.get(name, query) -> json     client.text(name) -> string   reads
     client.auth() / client.launch(code) / client.signin()            the access calls: they do not wait for ready
     client.url(name)                                                 the address of the event stream
   The error rules live here: a failed call rejects with an Error that carries .status and .body (the server's text, or
   "The office could not do that (<status>)."), and a question that answers 200 (the cost question, ask.js) rejects the same
   way so OfficeAsk.asked reads it. Every call waits for ready(): the page knows whether it has access first.
   Plain script, no I/O of its own: the page loads it as a script (window.OfficeClient); tests import it.
   Tested in test/client.test.mjs with a fake fetch. createClient({ fetch, ready }) gives one method per route in ROUTES.
   No other file in public/ has a route string (the test fails on one). A new route is one row in ROUTES. The Security
   room wall sends { cmd, body }, a command name, not a route. adapter.js makes the one client (officeAdapter.client) and
   page-core.js hands it to the dialogs as O.client. */
(function (root) {
  'use strict';
  // name -> route. A name is the route in camel case. Add a route here and it is a method.
  var ROUTES = Object.freeze({
    answer: '/api/answer', auth: '/api/auth', branches: '/api/branches', changes: '/api/changes', choices: '/api/choices',
    close: '/api/close', control: '/api/control', customExport: '/api/custom/export', customImport: '/api/custom/import',
    dismiss: '/api/dismiss', export: '/api/export', ext: '/api/ext', extList: '/api/ext/list',
    floorCleanup: '/api/floor/cleanup', floorCreate: '/api/floor/create', floorDelete: '/api/floor/delete', floorStale: '/api/floor/stale',
    fork: '/api/fork', goalApprove: '/api/goal/approve', goalCancel: '/api/goal/cancel', goalHandoff: '/api/goal/handoff',
    goalRetry: '/api/goal/retry', managerHire: '/api/manager/hire', managers: '/api/managers', hqReportingLine: '/api/hq/reporting-line', hqWrite: '/api/hq/write', hqGrid: '/api/hq/grid', hqGridSet: '/api/hq/grid/set', hqSelfApproval: '/api/hq/self-approval/set', history: '/api/history', historyForget: '/api/history/forget', info: '/api/info',
    interrupt: '/api/interrupt', layout: '/api/layout', merge: '/api/merge', message: '/api/message', notesSave: '/api/notes/save',
    open: '/api/open', orientation: '/api/orientation', orientationStep: '/api/orientation/step', paperclipConnect: '/api/paperclip/connect', paperclipCompany: '/api/paperclip/company', paperclipDisconnect: '/api/paperclip/disconnect',
    paperclipSupervise: '/api/paperclip/supervise', personaDelete: '/api/persona/delete', personaSave: '/api/persona/save',
    paperclipRuntimeInstall: '/api/paperclip/runtime/install', paperclipRuntimeUpdate: '/api/paperclip/runtime/update', paperclipRuntimeStart: '/api/paperclip/runtime/start', paperclipRuntimeStop: '/api/paperclip/runtime/stop',
    paperclipRuntimeKey: '/api/paperclip/runtime/key', paperclipRuntimeConnect: '/api/paperclip/runtime/connect', paperclipRuntimeDisconnect: '/api/paperclip/runtime/disconnect', personaDelete: '/api/persona/delete', personaSave: '/api/persona/save',
    personaStarters: '/api/persona/starters', personas: '/api/personas', pr: '/api/pr', providers: '/api/providers', recap: '/api/recap',
    reopen: '/api/reopen', roomCreate: '/api/room/create', roomDelete: '/api/room/delete', scheduleDelete: '/api/schedule/delete',
    scheduleRun: '/api/schedule/run', scheduleSave: '/api/schedule/save', screenSet: '/api/screen/set', search: '/api/search',
    securitySet: '/api/security/set', session: '/api/session', paperclipTranscript: '/api/paperclip/transcript', settingsFocus: '/api/settings/focus', settingsSpend: '/api/settings/spend',
    skillsDelete: '/api/skills/delete', skillsList: '/api/skills/list', skillsRead: '/api/skills/read', skillsSave: '/api/skills/save',
    startup: '/api/startup', teamDelete: '/api/team/delete', teamSave: '/api/team/save', teamStart: '/api/team/start',
    templateDelete: '/api/template/delete', templateSave: '/api/template/save', tree: '/api/tree', trustApply: '/api/trust/apply',
    trustDismiss: '/api/trust/dismiss', trustWithdraw: '/api/trust/withdraw', worktreeRemove: '/api/worktree/remove',
    hqCosts: '/api/hq/costs', hqHire: '/api/hq/hire', hqHireDesk: '/api/hq/hire-desk', hqAdapter: '/api/hq/adapter', hqCatalog: '/api/hq/catalog', hqAccess: '/api/hq/access', hqInstance: '/api/hq/instance', hqCompanyExport: '/api/hq/company/export',
    memory: '/api/memory', memoryRemember: '/api/memory/remember', memoryForget: '/api/memory/forget',
    events: '/events', launch: '/launch', signin: '/remote/signin'
  });
  var ACCESS = { auth: 1, launch: 1, signin: 1 };   // how the page gets ready: they never wait for it
  function routeOf(name) {
    if (!Object.prototype.hasOwnProperty.call(ROUTES, name)) throw new Error('Unknown office command: ' + name);
    return ROUTES[name];
  }
  function query(q) {
    var parts = [];
    Object.keys(q || {}).forEach(function (k) {
      if (q[k] === undefined || q[k] === null || q[k] === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k]));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }
  function createClient(deps) {
    var doFetch = deps.fetch, ready = deps.ready;
    function afterReady(path, opts) { return Promise.resolve(ready()).then(function () { return doFetch(path, opts); }); }
    function postOpts(body) { return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }; }
    function json(r) { return r.json().catch(function () { return {}; }); }
    var client = {
      // A command: POST with a JSON body. Resolves the answer; rejects with the error rules above.
      send: function (name, body) {
        return afterReady(routeOf(name), postOpts(body)).then(function (r) {
          return json(r).then(function (j) {
            if (!r.ok) { var e = new Error(j.error || 'The office could not do that (' + r.status + ').'); e.status = r.status; e.body = j; throw e; }
            // A question before the call can run (the cost question, 200 { confirm, question }): the caller asks, as for a 409.
            if (root.OfficeAsk.isQuestion(j)) { var q = new Error(j.question); q.status = r.status; q.body = j; throw q; }
            return j;
          });
        });
      },
      get: function (name, q) {
        return afterReady(routeOf(name) + query(q)).then(function (r) {
          if (!r.ok) { var e = new Error(String(r.status)); e.status = r.status; throw e; }
          return r.json();
        });
      },
      text: function (name, q) {
        return afterReady(routeOf(name) + query(q)).then(function (r) {
          if (!r.ok) { var e = new Error(String(r.status)); e.status = r.status; throw e; }
          return r.text();
        });
      },
      url: routeOf,
      // The access calls answer { ok, status, body } and never reject on a status.
      auth: function () { return doFetch(routeOf('auth')).then(function (r) { return json(r).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); }); },
      launch: function (code) { return doFetch(routeOf('launch'), postOpts({ code: code })).then(function (r) { return json(r).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); }); },
      signin: function () { return doFetch(routeOf('signin'), postOpts({})).then(function (r) { return { ok: r.ok, status: r.status }; }); }
    };
    Object.keys(ROUTES).forEach(function (name) {
      if (ACCESS[name] || name === 'events' || Object.prototype.hasOwnProperty.call(client, name)) return;
      client[name] = function (body) { return client.send(name, body); };
    });
    return client;
  }
  root.OfficeClient = { ROUTES: ROUTES, createClient: createClient };
})(typeof globalThis !== 'undefined' ? globalThis : window);
