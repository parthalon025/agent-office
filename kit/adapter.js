/* Agent Office kit x1.7.10: adapter template.
   1. Fill the two tables. 2. Change connect() and call() for your platform. 3. Keep AgentOffice.strict on while you test.
   Event and command names: Reference.md or kit/schema.json. */
(function () {
  // Platform event -> Agent Office event. Return null to drop an event.
  var EVENTS = {
    "agent.state":    function (e) { return { type: "status", bot: e.agent, status: e.state, task: e.task }; },
    "agent.say":      function (e) { return { type: "message", bot: e.agent, text: e.text }; },
    "agent.ask":      function (e) { return { type: "request", bot: e.agent, id: e.id, text: e.question }; },   // risky steps go here
    "agent.to.agent": function (e) { return { type: "message.agent", from: e.from, to: e.to, text: e.text }; },
    "session.open":   function (e) { return { type: "session.start", bot: e.agent, session: e.id, title: e.title, isolated: !!e.ownContext }; },
    "session.close":  function (e) { return { type: "session.end", bot: e.agent, session: e.id, ok: e.ok !== false, result: e.summary }; },
    "tool.start":     function (e) { return { type: "tool.call", bot: e.agent, id: e.callId, tool: e.name, kind: e.kind }; },
    "tool.end":       function (e) { return { type: "tool.result", bot: e.agent, id: e.callId, ok: e.ok, ms: e.ms, tokens: e.tokens, cost: e.cost }; },
    "agent.delegate": function (e) { return { type: "delegate", bot: e.agent, to: e.child, task: e.task }; }
  };
  // Agent Office command -> platform call. cmd.bots holds the target bot names.
  var COMMANDS = {
    "message":      function (c) { return { op: "send", to: c.bots, text: c.text }; },
    "approve":      function (c) { return { op: "answer", agent: c.bot, id: c.requestId, yes: true }; },
    "decline":      function (c) { return { op: "answer", agent: c.bot, id: c.requestId, yes: false }; },
    "session.stop": function (c) { return { op: "stop", agent: c.bot, session: c.session }; }
  };
  var ws = null;
  function connect(emit) {                       // change this for your platform
    ws = new WebSocket("wss://example.invalid/agents");
    ws.onmessage = function (m) { var e = JSON.parse(m.data), f = EVENTS[e.type], ev = f && f(e); if (ev) emit(ev); };
  }
  function call(body) {                          // change this for your platform
    return fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  window.myAdapter = AgentOffice.adapters.create({
    name: "My agents",
    subscribe: function (emit) { connect(emit); },
    send: function (cmd) { var f = COMMANDS[cmd.type]; return f ? call(f(cmd)) : Promise.resolve({ ok: false, reason: "not mapped: " + cmd.type }); },
    dispose: function () { if (ws) ws.close(); }
  });
})();
