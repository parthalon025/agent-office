/* Agent Office for Claude Code x0.2: session vocabulary.
   One home for the words and rules that every surface shares: the status key and word of a session, its task
   line, the kind and short name of a tool, the status of a to-do, and the figures of a room.
   Plain script, no I/O, no timers. The page loads it as a script (window.OfficeVocab). The server and the tests
   import it for its side effect and read globalThis.OfficeVocab.

   One global, OfficeVocab, in four files (#186). This file is the core and loads first. The topic files add their own
   names to the global: vocab-security.js adds security; vocab-layers.js adds layers; vocab-persona.js adds persona,
   wall and rituals. They read the core names they share (own, bare, has, count, clip, oneLine, money) through its
   unlisted `shared` property. The server and the tests load all four through src/vocab.mjs.
   These words live only here. Do not write a second copy of a status word, a task line, a tool name or kind, a to-do
   status or a room figure in building.js, adapter.js, office.js, terminal.js, board.js or server.mjs. The server
   computes the room figures once per snapshot (snapshot.figures, keyed by notes key); the page reads them with
   mount.figures(roomId). figures() also gives `supervision`: the label of the least supervised agent in the room.
   "Always allow" and the risk of a request come from alwaysOffer and requests below. A question has no risk and no
   rule. A high-risk request never offers Always allow.

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
     agentsSign(n)    -> "N agents" for a room shared by 2 or more agents (top-level sessions; helpers do not count), else ''.
                         board.js paints it on the door sign.
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
   (src/providers/index.mjs describe) with its providers read: { checking, ready, models, needs, ... }.
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
                         ("Supervised in office" or the label), state(snap.hq) (the connection as a line), desk(s) (#206: the rows of a Paperclip run's context, [] for another session),
                         kindSupervision(kind) ("Supervised" for a gated office agent kind, else its label: the hire's Confirm and the HR desk), hire (the HR desk words).
                         The HQ building in the scene (#226): memo(snap.hq) (the reception memo), taskBoard(snap.hq) (the open tasks by
                         state on the Reception's back wall) and lobbyVerbs (the hints of the Lobby's objects: the HR desk hires).
     layers           -> the four layers of detail (ADR 0006): glance (is all fine), look (what is it doing, how is it going), inspect (exactly
                         what happened), deep (proof and rules). order, opens(layer) (the next layer, '' at deep), surfaces (each surface's
                         layer and the layer it opens), surface(id), mood(state) ({ key, word } of a worst state: calm, busy, needs you, failed),
                         glance(fig, worst) ({ state, mood, text }: text only when something needs the owner, else ''), look(s) ({ intent, progress,
                         cost }: one sentence, "2 of 5 steps" and the cost so far), remember(mem, place, layer) and layerFor(mem, place) (the layer
                         a place is used at most; Glance for a new place). No page code invents a detail rule.
     platform(s, kinds) -> the bot card line: the supervision label or the kind word, after "Paperclip <role>, " for a Paperclip run.
     limitShown(k)    -> true when the Open dialog shows the spend limit field: only for a paid kind that reports cost.
     costNote(k)      -> what the form says instead for a kind whose cost is unknown.
   The supervision words (supervision(s), supervisionHead(label) for a desk monitor title bar, supervisionLines(label) for
   the door sign and the desk screen) are defined with their notes below. The Security room grid is in vocab-security.js:
   its tables have no prototype, and rule maps are read by own keys only (own), so __proto__ or constructor is never a row,
   an agent kind or a rule.
*/
(function (root) {
  'use strict';
  var KIND = { code_interpreter: 'terminal', file_search: 'search', bing_grounding: 'search', Knowledge: 'search', Connector: 'mcp', Topic: 'flow', Bash: 'terminal', PowerShell: 'terminal', WebFetch: 'browser', WebSearch: 'search', Grep: 'search', Glob: 'search', Read: 'code', Edit: 'code', Write: 'code', MultiEdit: 'code', NotebookEdit: 'code', Task: 'flow', Agent: 'flow', Skill: 'skill', TodoWrite: 'memory' };
  var ARG = { Bash: 'command', PowerShell: 'command', Read: 'file', Edit: 'file', Write: 'file', MultiEdit: 'file', NotebookEdit: 'file', Grep: 'pattern', Glob: 'pattern', WebFetch: 'url', WebSearch: 'query', Task: 'task', Agent: 'task', Skill: 'skill' };
  var TODO = { pending: 'resting', in_progress: 'working', completed: 'finished', error: 'error' };

  function count(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function has(a) { return !!(a && a.length); }
  function oneLine(t) { return clip(String(t == null ? '' : t).replace(/\s+/g, ' ').trim(), 300); }

  // What an agent kind has beyond the seam (#72), in the order the page shows it. A provider declares the keys (src/providers/index.mjs
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
  var HANDOFF_FROM = ['awaiting-approval', 'blocked', 'stopped', 'handoff-failed']; // the goal states that run nothing (manager.mjs handoff)
  var plan = {
    // The goal handoff (#159, ADR 0007): the words around the painted Confirm, the failed state and the link to Paperclip.
    handoffRows: function (tasks, written) {
      return (Array.isArray(tasks) ? tasks : []).map(function (t) { return { step: t.step, title: t.title, description: t.description || '', written: !!(written && written[t.step]) }; });
    },
    handoffFailed: function (h) { return 'Handoff failed. ' + count(h.written, 'task is', 'tasks are') + ' in ' + h.company + '. ' + count(h.left, 'task is', 'tasks are') + ' left. Retry writes only the rest.'; },
    handoffDone: function (h) { return count(h.written, 'task is', 'tasks are') + ' in ' + h.company + '. Paperclip plans this work now. The office does not run it.'; },
    sourceWord: function (kind) { return PLAN_SOURCE[kind] || ''; },
    stepState: function (state) { return PLAN_STEP[state] ? state : 'pending'; },
    stepWord: function (state) { return PLAN_STEP[state] || PLAN_STEP.pending; },
    notConnected: 'Not connected',
    notConnectedReason: function (why) { return 'Not connected.' + (why ? ' ' + why : '') + ' The steps are the last ones read.'; },
    // The state of an office goal (manager.mjs status). A Paperclip plan has none of its own: its steps carry the state.
    goalWord: function (status) { return status === 'not-connected' ? 'Not connected' : GOAL_WORD[status] || ''; },
    // A goal that came from a Paperclip task a Manager employee took (#204), and the words of hiring a Manager there.
    fromTask: function (t) { return t && (t.identifier || t.title) ? 'From the Paperclip task ' + [t.identifier, t.title].filter(Boolean).join(' ') : ''; },
    // The Manager is hired like every employee (the one hire of #201): a monthly budget is required, and the Confirm names it.
    hireManager: { title: 'Hire the Manager in Paperclip', button: 'Hire Manager', confirm: 'Confirm hire', building: 'Building', has: 'Manager in Paperclip: ', none: 'No Manager works in Paperclip for this building yet.', done: 'Manager hired in Paperclip',
      name: 'Name (optional)', budget: 'Monthly budget in dollars', budgetStart: '20', needBudget: 'Set a monthly budget above zero. The office does not hire without one.',
      pending: 'Paperclip waits for the board to approve the hire.',
      intro: function (building) { return 'The Manager of ' + building + ' becomes a Paperclip employee with the Project manager role. It runs through the office adapter, so the Security room decides its calls. Like every hire, it has a monthly budget.'; },
      budgetOk: function (v) { var t = String(v == null ? '' : v).trim(), n = Number(t); return t !== '' && isFinite(n) && n > 0; } },
    readOnlyNote: function (kind) { return kind === 'paperclip' ? 'Read only. Paperclip plans this work.' : ''; },
    unreadable: function (word) { return 'The ' + word + ' plan could not be read. It is not shown.'; },
    // One view of the snapshot's plans field (the Manager panel, the room wall, Ctrl+K). building: only that building's goals.
    board: function (snap, building) {
      var plans = (snap && snap.plans) || [], un = (snap && snap.unreadable) || [];
      var groups = plans.filter(function (p) { return !building || p.building === building; }).map(function (p) {
        var steps = p.steps || [], note = p.frozen ? p.reason : (p.source === 'paperclip' ? plan.readOnlyNote(p.source) : (p.reason || ''));
        var ho = p.handoff && typeof p.handoff === 'object' ? p.handoff : null, written = ho && ho.tasks ? Object.keys(ho.tasks).length : 0;
        var handoff = ho ? { company: String(ho.company || ''), tasks: ho.tasks || {}, written: written, left: Math.max(0, steps.length - written), failed: p.status === 'handoff-failed', done: p.status === 'handed-off' } : null;
        return { id: p.id, building: p.building, source: p.source, sourceWord: p.sourceWord, fromTask: plan.fromTask(p.task), goal: p.goal, readOnly: p.source === 'paperclip', frozen: !!p.frozen, status: p.status,
          handoff: handoff, handoffable: p.source === 'office' && HANDOFF_FROM.indexOf(p.status) >= 0 && steps.length > 0 && !steps.some(function (x) { return x.state === 'working'; }),
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

  // Supervision (ADR 0001): an ungated agent carries a label. The server sets it on the session (src/providers/index.mjs
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
  // The context window of a session (#164): the percent of it in use when the agent reported both the tokens and the window
  // (tracker.mjs, a usage line with ctx, or Claude Code's own numbers); otherwise the word "unknown", never a guessed number.
  function context(s) {
    var u = s && Number(s.ctxTokens), w = s && Number(s.ctxWindow);
    if (!s || s.ctxTokens == null || s.ctxWindow == null || !(u >= 0) || !(w > 0)) return { pct: null, word: 'unknown' };
    var pct = Math.min(100, Math.round(100 * u / w));
    return { pct: pct, word: pct + '%' };
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
  // The supervision of an office agent kind (snap.kinds, providers/index.mjs describe), as the HR desk and the hire's Confirm say it: an employee
  // on the office adapter runs as sessions of that kind, so it is "Supervised" for a gated kind, else the kind's own label (ADR 0001). The server
  // reads it too (office.mjs, the hire summary). '' for no kind.
  function hqKindSupervision(k) { return !k ? '' : k.gated !== false ? 'Supervised' : (k.supervision || 'Unsupervised'); }
  // The HR desk (#201): each agent kind with its supervision, the line under the pick, and the opt-in first task (off by default).
  var hqHire = {
    kindOption: function (k) { return { value: k.kind, label: k.label + ' (' + hqKindSupervision(k) + ')' }; },
    kindNote: function (k) {
      if (!k) return '';
      if (k.gated !== false) return 'The new employee runs through the office adapter as ' + k.label + ' sessions, so the Security room decides every call.';
      return 'The new employee runs through the office adapter as ' + k.label + ' sessions. ' + hqKindSupervision(k) + ': the office cannot hold every call of this kind. It stays off until you turn it on in the Security room (Agents screen), and it runs only in a room of its own.';
    },
    welcomeOptions: [{ value: 'no', label: 'No first task' }, { value: 'yes', label: 'Send a first task: a stand-up note' }],
    welcomeNote: 'The first task starts a run of the new employee: Paperclip wakes it on the task. The Tasks cell of the write grid decides the task on its own.',
    taskConfirm: 'Send first task',
    taskSkip: 'Do not send',
  };
  // The HQ connection as a line: what the office does now.
  function hqState(hq) {
    if (!hq) return 'Not connected';
    if (hq.state === 'on') return 'Watching ' + (hq.company ? hq.company.name : 'Paperclip') + ' at ' + hq.url;
    if (hq.state === 'choose') return 'Pick a company';
    if (hq.state === 'connecting') return 'Connecting to ' + hq.url;
    return 'Lost ' + hq.url + ': ' + (hq.error || 'no answer') + ' The office tries again.';
  }
  // The Paperclip the office runs itself (#193, paperclip-runtime.mjs status): its state as a DS status and a word, and the board key's line.
  var RUNTIME = { off: ['resting', 'Not installed'], installing: ['working', 'Installing'], updating: ['working', 'Updating'], stopped: ['resting', 'Stopped'], starting: ['working', 'Starting'],
    running: ['working', 'Running'], failed: ['error', 'Failed'], external: ['resting', 'Another Paperclip runs'], busy: ['error', 'Port in use'], connected: ['working', 'Connected to your Paperclip'] };
  function runtimeState(rt) {
    if (!rt) return null;
    var x = Object.prototype.hasOwnProperty.call(RUNTIME, rt.state) ? RUNTIME[rt.state] : ['resting', String(rt.state)];
    return { key: x[0], word: x[1] };
  }
  function runtimeKey(rt) {
    var k = rt && rt.key;
    if (!k) return '';
    if (k.state === 'ready') return k.expiresAt ? 'Board key ready, valid until ' + String(k.expiresAt).slice(0, 10) : 'Board key ready';
    if (k.state === 'waiting') return 'Waiting for your approval in Paperclip';
    if (k.state === 'expired' || k.state === 'refused') return k.reason || 'No board key';
    return 'No board key yet';
  }
  // The Lobby of the HQ building (#197, paperclip.mjs view().lobby): the Glance line (the city card, the building sign) and the dashboard
  // cards. null in the data is unknown, said so: the office never shows a zero it did not read.
  // The office adapter line of the HQ (#222): the state the server read (installed, off, missing, unknown) as one line and the Install action's words.
  function hqAdapter(a) {
    var st = a && a.state, why = a && a.why ? a.why : '';
    if (st === 'installed') return { line: 'Office adapter: installed', ok: true, install: false, why: '' };
    if (st === 'off') return { line: 'Office adapter: switched off in Paperclip', ok: false, install: false, why: why };
    if (st === 'missing') return { line: 'Office adapter: not installed', ok: false, install: true, why: why };
    return { line: 'Office adapter: unknown', ok: false, install: false, why: why || 'The office has not read the adapter list of Paperclip yet.' };
  }
  function hqPlural(n, one) { return n + ' ' + (n === 1 ? one : one + 's'); }
  function hqGlance(q) {
    var l = q && q.lobby;
    if (!l) return '';
    var out = ['Lobby: ' + hqPlural(l.employees.total, 'employee')];
    out.push(l.tasks ? hqPlural(l.tasks.open, 'open task') : 'tasks unknown');
    if (!l.approvals) out.push('approvals unknown');
    else if (l.approvals.pending) out.push(hqPlural(l.approvals.pending, 'approval') + (l.approvals.pending === 1 ? ' waits' : ' wait'));
    if (l.spend) out.push(hqBudget(l.spend));
    return out.join(' · ');
  }
  // The HQ building in the scene (#226): the reception memo of its Lobby (the company, the Lobby counts, what a click does) and the task
  // board on the Reception's back wall (the open tasks by state). null in the data is unknown, said so.
  function hqMemo(q) {
    if (!q || !q.company) return { title: 'Paperclip HQ', lines: ['Paperclip is not connected.', 'Click the memo to open the HQ and connect it.'] };
    // four lines at most, as the memo of an office building: the rest is in the HQ
    var l = q.lobby, lines = [hqPlural((q.agents || []).length, 'employee') + (l ? ' · ' + (l.tasks ? hqPlural(l.tasks.open, 'open task') : 'tasks unknown') : '')];
    if (l) {
      lines.push(!l.approvals ? 'Approvals unknown' : l.approvals.pending ? hqPlural(l.approvals.pending, 'approval') + (l.approvals.pending === 1 ? ' waits for you' : ' wait for you') : 'No approval waits');
      if (l.spend) lines.push(hqBudget(l.spend));
    }
    return { title: q.company.name, lines: lines.concat(['Click the memo for the HQ.']) };
  }
  var HQ_TASK_ROWS = [['backlog', 'Backlog'], ['todo', 'To do'], ['inProgress', 'In progress'], ['inReview', 'In review'], ['blocked', 'Blocked']];
  function hqTaskBoard(q) {
    var t = q && q.lobby && q.lobby.tasks;
    return { title: 'Tasks', rows: HQ_TASK_ROWS.map(function (r) { var n = t ? +t[r[0]] || 0 : 0; return { id: r[0], name: r[1], count: n, text: t ? String(n) : 'No data' }; }),
      foot: t ? hqPlural(t.open, 'open task') : 'The office could not read the tasks' };
  }
  function hqCards(l) {
    var U = 'Unknown', e = l.employees;
    var emp = [e.working + ' working', e.unsupervised ? e.unsupervised + ' not supervised in office' : 'all supervised in office'];
    if (e.paused) emp.push(e.paused + ' paused');
    if (e.error) emp.push(e.error + ' in error');
    return [
      { key: 'employees', label: 'Employees', value: String(e.total), note: emp.join(' · ') },
      { key: 'tasks', label: 'Open tasks', value: l.tasks ? String(l.tasks.open) : U, note: l.tasks ? l.tasks.inProgress + ' in progress · ' + l.tasks.blocked + ' blocked' : 'The office could not read the tasks' },
      { key: 'approvals', label: 'Approvals', value: l.approvals ? String(l.approvals.pending) : U, note: l.approvals ? (l.approvals.pending ? 'Decide them here' : 'None wait') : 'The office could not read the approvals' },
      { key: 'goals', label: 'Goals', value: l.goals ? String(l.goals.total) : U, note: l.goals ? '' : 'The office could not read the goals' },
      { key: 'spend', label: 'Spend this month', value: l.spend ? money(l.spend.spent) : U, note: !l.spend ? 'The office could not read the costs' : l.spend.percent != null ? l.spend.percent + '% of ' + money(l.spend.limit) : 'No budget' }
    ];
  }
  // Ctrl+K searches Paperclip (#214, hq-model.mjs searchOf: snap.hq.search). Each entry is a palette action that opens the HQ at it (ref).
  var SEARCH_KINDS = { employee: ['employee', 'bot'], floor: ['floor', 'floor'], task: ['task', 'plan'], goal: ['goal', 'plan'], approval: ['approval', 'approve'], routine: ['routine', 'schedule'] };
  function hqSearchItems(q) {
    if (!q || !q.search) return [];
    return q.search.filter(function (x) { return SEARCH_KINDS[x.kind]; }).map(function (x) {
      var k = SEARCH_KINDS[x.kind], co = q.company && q.company.name ? ', ' + q.company.name : '';
      return { id: 'hq-' + x.kind + '-' + x.id, label: x.label + ' (' + k[0] + co + ')', hint: x.hint, icon: k[1], group: 'Paperclip', keywords: 'paperclip hq ' + k[0] + ' ' + x.label + (x.hint ? ' ' + x.hint : ''), ref: { kind: x.kind, id: x.id } };
    });
  }
  // The HQ in the phone list (#215): each employee with its status, its task line and its supervision, and what needs the user
  // here (each employee whose last run failed). The approvals and tasks that wait for the user are in the one queue (#210, Needs you above).
  function hqPhone(q) {
    var l = q && q.lobby, ags = (q && q.agents) || [], ap = l && l.approvals;
    var employees = ags.map(function (a) {
      var st = hqStatus(a);
      return { id: a.id, name: a.name, title: a.title || a.role || '', mood: st, line: a.task ? (a.task.identifier ? a.task.identifier + ' ' : '') + a.task.title : 'No open task', supervision: hqSupervision(a) };
    });
    var needs = [];
    employees.forEach(function (e) { if (e.mood.key === 'error') needs.push({ key: 'error:' + e.id, text: e.name + ': ' + e.mood.word }); });
    return { employees: employees, needs: needs, approvalsUnknown: !!l && !ap };
  }
  // The run context on the employee desk (#206): label and value rows of what Paperclip handed the office with the run (s.deskCtx:
  // paperclip-runs.mjs deskOf), plus the context window in use (the session's own numbers). [] for a session that is not such a run.
  function hqDesk(s) {
    var d = s && s.deskCtx;
    if (!d) return [];
    var file = d.instructions && d.instructions.file ? String(d.instructions.file).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
    var rows = [];
    if (d.wake) rows.push(['Wake reason', String(d.wake).replace(/_/g, ' ')]);
    rows.push(['Session', d.resumed ? 'Resumed' : 'Fresh.' + (d.fresh ? ' ' + d.fresh : '')]);
    rows.push(['Instructions', file || (d.instructions && d.instructions.key ? 'bundle ' + d.instructions.key : 'not reported')]);
    rows.push(['Skills', d.skills && d.skills.length ? d.skills.join(', ') : 'none reported']);
    rows.push(['Context used', context(s).word]);
    return rows;
  }
  // The org chart editor (#202): the floors of the HQ, top floor first, an employee a row with its manager and the managers it may take. A
  // manager below the employee is left out (it would make a loop). write is false when the HQ write grid denies reporting lines (#198): the rows then read only.
  function hqOrg(q) {
    var agents = (q && q.agents) || [], by = {}, write = !!(q && q.reportingWrite);
    agents.forEach(function (a) { by[a.id] = a; });
    function below(a, id) {   // does a report to id, directly or through others
      for (var cur = a, n = 0; cur && cur.reportsTo && n <= agents.length; n++) { if (cur.reportsTo === id) return true; cur = by[cur.reportsTo]; }
      return false;
    }
    var floors = ((q && q.floors) || []).filter(function (f) { return f.employees.length; }).slice().reverse().map(function (f) {
      return { key: f.key, name: f.name, rows: f.employees.map(function (e) {
        var m = e.reportsTo && by[e.reportsTo];
        return { id: e.id, name: e.name, role: e.role, managerId: m ? m.id : '', manager: m ? m.name : '',
          line: m ? 'Reports to ' + m.name : 'No manager',
          options: [{ value: '', label: 'No manager' }].concat(agents.filter(function (a) { return a.id !== e.id && !below(a, e.id); }).map(function (a) { return { value: a.id, label: a.name }; })) };
      }) };
    });
    return { floors: floors, write: write, note: write ? 'Pick a manager to change a reporting line.' : 'Read only. The HQ write grid denies reporting line changes. Allow them in the write grid to edit.' };
  }
  // The goals of the executive floor (#207): the goal tree as rows (depth, state word, one line of level, owner and children), the option lists of the
  // forms, and whether the HQ write grid lets the page write (goalWrite: not Deny). A goal not read is unknown, never an empty list.
  var GOAL_STATUS = [['planned', 'Planned', 'idle'], ['active', 'Active', 'working'], ['achieved', 'Achieved', 'finished'], ['cancelled', 'Cancelled', 'resting']];
  var GOAL_LEVEL = { company: 'Company goal', team: 'Team goal', agent: 'Agent goal', task: 'Task goal' };
  function hqGoals(q) {
    var write = !!(q && q.goalWrite), g = q && q.goals, agents = (q && q.agents) || [];
    var rows = ((g && g.rows) || []).map(function (r) {
      var st = GOAL_STATUS.filter(function (x) { return x[0] === r.status; })[0];
      var bits = [];
      if (GOAL_LEVEL[r.level]) bits.push(GOAL_LEVEL[r.level]);
      bits.push(r.owner ? 'Owner ' + r.owner : r.ownerId ? 'Owner not in the company' : 'No owner');
      if (r.children) bits.push(r.children + (r.children === 1 ? ' goal' : ' goals') + ' under it');
      return { id: r.id, title: r.title, depth: r.depth, description: r.description || '', level: r.level, status: { key: st ? st[2] : 'idle', word: st ? st[1] : (r.status || 'Unknown'), value: r.status }, ownerId: r.ownerId || '', parentId: r.parentId || '',
        line: bits.join(' · ') };
    });
    return {
      unknown: !g, write: write, rows: rows,
      note: write ? 'Goals are Paperclip\'s. A change here goes to Paperclip after you confirm it.' : 'Read only. The HQ write grid denies goal changes. Allow them in the write grid to edit.',
      statusOptions: GOAL_STATUS.map(function (x) { return { value: x[0], label: x[1] }; }),
      levelOptions: [{ value: '', label: 'No level' }].concat(Object.keys(GOAL_LEVEL).map(function (k) { return { value: k, label: GOAL_LEVEL[k].replace(' goal', '') }; })),
      ownerOptions: [{ value: '', label: 'No owner' }].concat(agents.map(function (a) { return { value: a.id, label: a.name }; })),
      parentOptions: function () { return [{ value: '', label: 'No parent goal' }].concat(rows.map(function (r) { return { value: r.id, label: r.title }; })); },
    };
  }
  // Routines (#209). routineFacts: the line under a routine. routineForm: the edit form of a routine (null: a new one). routineCalls: the
  // hqWrite bodies a saved form needs, only for what changed (update for title, text, employee or state; schedule for the cron line).
  var routineStates = [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'archived', label: 'Archived' }];
  function routineFacts(r) {
    return [r.agent ? 'For ' + r.agent : 'No employee', r.cron ? 'Cron ' + r.cron : 'No schedule', r.next ? 'Next ' + new Date(r.next).toLocaleString() : 'No next run'].join(' · ');
  }
  function routineForm(r) {
    var t = r && r.trigger;
    return { id: r ? r.id : null, title: r ? r.title : '', description: '', agent: r ? r.agentId || '' : '', status: r && r.status ? r.status : 'active', cron: t ? t.cron : '', timezone: t ? t.timezone : '', trigger: t ? t.id : '' };
  }
  function routineCalls(f, r) {
    var title = String(f.title || '').trim(), desc = String(f.description || '').trim();
    if (!f.id) {
      var c = { kind: 'routine', action: 'create', title: title };
      if (desc) c.description = desc;
      if (f.agent) c.agent = f.agent;
      return [c];
    }
    var u = { kind: 'routine', action: 'update', routine: f.id }, calls = [];
    if (r && title !== r.title) u.title = title;
    if (desc) u.description = desc;
    if (r && (f.agent || '') !== (r.agentId || '')) u.agent = f.agent || null;
    if (r && f.status !== r.status) u.status = f.status;
    if (Object.keys(u).length > 3) calls.push(u);
    var cron = String(f.cron || '').trim();
    if (f.trigger && r && r.trigger && cron && cron !== r.trigger.cron) calls.push({ kind: 'routine', action: 'schedule', routine: f.id, trigger: f.trigger, cron: cron });
    return calls;
  }
  function routineDone(c) { return c.action === 'create' ? 'Routine created' : c.action === 'schedule' ? 'Schedule changed' : 'Routine changed'; }
  // One Paperclip approval decision (#225). The page sends this body through hq.write. The Approvals cell asks first.
  // action is approve, reject or revise. The id is the plain approval id (the server gives it only when it is a plain id, hq-model.mjs inboxOf), never the queue id. A note is optional.
  // null: the page must not send (a bad id or an unknown action).
  var APPROVAL_ACT = { approve: 'Approve', reject: 'Reject', revise: 'Request revision' };
  var APPROVAL_DONE = { approve: 'Approved', reject: 'Approval rejected', revise: 'Revision requested' };
  function approvalBody(id, action, note) {
    if (!Object.prototype.hasOwnProperty.call(APPROVAL_ACT, action) || typeof id !== 'string' || !id) return null;
    var b = { kind: 'approval', action: action, approval: id };
    var n = String(note || '').trim();
    if (n) b.note = n.slice(0, 2000);
    return b;
  }
  function approvalLabel(action) { return APPROVAL_ACT[action] || ''; }
  function approvalDone(action) { return APPROVAL_DONE[action] || 'Approval decided'; }
  var hq = { kindSupervision: hqKindSupervision, hire: hqHire, adapter: hqAdapter, goals: hqGoals, routineStates: routineStates, routineFacts: routineFacts, routineForm: routineForm, routineCalls: routineCalls, routineDone: routineDone, approvalBody: approvalBody, approvalLabel: approvalLabel, approvalDone: approvalDone, linkLabel: 'Open in Paperclip', approvalDenied: 'Read only. The HQ write grid denies approvals.', approvalBlocked: 'This approval cannot be decided here.', searchItems: hqSearchItems, phone: hqPhone, desk: hqDesk, status: hqStatus, budget: hqBudget, every: hqEvery, supervision: hqSupervision, state: hqState, runtime: runtimeState, runtimeKey: runtimeKey, glance: hqGlance, cards: hqCards, org: hqOrg, memo: hqMemo, taskBoard: hqTaskBoard,
    // the hints of the HQ Lobby's objects in the scene (#226): the HR desk hires, the memo and the task board open the HQ
    lobbyVerbs: { desk: 'Hire an employee', monitor: 'Hire an employee', memo: 'Open the HQ', pipeline: 'Open the HQ tasks', directory: 'Search the HQ' } };

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
      out.push({ id: r.id, kind: 'permission', tool: r.tool, detail: r.detail || '', reason: oneLine(r.reason), explain: r.explain || null, text: 'Allow ' + r.tool + (r.detail ? ': ' + clip(r.detail, 160) : '') + '?', risk: r.risk, always: r.always || null, t: +r.t || 0, i: i });
    });
    (s.questions || []).forEach(function (q, i) {
      out.push({ id: q.id, kind: 'question', tool: 'office_ask', detail: '', reason: '', text: clip(q.text, 400), risk: undefined, always: null, t: +q.t || 0, i: 1000 + i });
    });
    out.sort(function (a, b) { return a.t - b.t || a.i - b.i; });
    return out.map(function (r) { delete r.i; return r; });
  }
  // The three layers of an approval (#149, story 6): a one-line intent, the reason, the raw command. Intent and reason come from a
  // local model (r.explain, written after the request came in) and are only shown. The raw command is the request's own text
  // (preview, else detail) and is always there: a summary never replaces it. Without an explanation the reason is the agent's own.
  function explainLayers(r) {
    r = r || {};
    var e = r.explain || null;
    return { intent: e ? oneLine(e.intent) : '', reason: e && e.reason ? oneLine(e.reason) : oneLine(r.reason), raw: String(r.preview || r.detail || ''), explained: !!(e && e.intent), model: e ? String(e.model || '') : '' };
  }
  // Similar open requests answer together (#149, stories 7-9): the same tool, the same risk and the same whole call text (preview, else detail). Only a permission request
  // of lower than high risk groups; a question, a merge decision and a high-risk call stand alone. Items keep their order
  // (oldest first). Each group is { key, items, count, groupable }; a group of one is not groupable.
  function requestGroups(items) {
    var out = [], at = {};
    (items || []).forEach(function (r) {
      var text = String(r.preview || r.detail || '').trim(); // the whole call text: detail alone is a short label
      var ok = r.kind === 'permission' && r.risk !== 'high' && !!r.tool && !!text;
      var k = ok ? 'g:' + r.tool + '|' + r.risk + '|' + text : 'one:' + r.id;
      if (at[k] == null) { at[k] = out.length; out.push({ key: k, items: [], count: 0, groupable: false }); }
      var g = out[at[k]]; g.items.push(r); g.count = g.items.length; g.groupable = ok && g.count > 1;
    });
    return out;
  }
  // The answers of a group: one for each request, each with its own id. The page sends them one by one, so each is recorded
  // by itself. Nothing for a group of one or a group that holds a question.
  function groupAnswers(g, allow) {
    if (!g || !g.groupable) return [];
    var list = g.items.filter(function (r) { return r.kind === 'permission' && r.risk !== 'high'; });
    return list.length > 1 && list.length === g.items.length ? list.map(function (r) { return { id: r.id, allow: allow === true }; }) : [];
  }
  // How long the office holds a request for the user: 15 minutes in a session that runs in the office, 60 s in a terminal session
  // (src/server.mjs HEADLESS_ASK_MS and the terminal dialog). The approval paper shows the time left.
  function holdMs(s) { return s && s.headless ? 15 * 60 * 1000 : 60 * 1000; }
  function alwaysOffer(s) {
    return requests(s).filter(function (r) { return r.kind === 'permission' && r.always && r.risk !== 'high'; })[0] || null;
  }

  function bare(o) { return Object.assign(Object.create(null), o); }
  function own(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }

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
    if (k && k.cloud && k.host) return 'Runs ' + label + ' on ' + k.host + '. You talk to it in the chat. Its tools run there with no approval here: you see what it says, but the office cannot hold its calls. Each message can cost money. It cannot read the folder: the folder only sets its desk. The office never signs in for you.';
    if (k && k.cloud) return 'Runs ' + label + ' in your Microsoft cloud account. You talk to it in the chat. Its tools run in the cloud with no approval here: you see them, but the office does not hold them. Only a request the service sends for approval comes to you. Each message can cost money. It cannot read the folder: the folder only sets its desk. The office never signs in for you.';
    if (k && !k.paid) return 'Runs a model from ' + label + ' on this machine, inside the office. It reads and changes files in the folder and runs commands. Risky steps come to you for approval. It costs nothing.';
    return 'Runs ' + label + ' inside the office. You talk to it in the chat and approve its steps here. It has no terminal window.';
  }

  // The spend limit field of the Open dialog: a paid kind that reports cost (#33, Q22). A kind with cost 'unknown' has no
  // limit (src/providers/index.mjs spendLimitFor gives null: nothing could stop it), so its form says why instead (review M2).
  // A cloud kind (#24) reports cost only when the owner set its prices (src/providers/cloud.mjs): without them it is 'unknown'.
  function limitShown(k) { return !k || (k.paid !== false && k.cost !== 'unknown'); }
  function costNote(k) {
    if (!(k && k.paid !== false && k.cost === 'unknown')) return '';
    var label = k.label || 'This agent';
    if (k.cloud && k.host) return label + ' reports no cost, so the office shows it as unknown and no spend limit can stop it. Check the spend on ' + k.host + '.';
    if (k.cloud) return label + ' reports no dollars, and no prices are set, so the office shows its cost as unknown and no spend limit can stop it. Set the prices to count it (see docs/configuration.md), or check the spend in your Azure account.';
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

  // The names the topic files (vocab-security.js, vocab-layers.js, vocab-persona.js) share with this file. Not part of the public list.
  root.OfficeVocab = { explainLayers: explainLayers, requestGroups: requestGroups, groupAnswers: groupAnswers, stateWord: stateWord, laneOf: laneOf, limitShown: limitShown, costNote: costNote, kindWord: kindWord, kindsWord: kindsWord, kindState: kindState, notConfigured: notConfigured, needsTitle: needsTitle, modelLabel: modelLabel, modelNoun: modelNoun, pickFact: pickFact, modelChoices: modelChoices, modelSwitch: modelSwitch, modelWord: modelWord, firstModel: firstModel, noModelFor: noModelFor, withKind: withKind, kindNote: kindNote, requests: requests, alwaysOffer: alwaysOffer, featuresOf: featuresOf, hasFeature: hasFeature, status: status, isWaiting: isWaiting, taskLine: taskLine, toolKind: toolKind, toolShort: toolShort, toolArg: toolArg, todoStatus: todoStatus, figures: figures, agentsSign: agentsSign, supervision: supervision, supervisionHead: supervisionHead, supervisionLines: supervisionLines, context: context, platform: platform, hq: hq, plan: plan, holdMs: holdMs, folderOf: folderOf };
  Object.defineProperty(root.OfficeVocab, 'shared', { value: { own: own, bare: bare, has: has, count: count, clip: clip, oneLine: oneLine, money: money } });
})(typeof globalThis !== 'undefined' ? globalThis : window);
