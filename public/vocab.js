/* Agent Office for Claude Code x0.2: session vocabulary.
   One home for the words and rules that every surface shares: the status key and word of a session, its task
   line, the kind and short name of a tool, the status of a to-do, and the figures of a room.
   Plain script, no I/O, no timers. The page loads it as a script (window.OfficeVocab). The server and the tests
   import it for its side effect and read globalThis.OfficeVocab.

     status(s)        -> { key, word, live }  key is a DS status: working, waiting, error, finished, resting
     worst(keys)      -> the worst state of a set of desks (error, waiting, review, working, finished, resting), or null
     stateWord(key)   -> the word of a worst state ('Needs you', 'Review ready', ...), '' for none
     laneOf(model)    -> the model lane (Haiku, Sonnet, Opus, Fable) of a model id, or ''
     isWaiting(s)     -> true when the session has a pending permission prompt or an open question.
                         A subagent's tool call does not change it.
     taskLine(s)      -> the task text next to the state word
     toolKind(name)   -> a DS tool kind (terminal, code, search, browser, flow, skill, memory, mcp, api)
     toolShort(name)  -> the short tool name every surface shows
     toolArg(name)    -> the argument name of the tool's detail text
     todoStatus(t)    -> a DS plan step status
     figures(list)    -> the numbers of a room, from its open sessions
     agentsSign(n)    -> "N agents" for a room shared by 2 or more agents (top-level sessions; helpers do not count), else ''
     plan             -> the Manager board words (#154): sourceWord(kind) 'Office' or 'Paperclip', stepState(state), stepWord(state), notConnected, notConnectedReason(why)
     requests(s)      -> every open request of a session, oldest first: { id, kind, tool, text, detail, risk, always, t }
                         kind is 'permission' (Approve or Decline) or 'question' (Yes or No; no risk value)
     featuresOf(s)    -> the office features the session's agent kind declares (#72): [{ key, label }], in table order
     hasFeature(s, k) -> true when the agent kind declares feature k. The page shows a feature only then, never a greyed-out control.
     holdMs(s)        -> how long the office holds a request of this session (ms)
     alwaysOffer(s)   -> the first permission request that may offer "Always allow", or null. Never a question,
                         never a high-risk request, never one without a rule to save.
     kindWord(s, kinds) -> the agent kind of a session as a word ('Claude Code', 'Ollama'): the label of s.provider in
                         kinds (the snapshot's kinds), else the kind id. '' when the session has no kind.
     kindsWord(list, kinds) -> the kinds of a list of sessions as one word ('Claude Code, Ollama'): each kind once,
                         in the order of kinds, a kind it does not know last. '' when no session has a kind.
   Agent kinds as the Open dialog, a room's Add agent and the Agent kinds view show them. A kind k is a snapshot kind
   (providers/index.mjs describe) with its GET /api/providers answer: { checking, ready, models, needs, ... }.
     kindState(k)     -> { key, word }: Checking (no answer yet), Ready, Not ready or Not configured (a cloud kind the user has not
                         set up), with a DS status key
     notConfigured(k) -> true when the kind answered and is not set up (Open session waits)
     needsTitle(k)    -> the title of the box that lists what a kind needs: 'X is not configured' or 'X is not ready'
     modelLabel(k)    -> what the dialog calls the pick: 'Foundry agent' or 'Model'
     modelNoun(k)     -> what the pick chooses, lower case: 'agent' or 'model' (for 'No agents', 'Looking for agents')
     pickFact(k)      -> the Agent kinds fact for a kind that needs a pick ('You pick the Foundry agent'), else null
     modelChoices(k, fallback) -> the Model options. A kind with a default model starts with Default; a local model
                         offers only its models. No kind, or a default-model kind before its answer: fallback.
     modelSwitch(k, current, fallback) -> the dock switch options: the kind's models, no Default, plus the session's own unknown model
     modelWord(k, id, fallback) -> the label of a model id in the kind's list, else the id; no id: Default model
     firstModel(k)    -> the model a kind starts on: the first of a kind that needs one, else '' (Default)
     noModelFor(k)    -> true when the kind needs a model and has none to pick (Open session waits)
     withKind(form, k, id) -> the form after a kind change: its first model, and only the options that kind takes
     kindNote(k, terminal) -> the line that says where a kind runs and what it costs
     security         -> the Security room grid (#70), shared by its wall screens and the server's rules (security.mjs):
                         screens [{ id, title, rows }], rows { id: { label, options, def, office?, only?, not? } } (only:
                         the kinds that have a cell in the row; not: the kinds that have none), columns [{ id, label, free? }] (agent kinds; free: it costs nothing), columnOf(providerKind), options(row), valueOf(rules, building, row,
                         col), sourceOf(...) ('building' | 'office' | 'default'), next(row, value), loosens(row, from, to),
                         applies(row, col), na(row, col), word(value), key(row, col), own(map, key) (an own key, never
                         an inherited one: rule maps come from requests and state.json).
                         rules: { office: { 'row|col': value }, buildings: { buildingKey: { 'row|col': value } } }.
     hq               -> Paperclip HQ words (#76): status(agent) { key, word } (never waiting: a Paperclip approval is not an
                         office request), budget(b) ("$8.30 of $50.00 this month"), every(seconds) (a heartbeat), supervision(agent)
                         ("Supervised in office" or the label), state(snap.hq) (the connection as a line).
     layers           -> the four layers of detail (ADR 0006): glance (is all fine), look (what is it doing, how is it going), inspect (exactly
                         what happened), deep (proof and rules). order, opens(layer) (the next layer, '' at deep), surfaces (each surface's
                         layer and the layer it opens), surface(id), mood(state) ({ key, word } of a worst state: calm, busy, needs you, failed),
                         glance(fig, worst) ({ state, mood, text }: text only when something needs the owner, else ''), look(s) ({ intent, progress,
                         cost }: one sentence, "2 of 5 steps" and the cost so far), remember(mem, place, layer) and layerFor(mem, place) (the layer
                         a place is used at most; Glance for a new place). No page code invents a detail rule.
     platform(s, kinds) -> the bot card line: the supervision label or the kind word, after "Paperclip <role>, " for a Paperclip run.
*/
(function (root) {
  'use strict';
  var KIND = { code_interpreter: 'terminal', file_search: 'search', bing_grounding: 'search', Knowledge: 'search', Connector: 'mcp', Topic: 'flow', Bash: 'terminal', PowerShell: 'terminal', WebFetch: 'browser', WebSearch: 'search', Grep: 'search', Glob: 'search', Read: 'code', Edit: 'code', Write: 'code', MultiEdit: 'code', NotebookEdit: 'code', Task: 'flow', Agent: 'flow', Skill: 'skill', TodoWrite: 'memory' };
  var ARG = { Bash: 'command', PowerShell: 'command', Read: 'file', Edit: 'file', Write: 'file', MultiEdit: 'file', NotebookEdit: 'file', Grep: 'pattern', Glob: 'pattern', WebFetch: 'url', WebSearch: 'query', Task: 'task', Agent: 'task', Skill: 'skill' };
  var TODO = { pending: 'resting', in_progress: 'working', completed: 'finished', error: 'error' };

  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function has(a) { return !!(a && a.length); }
  function oneLine(t) { return clip(String(t == null ? '' : t).replace(/\s+/g, ' ').trim(), 300); }

  // What an agent kind has beyond the seam (#72), in the order the page shows it. A provider declares the keys (providers/index.mjs
  // features); the resume and images keys are not office features and have no entry. The server puts the list on the session.
  var FEATURES = [
    ['skills', 'Skills'], ['memory', 'Memory'], ['fork', 'Fork'], ['reason', 'Reasons'], ['teams', 'Agent teams'], ['schedules', 'Scheduled tasks']
  ];
  function hasFeature(s, key) { return !!(s && s.features && s.features.indexOf(key) >= 0); }
  function featuresOf(s) {
    return FEATURES.filter(function (f) { return hasFeature(s, f[0]); }).map(function (f) { return { key: f[0], label: f[1] }; });
  }

  function isWaiting(s) { return !!s && s.status !== 'ended' && (has(s.pending) || has(s.questions)); }

  function status(s) {
    if (!s) return { key: 'resting', word: 'No session', live: false };
    if (s.status === 'ended') return { key: 'resting', word: 'Closed', live: false };
    if (isWaiting(s)) return { key: 'waiting', word: 'Needs you', live: true };
    if (s.status === 'starting') return { key: 'resting', word: 'Resting', live: true };
    if (s.status === 'working') return { key: 'working', word: 'Working', live: true };
    if (s.error) return { key: 'error', word: 'Error', live: true };
    return s.turns > 0 ? { key: 'finished', word: 'Finished', live: true } : { key: 'resting', word: 'Resting', live: true };
  }

  // The worst state of a set of desks (#92) is the DS's one order, AgentOffice.worstOf (error, needs you, review ready, working,
  // finished, resting): the elevator lights its buttons with it, and building.js the room doors and the city windows. review is the
  // state of a change that waits for the user's review (the paper flow, #93); no session status gives it yet. The words:
  var STATE_WORD = { error: 'Error', waiting: 'Needs you', review: 'Review ready', working: 'Working', finished: 'Finished', resting: 'Resting' };
  function stateWord(k) { return STATE_WORD[k] || ''; }
  // The Manager board (#154): who plans a goal (the source) and the state of a plan step. Words are the board's only copy.
  var PLAN_SOURCE = { office: 'Office', paperclip: 'Paperclip' };
  var PLAN_STEP = { pending: 'Waiting', working: 'Working', finished: 'Done', error: 'Error', unknown: 'Unknown' }; // unknown: a state the source has no word for (never done)
  var GOAL_WORD = { planning: 'Planning', 'awaiting-approval': 'Waiting for your approval', running: 'Running', finished: 'Done', blocked: 'Blocked', stopped: 'Stopped', failed: 'Failed', cancelled: 'Cancelled', 'handed-off': 'Handed to Paperclip', 'handoff-failed': 'Handoff failed' };
  var plan = {
    sourceWord: function (kind) { return PLAN_SOURCE[kind] || ''; },
    stepState: function (state) { return PLAN_STEP[state] ? state : 'pending'; },
    stepWord: function (state) { return PLAN_STEP[state] || PLAN_STEP.pending; },
    notConnected: 'Not connected',
    notConnectedReason: function (why) { return 'Not connected.' + (why ? ' ' + why : '') + ' The steps are the last ones read.'; },
    // The state of an office goal (manager.mjs status). A Paperclip plan has none of its own: its steps carry the state.
    goalWord: function (status) { return status === 'not-connected' ? 'Not connected' : GOAL_WORD[status] || ''; },
    readOnlyNote: function (kind) { return kind === 'paperclip' ? 'Read only. Paperclip plans this work.' : ''; },
    unreadable: function (word) { return 'The ' + word + ' plan could not be read. It is not shown.'; },
    // One view of the snapshot's plans field (the Manager panel, the room wall, Ctrl+K). building: only that building's goals.
    board: function (snap, building) {
      var plans = (snap && snap.plans) || [], un = (snap && snap.unreadable) || [];
      var groups = plans.filter(function (p) { return !building || p.building === building; }).map(function (p) {
        var steps = p.steps || [], note = p.frozen ? p.reason : (p.source === 'paperclip' ? plan.readOnlyNote(p.source) : (p.reason || ''));
        return { id: p.id, building: p.building, source: p.source, sourceWord: p.sourceWord, goal: p.goal, readOnly: p.source === 'paperclip', frozen: !!p.frozen, status: p.status,
          stateWord: plan.goalWord(p.status), note: note, steps: steps, total: steps.length, done: steps.filter(function (x) { return x.state === 'finished'; }).length };
      });
      return { groups: groups, empty: !groups.length && !un.length, unreadable: un.map(function (u) { return plan.unreadable(u.word); }) };
    },
    // What waits for the owner: an office goal that needs approval, an office step that failed. Paperclip's steps are not the office's to answer.
    waits: function (snap) {
      var out = [];
      ((snap && snap.plans) || []).forEach(function (p) {
        if (p.source !== 'office') return;
        if (p.status === 'awaiting-approval') out.push({ id: p.id, building: p.building, text: 'Approve the plan: ' + clip(p.goal, 60), kind: 'approve' });
        (p.steps || []).forEach(function (x) { if (x.state === 'error' && p.status !== 'cancelled') out.push({ id: p.id, building: p.building, step: x.id, text: 'Step failed: ' + clip(x.title, 60), kind: 'retry' }); });
      });
      return out;
    }
  };
  // The model lane of a session (#88): Haiku, Sonnet, Opus or Fable, from its model id; '' for another model.
  function laneOf(model) {
    var m = /\b(haiku|sonnet|opus|fable)\b/i.exec(String(model || '').replace(/[-_.]/g, ' '));
    return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : '';
  }

  // The HUD adds the state word ("Working · ..."), so the task text carries only the task.
  // A Paperclip run (#76, s.hq: the server's label of the run) shows its Paperclip task in place of the prompt: Paperclip's
  // prompt is its long wake-up text, the task is what the run is for.
  function taskLine(s) {
    var k = status(s).key, job = s.hq && s.hq.task ? clip(s.hq.task, 70) : '';
    if (s.status === 'ended') return 'Left the office';
    if (k === 'waiting') return clip(s.note, 90) || 'Needs your attention';
    if (s.status === 'starting') return 'Waiting for the first hook';
    if (k === 'working') {
      if (s.live) return clip(String(s.live).replace(/\s+/g, ' ').slice(-90), 90);
      return s.tool ? s.tool.name + (s.tool.detail ? ' ' + clip(s.tool.detail, 60) : '') : (job || clip(s.prompt, 70) || 'Thinking');
    }
    if (k === 'error') return clip(s.error.text, 200) || 'The turn failed.';
    return job || (s.turns > 0 ? (clip(s.prompt, 60) || 'Last turn') : 'Waiting for a prompt');
  }

  function toolKind(name) { if (/__browser_|playwright/i.test(String(name))) return 'browser'; return KIND[name] || (String(name).indexOf('mcp__') === 0 ? 'mcp' : 'api'); }
  function toolArg(name) { return ARG[name] || 'input'; }
  // mcp__plugin_playwright_playwright__browser_click -> browser click; mcp__server__tool -> server tool
  function toolShort(name) {
    var n = String(name == null ? '' : name), m = n.match(/__browser_([a-z_]+)$/i);
    if (m) return 'browser ' + m[1].replace(/_/g, ' ');
    m = n.match(/^mcp__(.+?)__(.+)$/);
    return m ? m[1].replace(/^plugin_[^_]+_/, '').replace(/_/g, '-') + ' ' + m[2] : n;
  }
  function todoStatus(t) { return TODO[t && t.status !== undefined ? t.status : t] || 'resting'; }

  // Supervision (ADR 0001): an ungated agent carries a label. The server sets it on the session (providers/index.mjs
  // supervisionOf); the words come from the provider. This is the one place the page reads it.
  //   supervision(s)     the full label, '' for a gated agent. On the bot card, the desk terminal and the stats.
  //   supervisionHead(l) the words before the colon, for the one-line title bar of a desk monitor.
  //   supervisionLines(l) the whole label as one or two lines, split after the colon: the room sign and the desk screen.
  //   platform(s, kinds) the line under the bot's name: the label when it has one, else the agent kind (kindWord), else Claude Code.
  function supervision(s) { return s && typeof s.supervision === 'string' ? s.supervision : ''; }
  function supervisionHead(label) { return String(label || '').split(':')[0]; }
  function supervisionLines(label) {
    var t = String(label || ''), i = t.indexOf(': ');
    return !t ? [] : i < 0 ? [t] : [t.slice(0, i + 1), t.slice(i + 2)];
  }
  // A Paperclip run says so first, with its role: "Paperclip Engineer, Claude Code" (#76).
  function platform(s, kinds) {
    var base = supervision(s) || kindWord(s, kinds) || 'Claude Code';
    return s && s.hq && s.hq.role ? 'Paperclip ' + s.hq.role + ', ' + base : base;
  }

  // ---------- Paperclip HQ (#76): the words of its agents, budgets and schedules (paperclip.mjs view) ----------
  // An agent as a DS status: a run that is queued or runs is working, a failed run or an agent in error is error, else at rest.
  // A Paperclip approval (hire, strategy) is Paperclip's, not a request of the office, so it is never waiting.
  var HQ_FAILED = { failed: 1, error: 1, timed_out: 1 };
  function hqStatus(a) {
    var r = a && a.run, st = a && a.status;
    if (r && (r.status === 'running' || r.status === 'queued')) return { key: 'working', word: r.status === 'queued' ? 'Queued in Paperclip' : 'Runs in Paperclip' };
    if (st === 'error' || (r && HQ_FAILED[r.status])) return { key: 'error', word: 'Last run failed' };
    if (st === 'paused') return { key: 'resting', word: 'Paused in Paperclip' };
    if (st === 'pending_approval') return { key: 'resting', word: 'Waits for approval in Paperclip' };
    return { key: 'resting', word: 'Idle' };
  }
  function money(n) { var F = root.OfficeFormat; return F && F.money ? F.money(n) : '$' + (+n || 0).toFixed(2); }
  // A Paperclip budget: "$8.30 of $50.00 this month", or "$8.30 this month, no budget" (0 is no budget in Paperclip).
  function hqBudget(b) { if (!b) return ''; return b.limit > 0 ? money(b.spent) + ' of ' + money(b.limit) + ' this month' : money(b.spent) + ' this month, no budget'; }
  function hqEvery(sec) {
    var s = Math.max(0, Math.round(+sec || 0)), m = Math.round(s / 60);
    return s < 60 ? 'every ' + s + ' s' : m < 60 ? 'every ' + m + ' min' : m % 60 ? 'every ' + Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : 'every ' + (m / 60) + ' h';
  }
  // The supervision words of an agent: "Supervised in office", else the label (ADR 0001).
  function hqSupervision(a) { var x = a && a.supervision; return !x ? '' : x.state === 'supervised' ? 'Supervised in office' : x.label; }
  // The HQ connection as a line: what the office does now.
  function hqState(hq) {
    if (!hq) return 'Not connected';
    if (hq.state === 'on') return 'Watching ' + (hq.company ? hq.company.name : 'Paperclip') + ' at ' + hq.url;
    if (hq.state === 'choose') return 'Pick a company';
    if (hq.state === 'connecting') return 'Connecting to ' + hq.url;
    return 'Lost ' + hq.url + ': ' + (hq.error || 'no answer') + ' The office tries again.';
  }
  var hq = { status: hqStatus, budget: hqBudget, every: hqEvery, supervision: hqSupervision, state: hqState };

  // The room's numbers. list: the open sessions in the room. Waiting counts sessions, by isWaiting().
  // priced: sessions with a cost figure. unknown: sessions whose agent reports no cost (costUnknown), shown as "unknown".
  // supervision: the label of the least supervised agent in the room ('Unsupervised' before any other), '' when all are gated.
  function figures(list) {
    var o = { sessions: 0, working: 0, waiting: 0, toolCalls: 0, tokens: 0, cost: 0, priced: 0, unknown: 0, supervision: '', todosDone: 0, todosTotal: 0, lastEvent: 0 };
    (list || []).forEach(function (s) {
      var sup = supervision(s);
      if (sup && (!o.supervision || (sup.indexOf('Unsupervised') === 0 && o.supervision.indexOf('Unsupervised') !== 0))) o.supervision = sup;
      o.sessions++;
      var k = status(s).key;
      if (k === 'working') o.working++;
      if (k === 'waiting') o.waiting++;
      o.toolCalls += (s.calls || []).length;
      o.tokens += (s.usage && s.usage.tokens) || 0;
      if (s.costUnknown) o.unknown++;
      else if (typeof s.cost === 'number') { o.cost += s.cost; o.priced++; }
      (s.todos || []).forEach(function (t) { o.todosTotal++; if (t.status === 'completed') o.todosDone++; });
      if ((s.lastEvent || 0) > o.lastEvent) o.lastEvent = s.lastEvent;
    });
    return o;
  }

  // The text of a room sign that counts agents. An agent is a top-level session: the count comes from figures().sessions,
  // which never includes helpers (subagents sit in the parent's room as guests). A room with one agent or none says nothing.
  function agentsSign(n) { return n >= 2 ? n + ' agents' : ''; }

  function requests(s) {
    if (!s || s.status === 'ended') return [];
    var out = [];
    (s.pending || []).forEach(function (r, i) {
      out.push({ id: r.id, kind: 'permission', tool: r.tool, detail: r.detail || '', reason: oneLine(r.reason), text: 'Allow ' + r.tool + (r.detail ? ': ' + clip(r.detail, 160) : '') + '?', risk: r.risk, always: r.always || null, t: +r.t || 0, i: i });
    });
    (s.questions || []).forEach(function (q, i) {
      out.push({ id: q.id, kind: 'question', tool: 'office_ask', detail: '', reason: '', text: clip(q.text, 400), risk: undefined, always: null, t: +q.t || 0, i: 1000 + i });
    });
    out.sort(function (a, b) { return a.t - b.t || a.i - b.i; });
    return out.map(function (r) { delete r.i; return r; });
  }
  // How long the office holds a request for the user: 15 minutes in a session that runs in the office, 60 s in a terminal session
  // (server.mjs HEADLESS_ASK_MS and the terminal dialog). The approval paper shows the time left.
  function holdMs(s) { return s && s.headless ? 15 * 60 * 1000 : 60 * 1000; }
  function alwaysOffer(s) {
    return requests(s).filter(function (r) { return r.kind === 'permission' && r.always && r.risk !== 'high'; })[0] || null;
  }

  // ---------- the Security room grid (#70) ----------
  // Rows are action kinds (risk.mjs actionOf names the row of a tool call) and settings of the Agents screen; columns
  // are agent kinds. A cell is Ask, Allow or Deny (a toggle is Off or On). Every call cell is Ask by default, also the low
  // ones (read or edit inside the worktree): the office answers a request only when the user set the cell to Allow or Deny
  // (owner decision pending, #67; Claude Code asks about such calls by itself today). One exception, `defs`: the local model
  // keeps what it did before the Security room, its reads and edits inside the worktree run with no question (they never were
  // requests, providers/local.mjs). The two Secrets rows never offer Allow. The Agents rows are office-wide;
  // every other row can have a per-building override. A rule the row does not offer is never used.
  // free: the kind runs on a model of this machine and costs nothing (the Spend screen says Free).
  var SEC_COLUMNS = [{ id: 'claude-code', label: 'Claude Code' }, { id: 'hermes', label: 'Hermes' }, { id: 'dsh', label: 'dsh' },
    { id: 'openclaw', label: 'OpenClaw' }, { id: 'copilot', label: 'Copilot' }, { id: 'local', label: 'Local model', free: true }, { id: 'agent-framework', label: 'Agent Framework', free: true }, { id: 'cloud', label: 'Cloud agent' }];
  // The tables are looked up by names that come from requests and saved files, so they have no prototype: '__proto__' or
  // 'constructor' is no row, agent kind or word. Rule maps (rules.office, rules.buildings) are read by own keys only (own).
  function bare(o) { return Object.assign(Object.create(null), o); }
  function own(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  // The two Microsoft cloud kinds (#24) share one column, like the two local servers: the same rules hold for both.
  var SEC_KIND = bare({ 'claude-code': 'claude-code', ollama: 'local', lmstudio: 'local', hermes: 'hermes', dsh: 'dsh', openclaw: 'openclaw', 'agent-framework': 'agent-framework', copilot: 'copilot', foundry: 'cloud', 'copilot-studio': 'cloud' });
  // not: the kinds a row has no cell for. A cloud agent runs in the owner's cloud account and cannot reach the files on this
  // machine, so the file rows have no cell for it (no rule there could mean anything).
  var NO_FILES = { not: ['cloud'], na: { cloud: 'No files' } };
  var RULE = ['ask', 'allow', 'deny'], ASK_DENY = ['ask', 'deny'], TOGGLE = ['off', 'on'];
  var SEC_ROWS = bare({
    'read-inside': Object.assign({ label: 'Read inside the worktree', options: RULE, def: 'ask', defs: { local: 'allow' } }, NO_FILES),
    'edit-inside': Object.assign({ label: 'Edit inside the worktree', options: RULE, def: 'ask', defs: { local: 'allow' } }, NO_FILES),
    'files-outside': Object.assign({ label: 'Read or edit outside it', options: RULE, def: 'ask' }, NO_FILES),
    shell: { label: 'Shell commands', options: RULE, def: 'ask' },
    web: { label: 'Web and network', options: RULE, def: 'ask' },
    mcp: { label: 'MCP tools', options: RULE, def: 'ask' },
    settings: Object.assign({ label: 'Settings files that run code', options: ASK_DENY, def: 'ask' }, NO_FILES),
    secrets: Object.assign({ label: 'Secret files', options: ASK_DENY, def: 'ask' }, NO_FILES),
    // Agents screen. Ungated agents run tool calls without asking the office (ADR 0001): off until the user turns them on.
    // only: the kinds whose provider is gated: false (providers/acp.mjs AGENTS, the cloud kinds); the others ask the office, so "Gated".
    ungated: { label: 'Turn on ungated agents', options: TOGGLE, def: 'off', office: true, only: ['hermes', 'copilot', 'cloud'], na: 'Gated' },
    // Paperclip agents are not an agent kind: the Agents screen lists them by name in its Paperclip part, each with its own
    // Supervise in office (#76, public/security.js), so no cell stands for all of them.
    // An agent that reports no cost: Ask (the office asks once per session), Allow (it runs without asking), Deny (it never runs).
    // A cloud kind reports cost only from the prices the owner set (providers/cloud.mjs); without them it is such an agent.
    'no-cost': { label: 'Run without cost reports', options: RULE, def: 'ask', office: true, only: ['hermes', 'dsh', 'openclaw', 'copilot', 'cloud'], na: { 'claude-code': 'Reports cost', local: 'Free', 'agent-framework': 'Free' } }
  });
  var SEC_SCREENS = [
    { id: 'files', title: 'Files', rows: ['read-inside', 'edit-inside', 'files-outside'] },
    { id: 'commands', title: 'Commands', rows: ['shell'] },
    { id: 'network', title: 'Network', rows: ['web', 'mcp'] },
    { id: 'secrets', title: 'Secrets', rows: ['settings', 'secrets'] },
    { id: 'agents', title: 'Agents', rows: ['ungated', 'no-cost'] },
    { id: 'spend', title: 'Spend', rows: [] }
  ];
  var SEC_WORD = bare({ ask: 'Ask', allow: 'Allow', deny: 'Deny', off: 'Off', on: 'On' });
  function secKey(row, col) { return row + '|' + col; }
  function secApplies(row, col) { var r = SEC_ROWS[row]; return !!r && (!r.only || r.only.indexOf(col) >= 0) && !(r.not && r.not.indexOf(col) >= 0); }
  // The default of a cell: the row's, unless the row names another for that agent kind.
  function secDef(row, col) { var r = SEC_ROWS[row]; return r.defs && own(r.defs, col) ? r.defs[col] : r.def; }
  function secOk(row, v) { return SEC_ROWS[row].options.indexOf(v) >= 0; }
  // The rule of a cell and where it comes from: the building's override, the office-wide rule, or the default.
  function secLook(rules, building, row, col) {
    if (!secApplies(row, col)) return null;
    var r = SEC_ROWS[row], k = secKey(row, col), b = rules && building != null && own(rules.buildings, building) ? rules.buildings[building] : null;
    if (!r.office && own(b, k) && secOk(row, b[k])) return { value: b[k], source: 'building' };
    var o = rules && rules.office;
    if (own(o, k) && secOk(row, o[k])) return { value: o[k], source: 'office' };
    return { value: secDef(row, col), source: 'default' };
  }
  var security = {
    roomName: 'Security', screens: SEC_SCREENS, rows: SEC_ROWS, columns: SEC_COLUMNS, key: secKey, applies: secApplies, own: own,
    columnOf: function (kind) { return SEC_KIND[kind || 'claude-code'] || null; },
    options: function (row) { return SEC_ROWS[row] ? SEC_ROWS[row].options.slice() : []; },
    valueOf: function (rules, building, row, col) { var x = secLook(rules, building, row, col); return x ? x.value : null; },
    sourceOf: function (rules, building, row, col) { var x = secLook(rules, building, row, col); return x ? x.source : null; },
    defaultOf: secDef,
    next: function (row, v) {
      var o = SEC_ROWS[row].options, i = o.indexOf(v);
      return o[((i < 0 ? o.indexOf(SEC_ROWS[row].def) : i) + 1) % o.length];
    },
    loosens: function (row, from, to) { return from !== to && (to === 'allow' || to === 'on'); },
    na: function (row, col) { var n = SEC_ROWS[row] && SEC_ROWS[row].na; return secApplies(row, col) ? '' : (n && typeof n === 'object' ? n[col] || '' : n || ''); },
    word: function (v) { return SEC_WORD[v] || ''; }
  };

  // ---------- layers (ADR 0006, #145) ----------
  // Every surface shows one layer of detail and opens the next with one tap. Glance: a color and a mood, text only when
  // something needs the owner. Look: one sentence of intent, goal progress, cost so far. Inspect: chat, terminal, timeline,
  // diff, raw calls. Deep: the Security room, raw request text, logs. The facts live here; the page only reads them.
  var LAYER_ORDER = ['glance', 'look', 'inspect', 'deep'];
  function layerOpens(l) { var i = LAYER_ORDER.indexOf(l); return i >= 0 && i < LAYER_ORDER.length - 1 ? LAYER_ORDER[i + 1] : ''; }
  var LAYER_SURFACES = bare({
    city: { layer: 'glance' }, floor: { layer: 'glance' }, room: { layer: 'look' }, agent: { layer: 'look' },
    chat: { layer: 'inspect' }, terminal: { layer: 'inspect' }, changes: { layer: 'inspect' }, timeline: { layer: 'inspect' },
    security: { layer: 'deep' }, request: { layer: 'deep' }, logs: { layer: 'deep' }
  });
  Object.keys(LAYER_SURFACES).forEach(function (k) { LAYER_SURFACES[k].opens = layerOpens(LAYER_SURFACES[k].layer); });
  var MOOD = { error: 'Failed', waiting: 'Needs you', review: 'Needs you', working: 'Busy', finished: 'Calm', resting: 'Calm' };
  function mood(state) { var k = state || 'resting'; return { key: k, word: MOOD[k] || 'Calm' }; }
  // fig: figures() of a city building, floor or room; worst: its worst state. Text only on need: "2 need you", or "Failed".
  function glance(fig, worst) {
    var f = fig || {}, w = worst || (f.waiting > 0 ? 'waiting' : f.working > 0 ? 'working' : 'resting');
    var text = w === 'error' ? 'Failed' : w === 'waiting' && f.waiting > 0 ? f.waiting + (f.waiting === 1 ? ' needs you' : ' need you') : w === 'waiting' || w === 'review' ? 'Needs you' : '';
    return { state: w, mood: mood(w), text: text };
  }
  // The Look layer of one session: intent (one sentence), progress ("2 of 5 steps", '' with no plan) and cost so far.
  function look(s) {
    var t = (s && s.todos) || [], done = t.filter(function (x) { return x.status === 'completed'; }).length;
    var intent = oneLine(s && s.prompt) || taskLine(s || {});
    return { intent: clip(intent, 120), progress: t.length ? done + ' of ' + t.length + (t.length === 1 ? ' step' : ' steps') : '',
      cost: s && s.costUnknown ? 'unknown' : s && typeof s.cost === 'number' ? money(s.cost) : '' };
  }
  // The layer a place is used at most: mem is { place: { layer: count } }. A tie goes to the lower layer. A new place opens at Glance.
  function remember(mem, place, layer) {
    var m = Object.assign({}, mem || {});
    if (!place || LAYER_ORDER.indexOf(layer) < 0) return m;
    var c = Object.assign({}, own(m, place) ? m[place] : {});
    c[layer] = (c[layer] || 0) + 1;
    m[place] = c;
    return m;
  }
  function layerFor(mem, place) {
    var c = own(mem, place) ? mem[place] : null, best = 'glance', n = 0;
    LAYER_ORDER.forEach(function (l) { if (c && (c[l] || 0) > n) { n = c[l]; best = l; } });
    return best;
  }
  // The Look layer of a room: its agents together. Intent is the newest agent's; steps and cost are sums.
  function lookRoom(list) {
    var l = list || [], steps = 0, done = 0, cost = 0, unknown = false, newest = null;
    l.forEach(function (s) {
      var t = s.todos || [];
      steps += t.length; done += t.filter(function (x) { return x.status === 'completed'; }).length;
      if (s.costUnknown) unknown = true; else if (typeof s.cost === 'number') cost += s.cost;
      if (!newest || (s.lastEvent || 0) >= (newest.lastEvent || 0)) newest = s;
    });
    return { count: l.length, intent: newest ? look(newest).intent : '', progress: steps ? done + ' of ' + steps + (steps === 1 ? ' step' : ' steps') : '',
      cost: unknown ? 'unknown' : l.some(function (s) { return typeof s.cost === 'number'; }) ? money(cost) : '' };
  }
  // Remembered layers come back from storage text: only known layers with whole counts are kept.
  function parseMem(raw) {
    var out = {}, m;
    try { m = JSON.parse(raw); } catch (x) { return out; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
    Object.keys(m).forEach(function (p) {
      var c = m[p], k = {}, any = false;
      if (p === '__proto__' || !c || typeof c !== 'object') return;
      LAYER_ORDER.forEach(function (l) { if (own(c, l) && Number.isInteger(c[l]) && c[l] > 0) { k[l] = c[l]; any = true; } });
      if (any) out[p] = k;
    });
    return out;
  }
  // A place used at Inspect or Deep opens there on the first tap; Glance and Look show the Look card first.
  function opensAt(l) { return LAYER_ORDER.indexOf(l) >= LAYER_ORDER.indexOf('inspect'); }
  var layers = { lookRoom: lookRoom, parse: parseMem, opensAt: opensAt, order: LAYER_ORDER, opens: layerOpens, surfaces: LAYER_SURFACES, surface: function (id) { return own(LAYER_SURFACES, id) ? LAYER_SURFACES[id] : null; },
    mood: mood, glance: glance, look: look, remember: remember, layerFor: layerFor };

  function kindWord(s, kinds) {
    var id = s && s.provider;
    if (!id) return '';
    var k = (kinds || []).filter(function (x) { return x && x.kind === id; })[0];
    return (k && k.label) || String(id);
  }
  function kindsWord(list, kinds) {
    var ids = [];
    (list || []).forEach(function (s) { var id = s && s.provider; if (id && ids.indexOf(id) < 0) ids.push(id); });
    var order = (kinds || []).map(function (k) { return k && k.kind; });
    ids.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
    });
    return ids.map(function (id) { return kindWord({ provider: id }, kinds); }).join(', ');
  }

  function kindState(k) {
    if (!k || k.checking) return { key: 'resting', word: 'Checking' };
    if (k.ready) return { key: 'finished', word: 'Ready' };
    return k.configured === false ? { key: 'resting', word: 'Not configured' } : { key: 'waiting', word: 'Not ready' };
  }
  function notConfigured(k) { return !!(k && !k.checking && !k.ready && k.configured === false); }
  function needsTitle(k) { return k.label + (k.configured === false ? ' is not configured' : ' is not ready'); }
  function modelLabel(k) { return (k && k.modelLabel) || 'Model'; }
  // The thing the pick chooses, in lower case: 'agent' for 'Foundry agent', 'model' for the rest.
  function modelNoun(k) { return modelLabel(k).split(' ').pop().toLowerCase(); }
  function pickFact(k) { return k && k.needsModel ? 'You pick the ' + (k.modelLabel || 'model') : null; }
  function modelChoices(k, fallback) {
    var ms = (k && k.models) || [];
    if (!k || (!ms.length && !k.needsModel)) return fallback || [{ value: '', label: 'Default' }];
    var opts = ms.map(function (m) { return { value: m.id, label: m.label || m.id }; });
    if (!k.needsModel) return [{ value: '', label: 'Default' }].concat(opts);
    return opts.length ? opts : [{ value: '', label: (k.checking ? 'Looking for ' : 'No ') + modelNoun(k) + 's' }];
  }
  // One list per kind: the kind's own models, or for Claude Code before its first answer the page's fallback list.
  function modelList(k, fallback) {
    var own = (k && k.models) || [];
    if (own.length) return own.map(function (m) { return { value: m.id, label: m.label || m.id }; });
    return !k || k.kind === 'claude-code' ? (fallback || []).filter(function (o) { return o.value; }) : [];
  }
  // The dock's model switch: the models of the session's own kind, no Default, and the session's own model when no list knows it.
  function modelSwitch(k, current, fallback) {
    var opts = modelList(k, fallback);
    if (current && !opts.some(function (o) { return o.value === current; })) opts.unshift({ value: current, label: current });
    return opts;
  }
  // The word for a model id: its label in the kind's list (the id may be longer, a dated name), else the id itself.
  function modelWord(k, m, fallback) {
    if (!m) return 'Default model';
    var list = modelList(k, fallback);
    var hit = list.filter(function (o) { return m.indexOf(o.value) === 0; })[0] || list.filter(function (o) { return m.toLowerCase().indexOf(String(o.label).toLowerCase()) >= 0; })[0];
    return hit ? hit.label : m;
  }
  function firstModel(k) { return k && k.needsModel && k.models && k.models.length ? k.models[0].id : ''; }
  function noModelFor(k) { return !!(k && k.needsModel && !(k.models || []).length); }
  function withKind(form, k, id) {
    var modes = (k && k.modes) || [];
    return Object.assign({}, form, { provider: id, model: firstModel(k),
      where: k && !k.terminal ? 'office' : form.where,
      permissionMode: k && form.permissionMode && modes.indexOf(form.permissionMode) < 0 ? '' : form.permissionMode });
  }
  function kindNote(k, terminal) {
    var label = (k && k.label) || 'Claude Code';
    if (terminal) return 'Starts ' + label + ' in a new terminal window with the office hooks attached.';
    if (k && k.team) return 'Runs a team of ' + label + ' agents on a model on this machine, inside the office. The team comes from agent-team.json in the folder, '
      + 'or it is a lead, a coder and a reviewer. A member shows as a helper bot while it has the work. Each tool call comes to you for approval, until you set a rule in the Security room. It costs nothing.';
    if (k && k.cloud) return 'Runs ' + label + ' in your Microsoft cloud account. You talk to it in the chat. Its tools run in the cloud with no approval here: you see them, but the office does not hold them. Only a request the service sends for approval comes to you. Each message can cost money. It cannot read the folder: the folder only sets its desk. The office never signs in for you.';
    if (k && !k.paid) return 'Runs a model from ' + label + ' on this machine, inside the office. It reads and changes files in the folder and runs commands. Risky steps come to you for approval. It costs nothing.';
    return 'Runs ' + label + ' inside the office. You talk to it in the chat and approve its steps here. It has no terminal window.';
  }

  // The spend limit field of the Open dialog: a paid kind that reports cost (#33, Q22). A kind with cost 'unknown' has no
  // limit (providers/index.mjs spendLimitFor gives null: nothing could stop it), so its form says why instead (review M2).
  // A cloud kind (#24) reports cost only when the owner set its prices (providers/cloud.mjs): without them it is 'unknown'.
  function limitShown(k) { return !k || (k.paid !== false && k.cost !== 'unknown'); }
  function costNote(k) {
    if (!(k && k.paid !== false && k.cost === 'unknown')) return '';
    var label = k.label || 'This agent';
    if (k.cloud) return label + ' reports no dollars, and no prices are set, so the office shows its cost as unknown and no spend limit can stop it. Set the prices to count it (see the README), or check the spend in your Azure account.';
    return label + ' does not report cost, so the office shows it as unknown and no spend limit can stop it. Check the spend in its own account.';
  }

  // The folder of a change (#93, spec #88): where it sits in the scene (place), the mark on it (mark) and a DS icon (glyph), so a state
  // shows by shape and position, never by color alone. word: the state in plain words. Unknown is a grey folder, "PR state unknown".
  var FOLDER = {
    draft: { word: 'Draft', place: 'desk', mark: 'open', glyph: 'pull-request' },
    open: { word: 'Open', place: 'outbox', mark: 'tab', glyph: 'pull-request' },
    checks: { word: 'Checks running', place: 'outbox', mark: 'checklist', glyph: 'pull-request' },
    review: { word: 'In review', place: 'inbox', mark: 'handoff', glyph: 'pull-request' },
    changes: { word: 'Changes requested', place: 'inbox', mark: 'note', glyph: 'pull-request' },
    approved: { word: 'Approved', place: 'inbox', mark: 'stamp', glyph: 'pull-request' },
    conflict: { word: 'Conflict', place: 'outbox', mark: 'tab', glyph: 'conflict' },
    ready: { word: 'Ready to merge', place: 'ready-tray', mark: 'stamp', glyph: 'merge' },
    merged: { word: 'Merged', place: 'cabinet', mark: 'filed', glyph: 'merge' },
    closed: { word: 'Closed', place: 'archive', mark: 'box', glyph: 'branch' },
    unknown: { word: 'PR state unknown', place: 'desk', mark: 'grey', glyph: 'pull-request' }
  };
  function folderOf(state) { var f = FOLDER[state] || FOLDER.unknown; return { word: f.word, place: f.place, mark: f.mark, glyph: f.glyph }; }
  root.OfficeVocab = { stateWord: stateWord, laneOf: laneOf, limitShown: limitShown, costNote: costNote, kindWord: kindWord, kindsWord: kindsWord, kindState: kindState, notConfigured: notConfigured, needsTitle: needsTitle, modelLabel: modelLabel, modelNoun: modelNoun, pickFact: pickFact, modelChoices: modelChoices, modelSwitch: modelSwitch, modelWord: modelWord, firstModel: firstModel, noModelFor: noModelFor, withKind: withKind, kindNote: kindNote, requests: requests, alwaysOffer: alwaysOffer, featuresOf: featuresOf, hasFeature: hasFeature, status: status, isWaiting: isWaiting, taskLine: taskLine, toolKind: toolKind, toolShort: toolShort, toolArg: toolArg, todoStatus: todoStatus, figures: figures, agentsSign: agentsSign, security: security, supervision: supervision, supervisionHead: supervisionHead, supervisionLines: supervisionLines, platform: platform, hq: hq, plan: plan, layers: layers, holdMs: holdMs, folderOf: folderOf };
})(typeof globalThis !== 'undefined' ? globalThis : window);
