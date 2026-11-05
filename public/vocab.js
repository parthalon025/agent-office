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
     agentsSign(n)    -> "N agents" for a room shared by 2 or more agents (top-level sessions; helpers do not count), else ''
     requests(s)      -> every open request of a session, oldest first: { id, kind, tool, text, detail, risk, always, t }
                         kind is 'permission' (Approve or Decline) or 'question' (Yes or No; no risk value)
     alwaysOffer(s)   -> the first permission request that may offer "Always allow", or null. Never a question,
                         never a high-risk request, never one without a rule to save.
     security         -> the Security room grid (#70), shared by its wall screens and the server's rules (security.mjs):
                         screens [{ id, title, rows }], rows { id: { label, options, def, office?, only? } }, columns
                         [{ id, label }] (agent kinds), columnOf(providerKind), options(row), valueOf(rules, building, row,
                         col), sourceOf(...) ('building' | 'office' | 'default'), next(row, value), loosens(row, from, to),
                         applies(row, col), na(row, col), word(value), key(row, col), own(map, key) (an own key, never
                         an inherited one: rule maps come from requests and state.json).
                         rules: { office: { 'row|col': value }, buildings: { buildingKey: { 'row|col': value } } }.
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

  // The text of a room sign that counts agents. An agent is a top-level session: the count comes from figures().sessions,
  // which never includes helpers (subagents sit in the parent's room as guests). A room with one agent or none says nothing.
  function agentsSign(n) { return n >= 2 ? n + ' agents' : ''; }

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

  // ---------- the Security room grid (#70) ----------
  // Rows are action kinds (risk.mjs actionOf names the row of a tool call) and settings of the Agents screen; columns
  // are agent kinds. A cell is Ask, Allow or Deny (a toggle is Off or On). Defaults copy riskOf: low (read or edit inside
  // the worktree) is Allow, the rest is Ask. The two Secrets rows never offer Allow. The Agents rows are office-wide;
  // every other row can have a per-building override. A rule the row does not offer is never used.
  var SEC_COLUMNS = [{ id: 'claude-code', label: 'Claude Code' }, { id: 'hermes', label: 'Hermes' }, { id: 'dsh', label: 'dsh' },
    { id: 'openclaw', label: 'OpenClaw' }, { id: 'local', label: 'Local model' }];
  // The tables are looked up by names that come from requests and saved files, so they have no prototype: '__proto__' or
  // 'constructor' is no row, agent kind or word. Rule maps (rules.office, rules.buildings) are read by own keys only (own).
  function bare(o) { return Object.assign(Object.create(null), o); }
  function own(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  var SEC_KIND = bare({ 'claude-code': 'claude-code', ollama: 'local', lmstudio: 'local', hermes: 'hermes', dsh: 'dsh', openclaw: 'openclaw' });
  var RULE = ['ask', 'allow', 'deny'], ASK_DENY = ['ask', 'deny'], TOGGLE = ['off', 'on'];
  var SEC_ROWS = bare({
    'read-inside': { label: 'Read inside the worktree', options: RULE, def: 'allow' },
    'edit-inside': { label: 'Edit inside the worktree', options: RULE, def: 'allow' },
    'files-outside': { label: 'Read or edit outside it', options: RULE, def: 'ask' },
    shell: { label: 'Shell commands', options: RULE, def: 'ask' },
    web: { label: 'Web and network', options: RULE, def: 'ask' },
    mcp: { label: 'MCP tools', options: RULE, def: 'ask' },
    settings: { label: 'Settings files that run code', options: ASK_DENY, def: 'ask' },
    secrets: { label: 'Secret files', options: ASK_DENY, def: 'ask' },
    // Agents screen. Ungated agents run tool calls without asking the office (ADR 0001): off until the user turns them on.
    ungated: { label: 'Turn on ungated agents', options: TOGGLE, def: 'off', office: true, only: ['openclaw'], na: 'Gated' },
    // Paperclip's Claude Code runs go through the office hooks (#76).
    supervise: { label: 'Paperclip: Supervise in office', options: TOGGLE, def: 'off', office: true, only: ['claude-code'], na: 'Not used' },
    // An agent that reports no cost: Ask (the office asks once per session), Allow (it runs without asking), Deny (it never runs).
    'no-cost': { label: 'Run without cost reports', options: RULE, def: 'ask', office: true, only: ['hermes', 'dsh', 'openclaw'], na: { 'claude-code': 'Reports cost', local: 'Free' } }
  });
  var SEC_SCREENS = [
    { id: 'files', title: 'Files', rows: ['read-inside', 'edit-inside', 'files-outside'] },
    { id: 'commands', title: 'Commands', rows: ['shell'] },
    { id: 'network', title: 'Network', rows: ['web', 'mcp'] },
    { id: 'secrets', title: 'Secrets', rows: ['settings', 'secrets'] },
    { id: 'agents', title: 'Agents', rows: ['ungated', 'supervise', 'no-cost'] },
    { id: 'spend', title: 'Spend', rows: [] }
  ];
  var SEC_WORD = bare({ ask: 'Ask', allow: 'Allow', deny: 'Deny', off: 'Off', on: 'On' });
  function secKey(row, col) { return row + '|' + col; }
  function secApplies(row, col) { var r = SEC_ROWS[row]; return !!r && (!r.only || r.only.indexOf(col) >= 0); }
  function secOk(row, v) { return SEC_ROWS[row].options.indexOf(v) >= 0; }
  // The rule of a cell and where it comes from: the building's override, the office-wide rule, or the default.
  function secLook(rules, building, row, col) {
    if (!secApplies(row, col)) return null;
    var r = SEC_ROWS[row], k = secKey(row, col), b = rules && building != null && own(rules.buildings, building) ? rules.buildings[building] : null;
    if (!r.office && own(b, k) && secOk(row, b[k])) return { value: b[k], source: 'building' };
    var o = rules && rules.office;
    if (own(o, k) && secOk(row, o[k])) return { value: o[k], source: 'office' };
    return { value: r.def, source: 'default' };
  }
  var security = {
    roomName: 'Security', screens: SEC_SCREENS, rows: SEC_ROWS, columns: SEC_COLUMNS, key: secKey, applies: secApplies, own: own,
    columnOf: function (kind) { return SEC_KIND[kind || 'claude-code'] || null; },
    options: function (row) { return SEC_ROWS[row] ? SEC_ROWS[row].options.slice() : []; },
    valueOf: function (rules, building, row, col) { var x = secLook(rules, building, row, col); return x ? x.value : null; },
    sourceOf: function (rules, building, row, col) { var x = secLook(rules, building, row, col); return x ? x.source : null; },
    next: function (row, v) {
      var o = SEC_ROWS[row].options, i = o.indexOf(v);
      return o[((i < 0 ? o.indexOf(SEC_ROWS[row].def) : i) + 1) % o.length];
    },
    loosens: function (row, from, to) { return from !== to && (to === 'allow' || to === 'on'); },
    na: function (row, col) { var n = SEC_ROWS[row] && SEC_ROWS[row].na; return secApplies(row, col) ? '' : (n && typeof n === 'object' ? n[col] || '' : n || ''); },
    word: function (v) { return SEC_WORD[v] || ''; }
  };

  root.OfficeVocab = { requests: requests, alwaysOffer: alwaysOffer, status: status, isWaiting: isWaiting, taskLine: taskLine, toolKind: toolKind, toolShort: toolShort, toolArg: toolArg, todoStatus: todoStatus, figures: figures, agentsSign: agentsSign, security: security };
})(typeof globalThis !== 'undefined' ? globalThis : window);
