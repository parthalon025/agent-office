/* Agent Office kit x1.7.16: reference Manager (a small orchestrator).
   Use it only when your platform has no orchestrator of its own. It runs in the page, wraps your adapter,
   and turns one request to the Manager into a plan, delegations and assign commands to your agents.

   var adapter = AgentOffice.manager.create({
     adapter: myAdapter,              // your adapter, or AgentOffice.adapters.mock()
     name: "Manager",                 // the orchestrator bot (added to the first room if it is missing)
     planner: async function (text, bots) { return [{ text: "Find 3 sources", bot: "Scout" }]; }  // optional, for example an LLM call
   });

   Without a planner, the Manager splits the request on "then", "and then" and ";", and routes each step
   to the best free bot by role words. Steps run in order. A step ends when its bot sends status "finished"
   (or "error"), or after timeoutMs. The scene shows the plan, the hand-off lines and the result. */
(function () {
  var A = window.AgentOffice;
  var WORDS = {
    research: "research find search sources source read look check facts brief compare competitor",
    writer: "write draft email reply post copy summary summarize blog story letter",
    coder: "code fix bug deploy test build ship refactor pr script repo",
    analyst: "analyze analysis numbers data chart report pricing reconcile score forecast metrics",
    designer: "design image mockup logo layout visual thumbnail render",
    ops: "backup server uptime patch monitor restart infra rotate host",
    sales: "lead leads prospect pipeline call outreach crm deal",
    planner: "plan schedule calendar meeting route split roadmap",
    media: "video reel audio caption edit clip podcast",
    ae: "account executive briefing stakeholder", specialist: "business case opportunity", partner: "partner",
    se: "demo environment", csa: "architecture landing zone azure policy", csam: "adoption health renewal", fde: "prototype integration"
  };
  var STOP = " the a an and or of to for on in at by with from this that these those my our your its is are be it me us all any some next new now then ";
  function words(t) { return (String(t || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter(function (x) { return x.length > 2 && STOP.indexOf(" " + x + " ") < 0; }); }
  function split(text) {
    return String(text).split(/\s*(?:;|,?\s+and then\s+|,?\s+then\s+|\.\s+)\s*/i).map(function (x) { return x.replace(/[.\s]+$/, ""); }).filter(function (x) { return x.length > 2; });
  }
  function score(step, b, home) {
    var w = words(step), s = 0, roleW = words((WORDS[b.role] || "") + " " + b.role + " " + (A.ROLES[b.role] || {}).label + " " + (b.tasks || []).join(" ")), nameW = words(b.name);
    w.forEach(function (x) { if (roleW.indexOf(x) > -1) s += 2; if (nameW.indexOf(x) > -1) s += 3; });
    if (!s) return 0;
    if (b.status === "resting" || b.status === "finished") s += 1;
    if (home != null && b.floor === home) s += 1;
    if (b.status === "waiting" || b.status === "error") s -= 2;
    return s;
  }
  function route(text, bots) {
    var m = bots.filter(function (b) { return b.orchestrator; })[0], home = m && m.floor, pool = bots.filter(function (b) { return !b.orchestrator && !b.ephemeral; }), used = {};
    return split(text).map(function (st) {
      var best = null, bs = 0;
      pool.forEach(function (b) { var sc = score(st, b, home) - (used[b.name] ? 1 : 0); if (sc > bs) { bs = sc; best = b; } });
      if (best) used[best.name] = 1;
      return { text: st.charAt(0).toUpperCase() + st.slice(1), bot: best && best.name };
    });
  }
  function create(o) {
    o = o || {};
    var inner = o.adapter || A.adapters.mock({ orchestrate: false }), name = o.name || "Manager", ctx = null, runs = [], seq = 0, timeout = o.timeoutMs || 120000, live = true;
    function mgr() { var l = ctx.bots(), m = l.filter(function (b) { return b.orchestrator && !b.ephemeral; })[0] || l.filter(function (b) { return b.name === name; })[0]; return m && m.name; }
    function say(text) { ctx.emit({ type: "message", bot: mgr(), text: text }); }
    function observe(ev) {
      if (ev.type !== "status" && ev.type !== "error") return;
      runs.forEach(function (r) {
        var st = r.steps[r.i];
        if (!st || st.owner !== ev.bot || !st.sent) return;
        var done = ev.type === "status" && ev.status === "finished", bad = ev.type === "error" || ev.status === "error";
        if (done || bad) finish(r, bad ? "error" : "finished", bad ? (ev.text || ev.task) : ev.task);
      });
    }
    function finish(r, status, note) {
      var st = r.steps[r.i]; if (!st || st.state) return; st.state = status; clearTimeout(st.timer);
      ctx.emit({ type: "plan.step", bot: r.mgr, id: st.id, status: status, owner: st.owner });
      ctx.emit({ type: "subagent.done", bot: st.owner, result: status === "finished" ? "Done: " + st.text.toLowerCase() : "Failed: " + (note || "no result") });
      if (status === "error") { r.failed = true; say("Stopped: " + st.text.toLowerCase() + " failed (" + (note || "no result") + "). " + r.i + " of " + r.steps.length + " steps done."); end(r, "error"); return; }
      r.i++; next(r);
    }
    function next(r) {
      if (!live) return;
      var st = r.steps[r.i];
      if (!st) { say("Done: " + r.goal.toLowerCase() + ". " + r.steps.length + " steps, " + r.agents + " agents."); end(r, "finished"); return; }
      ctx.emit({ type: "plan.step", bot: r.mgr, id: st.id, status: "working", owner: st.owner });
      ctx.emit({ type: "delegate", bot: r.mgr, to: st.owner, task: st.text });
      st.sent = true;
      Promise.resolve(inner.send({ type: "assign", bot: st.owner, bots: [st.owner], task: st.text, from: r.mgr })).catch(function () {});
      st.timer = setTimeout(function () { finish(r, "error", "no reply in " + Math.round(timeout / 1000) + " s"); }, timeout);
    }
    function end(r, status) {
      ctx.emit({ type: "status", bot: r.mgr, status: status === "finished" ? "finished" : "error", task: r.goal });
      runs.splice(runs.indexOf(r), 1);
    }
    function status() {
      var l = ctx.bots().filter(function (b) { return !b.orchestrator; }), c = {};
      l.forEach(function (b) { c[b.status] = (c[b.status] || 0) + 1; });
      return "Now: " + (c.working || 0) + " working, " + (c.waiting || 0) + " need you, " + (c.error || 0) + " with an error, " + (c.resting || 0) + " resting." + (runs.length ? " Plans running: " + runs.map(function (r) { return r.goal; }).join("; ") + "." : "");
    }
    function request(text) {
      var m = mgr(); if (!m) return;
      if (/^\s*(status|what.*(going on|happening)|report)\b/i.test(text)) { say(status()); return; }
      var bots = ctx.bots();
      Promise.resolve(o.planner ? o.planner(text, bots) : route(text, bots)).then(function (steps) {
        steps = (steps || []).filter(function (x) { return x && x.text; });
        var miss = steps.filter(function (x) { return !x.bot; });
        if (!steps.length || miss.length) {
          var roles = {}; bots.forEach(function (b) { if (!b.orchestrator) roles[(A.ROLES[b.role] || {}).label || b.role] = 1; });
          say("I need more detail" + (miss.length ? " for: " + miss.map(function (x) { return x.text.toLowerCase(); }).join("; ") : "") + ". Name the work or the team: " + Object.keys(roles).slice(0, 6).join(", ") + ".");
          return;
        }
        var r = { goal: text.replace(/[.\s]+$/, ""), mgr: m, i: 0, steps: steps.map(function (x, k) { return { id: "m" + (++seq) + "-" + k, text: x.text, owner: x.bot }; }) };
        r.agents = Object.keys(steps.reduce(function (a, x) { a[x.bot] = 1; return a; }, {})).length;
        runs.push(r);
        ctx.emit({ type: "skill.load", bot: m, skill: "plan" });
        ctx.emit({ type: "plan", bot: m, goal: r.goal, steps: r.steps.map(function (x) { return { id: x.id, text: x.text, status: "resting", owner: x.owner }; }) });
        ctx.emit({ type: "status", bot: m, status: "working", task: "Managing: " + r.goal });
        say("Plan: " + r.steps.map(function (x, k) { return (k + 1) + ". " + x.owner + ": " + x.text.toLowerCase(); }).join(" "));
        next(r);
      }).catch(function (e) { say("I could not make a plan: " + (e && e.message || e) + "."); });
    }
    return {
      name: (inner.name || "Agents") + " + " + name,
      init: function (c) {
        ctx = c;
        var proxy = { emit: function (ev) { c.emit(ev); observe(ev); }, bots: c.bots, roles: c.roles, getBuilding: c.getBuilding };
        if (inner.init) inner.init(proxy);
        if (!mgr()) { var b = c.getBuilding(), room = b.floors[0] && b.floors[0].rooms[0]; if (room) c.emit({ type: "bot.add", roomId: room.id, bot: { name: name, role: "planner", shape: "octa", orchestrator: true } }); }
      },
      send: function (cmd) {
        var m = ctx && mgr();
        if (cmd.type === "message" && m && cmd.bot === m) { setTimeout(function () { request(cmd.text); }, 300); return Promise.resolve({ ok: true }); }
        return inner.send(cmd);
      },
      dispose: function () { live = false; runs.forEach(function (r) { r.steps.forEach(function (s) { clearTimeout(s.timer); }); }); runs = []; if (inner.dispose) inner.dispose(); }
    };
  }
  A.manager = { create: create, route: route, split: split };
})();
