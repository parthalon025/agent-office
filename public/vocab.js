/* Agent Office for Claude Code x0.1: session vocabulary.
   One home for the words and rules that every surface shares: the status key and word of a session, its task
   line, the kind and short name of a tool, the status of a to-do, and the figures of a room.
   Plain script, no I/O, no timers. The page loads it as a script (window.OfficeVocab). The server and the tests
   import it for its side effect and read globalThis.OfficeVocab.

     status(s)        -> { key, word, live }  key is a DS status: working, waiting, error, finished, resting
     isWaiting(s)     -> true when the session has a pending permission prompt or an open question.
                         A subagent's tool call does not change it.
     taskLine(s)      -> the task text next to the state word
     toolKind(name)   -> a DS tool kind (terminal, code, search, browser, flow, skill, memory, mcp, api)
     toolShort(name)  -> the short tool name every surface shows
     toolArg(name)    -> the argument name of the tool's detail text
     todoStatus(t)    -> a DS plan step status
     figures(list)    -> the numbers of a room, from its open sessions
     requests(s)      -> every open request of a session, oldest first: { id, kind, tool, text, detail, risk, always, t }
                         kind is 'permission' (Approve or Decline) or 'question' (Yes or No; no risk value)
     alwaysOffer(s)   -> the first permission request that may offer "Always allow", or null. Never a question,
                         never a high-risk request, never one without a rule to save.
     kindWord(s, kinds) -> the agent kind of a session as a word ('Claude Code', 'Ollama'): the label of s.provider in
                         kinds (the snapshot's kinds), else the kind id. '' when the session has no kind.
     kindsWord(list, kinds) -> the kinds of a list of sessions as one word ('Claude Code, Ollama'): each kind once,
                         in the order of kinds, a kind it does not know last. '' when no session has a kind.
   Agent kinds as the Open dialog, a room's Add agent and the Agent kinds view show them. A kind k is a snapshot kind
   (providers/index.mjs describe) with its GET /api/providers answer: { checking, ready, models, needs, ... }.
     kindState(k)     -> { key, word }: Checking (no answer yet), Ready or Not ready, with a DS status key
     modelChoices(k, fallback) -> the Model options. A kind with a default model starts with Default; a local model
                         offers only its models. No kind, or a default-model kind before its answer: fallback.
     firstModel(k)    -> the model a kind starts on: the first of a kind that needs one, else '' (Default)
     noModelFor(k)    -> true when the kind needs a model and has none to pick (Open session waits)
     withKind(form, k, id) -> the form after a kind change: its first model, and only the options that kind takes
     kindNote(k, terminal) -> the line that says where a kind runs and what it costs
*/
(function (root) {
  'use strict';
  var KIND = { Bash: 'terminal', PowerShell: 'terminal', WebFetch: 'browser', WebSearch: 'search', Grep: 'search', Glob: 'search', Read: 'code', Edit: 'code', Write: 'code', MultiEdit: 'code', NotebookEdit: 'code', Task: 'flow', Agent: 'flow', Skill: 'skill', TodoWrite: 'memory' };
  var ARG = { Bash: 'command', PowerShell: 'command', Read: 'file', Edit: 'file', Write: 'file', MultiEdit: 'file', NotebookEdit: 'file', Grep: 'pattern', Glob: 'pattern', WebFetch: 'url', WebSearch: 'query', Task: 'task', Agent: 'task', Skill: 'skill' };
  var TODO = { pending: 'resting', in_progress: 'working', completed: 'finished' };

  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function has(a) { return !!(a && a.length); }

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

  // The HUD adds the state word ("Working · ..."), so the task text carries only the task.
  function taskLine(s) {
    var k = status(s).key;
    if (s.status === 'ended') return 'Left the office';
    if (k === 'waiting') return clip(s.note, 90) || 'Needs your attention';
    if (s.status === 'starting') return 'Waiting for the first hook';
    if (k === 'working') {
      if (s.live) return clip(String(s.live).replace(/\s+/g, ' ').slice(-90), 90);
      return s.tool ? s.tool.name + (s.tool.detail ? ' ' + clip(s.tool.detail, 60) : '') : (clip(s.prompt, 70) || 'Thinking');
    }
    if (k === 'error') return clip(s.error.text, 200) || 'The turn failed.';
    return s.turns > 0 ? (clip(s.prompt, 60) || 'Last turn') : 'Waiting for a prompt';
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

  // The room's numbers. list: the open sessions in the room. Waiting counts sessions, by isWaiting().
  function figures(list) {
    var o = { sessions: 0, working: 0, waiting: 0, toolCalls: 0, tokens: 0, cost: 0, priced: 0, todosDone: 0, todosTotal: 0, lastEvent: 0 };
    (list || []).forEach(function (s) {
      o.sessions++;
      var k = status(s).key;
      if (k === 'working') o.working++;
      if (k === 'waiting') o.waiting++;
      o.toolCalls += (s.calls || []).length;
      o.tokens += (s.usage && s.usage.tokens) || 0;
      if (typeof s.cost === 'number') { o.cost += s.cost; o.priced++; }
      (s.todos || []).forEach(function (t) { o.todosTotal++; if (t.status === 'completed') o.todosDone++; });
      if ((s.lastEvent || 0) > o.lastEvent) o.lastEvent = s.lastEvent;
    });
    return o;
  }

  function requests(s) {
    if (!s || s.status === 'ended') return [];
    var out = [];
    (s.pending || []).forEach(function (r, i) {
      out.push({ id: r.id, kind: 'permission', tool: r.tool, detail: r.detail || '', text: 'Allow ' + r.tool + (r.detail ? ': ' + clip(r.detail, 160) : '') + '?', risk: r.risk, always: r.always || null, t: +r.t || 0, i: i });
    });
    (s.questions || []).forEach(function (q, i) {
      out.push({ id: q.id, kind: 'question', tool: 'office_ask', detail: '', text: clip(q.text, 400), risk: undefined, always: null, t: +q.t || 0, i: 1000 + i });
    });
    out.sort(function (a, b) { return a.t - b.t || a.i - b.i; });
    return out.map(function (r) { delete r.i; return r; });
  }
  function alwaysOffer(s) {
    return requests(s).filter(function (r) { return r.kind === 'permission' && r.always && r.risk !== 'high'; })[0] || null;
  }

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
    return k.ready ? { key: 'finished', word: 'Ready' } : { key: 'waiting', word: 'Not ready' };
  }
  function modelChoices(k, fallback) {
    var ms = (k && k.models) || [];
    if (!k || (!ms.length && !k.needsModel)) return fallback || [{ value: '', label: 'Default' }];
    var opts = ms.map(function (m) { return { value: m.id, label: m.label || m.id }; });
    if (!k.needsModel) return [{ value: '', label: 'Default' }].concat(opts);
    return opts.length ? opts : [{ value: '', label: k.checking ? 'Looking for models' : 'No models' }];
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
    if (k && !k.paid) return 'Runs a model from ' + label + ' on this machine, inside the office. It reads and changes files in the folder and runs commands. Risky steps come to you for approval. It costs nothing.';
    return 'Runs ' + label + ' inside the office. You talk to it in the chat and approve its steps here. It has no terminal window.';
  }

  root.OfficeVocab = { kindWord: kindWord, kindsWord: kindsWord, kindState: kindState, modelChoices: modelChoices, firstModel: firstModel, noModelFor: noModelFor, withKind: withKind, kindNote: kindNote, requests: requests, alwaysOffer: alwaysOffer, status: status, isWaiting: isWaiting, taskLine: taskLine, toolKind: toolKind, toolShort: toolShort, toolArg: toolArg, todoStatus: todoStatus, figures: figures };
})(typeof globalThis !== 'undefined' ? globalThis : window);
