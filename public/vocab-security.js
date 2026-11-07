/* Agent Office for Claude Code x0.2: the Security room grid (#70).
   A topic file of the session vocabulary: it adds security to globalThis.OfficeVocab (one global, public/vocab.js).
   Load it after vocab.js. Plain script, no I/O, no timers. */
(function (root) {
  'use strict';
  var shared = root.OfficeVocab.shared;
  var own = shared.own, bare = shared.bare, has = shared.has;
  var V = root.OfficeVocab;
  var requests = V.requests;
  // ---------- the Security room grid (#70) ----------
  // Rows are action kinds (risk.mjs actionOf names the row of a tool call) and settings of the Agents screen; columns
  // are agent kinds. A cell is Ask, Allow or Deny (a toggle is Off or On). Every call cell is Ask by default, also the low
  // ones (read or edit inside the worktree): the office answers a request only when the user set the cell to Allow or Deny
  // (owner decision pending, #67; Claude Code asks about such calls by itself today). One exception, `defs`: the local model
  // keeps what it did before the Security room, its reads and edits inside the worktree run with no question (they never were
  // requests, src/providers/local.mjs). The two Secrets rows never offer Allow. The Agents rows are office-wide;
  // every other row can have a per-building override. A rule the row does not offer is never used.
  // free: the kind runs on a model of this machine and costs nothing (the Spend screen says Free).
  var SEC_COLUMNS = [{ id: 'claude-code', label: 'Claude Code' }, { id: 'hermes', label: 'Hermes' }, { id: 'dsh', label: 'dsh' },
    { id: 'openclaw', label: 'OpenClaw' }, { id: 'copilot', label: 'Copilot' }, { id: 'acp', label: 'ACP tools' }, { id: 'local', label: 'Local model', free: true }, { id: 'agent-framework', label: 'Agent Framework', free: true }, { id: 'cloud', label: 'Cloud agent' }];
  // The tables are looked up by names that come from requests and saved files, so they have no prototype: '__proto__' or
  // 'constructor' is no row, agent kind or word. Rule maps (rules.office, rules.buildings) are read by own keys only (own).
  // The Microsoft cloud kinds (#24) and the remote tools (#218: Cursor cloud, Hermes gateway) share one column, like the two local servers: no
  // call of any of them comes to the office (ungated, Unsupervised), so the same rules hold for all.
  var SEC_KIND = bare({ 'claude-code': 'claude-code', ollama: 'local', lmstudio: 'local', hermes: 'hermes', dsh: 'dsh', openclaw: 'openclaw', 'agent-framework': 'agent-framework', copilot: 'copilot', gemini: 'acp', opencode: 'acp', kimi: 'acp', acp: 'acp', foundry: 'cloud', 'copilot-studio': 'cloud', 'cursor-cloud': 'cloud', 'hermes-gateway': 'cloud' });
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
    // only: the kinds whose provider is gated: false (src/providers/acp.mjs AGENTS, the cloud kinds); the others ask the office, so "Gated".
    ungated: { label: 'Turn on ungated agents', options: TOGGLE, def: 'off', office: true, only: ['hermes', 'copilot', 'acp', 'cloud'], na: 'Gated' },
    // Paperclip agents are not an agent kind: the Agents screen lists them by name in its Paperclip part, each with its own
    // Supervise in office (#76, public/security.js), so no cell stands for all of them.
    // An agent that reports no cost: Ask (the office asks once per session), Allow (it runs without asking), Deny (it never runs).
    // A cloud kind reports cost only from the prices the owner set (src/providers/cloud.mjs); without them it is such an agent.
    'no-cost': { label: 'Run without cost reports', options: RULE, def: 'ask', office: true, only: ['hermes', 'dsh', 'openclaw', 'copilot', 'acp', 'cloud'], na: { 'claude-code': 'Reports cost', local: 'Free', 'agent-framework': 'Free' } }
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


  Object.assign(root.OfficeVocab, { security: security });
})(typeof globalThis !== 'undefined' ? globalThis : window);
