// The HQ read model, the pure part (#197, spec #191): the org chart as the floors of the HQ building, the Lobby dashboard, and the
// contract of the Paperclip API shapes the office reads. paperclip.mjs holds the connection and reads; this module only shapes what it
// read. The write side is here too (#198): the write grid (Confirm, Allow, Deny per write kind: kinds, defaults, saved slice, the looser-change
// rule) and planWrite (the exact request of a write, checked before anything is asked or sent); `write` in paperclip.mjs sends it. No I/O, no clock. Tested in test/hq-model.test.mjs against test/fixtures/paperclip-shapes.json (the recorded shapes).

// ---------- the contract: the fields of each route the office reads ----------
// list: the answer is an array (the first element is checked) or one object. An empty list says nothing about its shape. A field the
// office reads is named with its type; a field Paperclip adds is no problem, a missing or retyped one is. Money is in cents in
// Paperclip (the read turns it into dollars). A type written `number?` may also be null (no budget set).
export const SHAPES = {
  company: { list: false, fields: { id: 'string', name: 'string' } },
  agents: { list: true, fields: { id: 'string', name: 'string', role: 'string', status: 'string', adapterType: 'string' } },
  issues: { list: true, fields: { id: 'string', title: 'string', status: 'string' } },
  goals: { list: true, fields: { id: 'string', title: 'string', status: 'string' } },
  approvals: { list: true, fields: { id: 'string', type: 'string', status: 'string' } },
  activity: { list: true, fields: { id: 'string', actorType: 'string', action: 'string', createdAt: 'string' } },
  costs: { list: false, fields: { spendCents: 'number', budgetCents: 'number?' } },
  secrets: { list: true, fields: { id: 'string', name: 'string' } },
  // The Costs view (#208): spend per agent and per project for a window (routes/costs.ts), and the budgets overview.
  costsByAgent: { list: true, fields: { agentId: 'string', costCents: 'number' } },
  costsByProject: { list: true, fields: { projectId: 'string', costCents: 'number' } },
  budgets: { list: false, fields: { policies: 'array' } },
  // Skills, plugins and adapters (#212): company skills (routes/company-skills.ts), installed plugins (routes/plugins.ts) and the adapter list (routes/adapters.ts).
  skills: { list: true, fields: { id: 'string', key: 'string', name: 'string' } },
  plugins: { list: true, fields: { id: 'string', pluginKey: 'string', status: 'string' } },
  adapters: { list: true, fields: { type: 'string', label: 'string', source: 'string' } },
  // Company admin (#213): the invites, join requests and members of a company (routes/access.ts). Invites and members come in an object.
  invites: { list: false, fields: { invites: 'array' } },
  joinRequests: { list: true, fields: { id: 'string', status: 'string', requestType: 'string' } },
  members: { list: false, fields: { members: 'array' } },
  // Company admin, the rest (#221): the instance settings (routes/instance-settings.ts: the default environment and the general settings), the
  // instance's environments (routes/environments.ts), the export bundle of a company (routes/companies.ts) and what an import answers.
  instanceSettings: { list: false, fields: { id: 'string', defaultEnvironmentId: 'string?', general: 'object' } },
  environments: { list: true, fields: { id: 'string', name: 'string', driver: 'string', status: 'string' } },
  exportBundle: { list: false, fields: { rootPath: 'string', manifest: 'object', files: 'object' } },
  importPreview: { list: false, fields: { plan: 'object', warnings: 'array', errors: 'array' } },
  importResult: { list: false, fields: { company: 'object' } },
};

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/** The shape of an answer: { list, fields: { name: type } } (of the first element for a list). Used to record and to compare. */
export function shapeOf(json) {
  const list = Array.isArray(json), row = list ? json[0] : json;
  const fields = {};
  if (row && typeof row === 'object' && !Array.isArray(row)) for (const [k, v] of Object.entries(row)) fields[k] = typeOf(v);
  return { list, fields };
}
/** What does not fit the shape the office reads of a route ([] = it fits). Words for the user: the route, the field, what was found. */
export function shapeProblems(name, json) {
  const spec = SHAPES[name];
  if (!spec) return [];
  if (spec.list && !Array.isArray(json)) return [`${name}: expected a list.`];
  if (!spec.list && (!json || typeof json !== 'object' || Array.isArray(json))) return [`${name}: expected an object.`];
  const row = spec.list ? json[0] : json;
  if (row === undefined) return [];
  if (!row || typeof row !== 'object') return [`${name}: expected objects in the list.`];
  const out = [];
  for (const [f, t] of Object.entries(spec.fields)) {
    if (!(f in row)) out.push(`${name}: ${f} is missing.`);
    else if (typeOf(row[f]) !== t.replace('?', '') && !(t.endsWith('?') && row[f] === null)) out.push(`${name}: ${f} is ${typeOf(row[f])}, expected ${t.replace('?', '')}.`);
  }
  return out;
}

// ---------- floors from the org chart ----------
const MAX_RANKS = 8;
const RANK_NAMES = ['Executive', 'Leads', 'Teams'];
/**
 * The floors of the HQ building, bottom to top: Records, Lobby, then one floor per rank of the org chart, the lowest rank first, so the
 * top role is on the top floor. Rank is the length of the reporting line to a root (an employee with no manager, a manager that is not in
 * the list, or a loop). Depth stops at MAX_RANKS; deeper employees share the last rank. Never loops, never drops an employee.
 * agents: [{ id, reportsTo, ... }]. Each floor: { key, name, rank, employees }.
 */
export function floorsOf(agents) {
  const by = new Map(agents.map((a) => [a.id, a]));
  const rankOf = (a) => {
    let n = 0, cur = a;
    const seen = new Set([a.id]);
    while (cur.reportsTo && by.has(cur.reportsTo) && !seen.has(cur.reportsTo) && n < MAX_RANKS - 1) { cur = by.get(cur.reportsTo); seen.add(cur.id); n++; }
    return n;
  };
  const ranks = new Map();
  for (const a of agents) { const r = rankOf(a); if (!ranks.has(r)) ranks.set(r, []); ranks.get(r).push(a); }
  const used = [...ranks.keys()].sort((x, y) => y - x);
  const floors = [{ key: 'records', name: 'Records', rank: null, employees: [] }, { key: 'lobby', name: 'Lobby', rank: null, employees: [] }];
  for (const r of used) floors.push({ key: `rank-${r}`, name: RANK_NAMES[r] || `Rank ${r + 1}`, rank: r, employees: ranks.get(r) });
  return floors;
}

// ---------- reporting lines (#202) ----------
/**
 * The reporting lines as cables between the pips of the floors: one per employee whose manager is in the list. A manager that is not in the
 * list (terminated, or from another company), a self report and a line that closes a loop draw no cable. agents: [{ id, reportsTo }].
 * Each cable: { from, to } (the employee, the manager), in the order of the list.
 */
export function cablesOf(agents) {
  const by = new Map(agents.map((a) => [a.id, a]));
  const out = [];
  for (const a of agents) {
    if (!a.reportsTo || a.reportsTo === a.id || !by.has(a.reportsTo)) continue;
    let cur = by.get(a.reportsTo), n = 0, loop = false;
    while (cur && n++ <= agents.length) { if (cur.id === a.id) { loop = true; break; } cur = cur.reportsTo ? by.get(cur.reportsTo) : null; }
    if (!loop) out.push({ from: a.id, to: a.reportsTo });
  }
  return out;
}
/**
 * Why a reporting line change cannot be made ('' = it can). managerId null (or '') makes the employee a root. A manager that already
 * reports to the employee, directly or through others, would close a loop, so it is refused. Words for the user.
 */
export function reportingProblem(agents, id, managerId) {
  const by = new Map(agents.map((a) => [a.id, a]));
  if (!by.has(id)) return 'This employee is not in the company.';
  if (managerId === null || managerId === undefined || managerId === '') return '';
  if (!by.has(managerId)) return 'The manager is not in the company.';
  if (managerId === id) return 'An employee cannot report to itself.';
  let cur = by.get(managerId), n = 0;
  while (cur && n++ <= agents.length) {
    if (cur.id === id) return `${by.get(managerId).name || 'That manager'} already reports to ${by.get(id).name || 'this employee'}, directly or through others. That would make a loop.`;
    cur = cur.reportsTo ? by.get(cur.reportsTo) : null;
  }
  return '';
}

// ---------- the Lobby ----------
const ACTIVE_RUN = new Set(['running', 'queued']);
/**
 * The Lobby dashboard: counts and short lists, and null where the office could not read the data (never a zero that looks real).
 * in: { agents: [agent views], issues: [Paperclip issues]|null, approvals: [{ id, type, requestedByAgentId }]|null, goals: [{ id, title, status }]|null,
 *   activity: [{ id, text, at }]|null, costs: { spent, limit }|null, secrets: [name]|null, unread: [route names] }.
 */
export function lobbyOf(i) {
  const n = (st) => (i.issues || []).filter((x) => x && x.status === st).length;
  const nameOf = (id) => (i.agents.find((a) => a.id === id) || {}).name || '';
  const tasks = i.issues ? { open: n('backlog') + n('todo') + n('in_progress') + n('in_review') + n('blocked'), todo: n('todo'), inProgress: n('in_progress'), blocked: n('blocked'), inReview: n('in_review'), backlog: n('backlog') } : null;
  const pct = i.costs && i.costs.limit > 0 ? Math.round((i.costs.spent / i.costs.limit) * 100) : null;
  return {
    employees: {
      total: i.agents.length,
      working: i.agents.filter((a) => a.run && ACTIVE_RUN.has(a.run.status)).length,
      paused: i.agents.filter((a) => a.status === 'paused').length,
      error: i.agents.filter((a) => a.status === 'error').length,
      unsupervised: i.agents.filter((a) => a.supervision && a.supervision.state !== 'supervised').length,
    },
    tasks,
    approvals: i.approvals ? { pending: i.approvals.length, items: i.approvals.slice(0, 5).map((p) => ({ id: p.id, kind: p.type, by: nameOf(p.requestedByAgentId) })) } : null,
    goals: i.goals ? { total: i.goals.length, items: i.goals.slice(0, 6).map((g) => ({ id: g.id, title: g.title, status: g.status })) } : null,
    spend: i.costs ? { spent: i.costs.spent, limit: i.costs.limit, percent: pct } : null,
    activity: i.activity,
    secrets: i.secrets ? { count: i.secrets.length, names: i.secrets.slice(0, 20) } : null,
    unread: i.unread || [],
  };
}


// ---------- the inbox (#210) ----------
/**
 * What Paperclip holds for the user, as items of the one queue (Needs you): each pending approval, then each open task assigned to a
 * person (my issues: `assigneeUserId`; the office has one user, so any person assignee is the board). Each: { id, kind: 'approval' | 'issue',
 * text, by, at }. Names and statuses only: never a payload. null: neither list was read (unknown, not an empty inbox). Oldest first, capped.
 * in: { agents: [agent views], issues: [Paperclip issues]|null, approvals: [{ id, type, requestedByAgentId, at }]|null }.
 */
export const INBOX_CAP = 20;
export function inboxOf(i) {
  if (!i.approvals && !i.issues) return null;
  const nameOf = (id) => (i.agents.find((a) => a.id === id) || {}).name || '';
  const out = [];
  for (const p of i.approvals || []) {
    const by = nameOf(p.requestedByAgentId), kind = String(p.type || 'request').replace(/_/g, ' ');
    out.push({ id: `approval:${p.id}`, kind: 'approval', text: by ? `Approval from ${by}: ${kind}` : `Approval: ${kind}`, by, at: p.at || 0 });
  }
  for (const x of i.issues || []) {
    if (!x || !x.id || !x.assigneeUserId || x.status === 'done' || x.status === 'cancelled') continue;
    const name = [x.identifier, x.title].filter(Boolean).join(' ');
    out.push({ id: `issue:${x.id}`, kind: 'issue', text: `Task for you${x.status === 'blocked' ? ' (blocked)' : ''}: ${name || 'untitled'}`, by: '', at: Date.parse(x.updatedAt || x.createdAt || '') || 0 });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, INBOX_CAP);
}

// ---------- the write grid (#198, ADR 0010) ----------
// Each write kind is Confirm, Allow or Deny. Defaults: Confirm for the consequential kinds, Allow for the user's own task edits and
// comments. A secret never takes Allow. The saved slice holds only the cells the user set (a value equal to the default counts: the user
// set it). The table is looked up by names from requests and saved files, so every lookup is by own key.
const RULES = ['confirm', 'allow', 'deny'];
const STRICT = { deny: 0, confirm: 1, allow: 2 };
export const WRITE_KINDS = {
  hire: { label: 'Hires', options: RULES, def: 'confirm' },
  pause: { label: 'Pause and retire', options: RULES, def: 'confirm' },
  budget: { label: 'Budgets', options: RULES, def: 'confirm' },
  approval: { label: 'Approvals', options: RULES, def: 'confirm' },
  reporting: { label: 'Reporting lines', options: RULES, def: 'confirm' },
  routine: { label: 'Routines', options: RULES, def: 'confirm' },
  access: { label: 'Invites and access', options: RULES, def: 'confirm' },
  secret: { label: 'Secrets', options: ['confirm', 'deny'], def: 'confirm' },
  task: { label: 'Tasks', options: RULES, def: 'allow' },
  comment: { label: 'Comments', options: RULES, def: 'allow' },
  company: { label: 'Company', options: RULES, def: 'confirm' },
  goal: { label: 'Goals', options: RULES, def: 'confirm' },
  instance: { label: 'Instance and environments', options: RULES, def: 'confirm' },
};
const kindRow = (k) => (typeof k === 'string' && Object.hasOwn(WRITE_KINDS, k) ? WRITE_KINDS[k] : null);
const gridError = (status, message) => Object.assign(new Error(message), { status });

/** The saved write grid: only cells the grid has, with values the kind offers. */
export function cleanWriteGrid(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) { const row = kindRow(k); if (row && row.options.includes(v)) out[k] = v; }
  return out;
}
/** The value of a cell: what the user set, else the default. An unknown kind is Deny (fail closed). */
export function writeValueOf(grid, kind) {
  const row = kindRow(kind);
  if (!row) return 'deny';
  const v = grid && typeof grid === 'object' && Object.hasOwn(grid, kind) ? grid[kind] : undefined;
  return row.options.includes(v) ? v : row.def;
}
/**
 * One change from the HQ. change: { kind, value, confirmed }. value null is Use default. A looser value (Deny to Confirm, Confirm to Allow)
 * needs confirmed: true, the painted Confirm; a stricter one applies at once. Returns { grid, from, to } with a new grid; the old one is
 * not changed. A secret never takes Allow, confirmed or not (400).
 */
export function setWriteCell(grid, change) {
  const { kind } = change || {};
  const row = kindRow(kind);
  if (!row) throw gridError(400, 'Unknown write kind.');
  const value = change.value === undefined ? null : change.value;
  if (value !== null && !row.options.includes(value)) throw gridError(400, `${row.label} cannot be set to ${String(value)}.`);
  const from = writeValueOf(grid, kind), to = value === null ? row.def : value;
  if (STRICT[to] > STRICT[from] && change.confirmed !== true) throw gridError(409, 'Confirm the looser rule first.');
  const next = { ...cleanWriteGrid(grid) };
  if (value === null) delete next[kind]; else next[kind] = value;
  return { grid: next, from, to };
}

// ---------- the plan of a write ----------
// planWrite(body) -> { kind, action, method, path(companyId), body, targets, summary }. body: { kind, action, ...fields }. The fields are
// checked here (400), every id must be a plain id (it goes into a path), and a target is a thing the writer reads before it writes
// (issue, approval, agent): it must belong to the connected company. Only the first writes are planned: task (create, assign), comment
// (add), approval (approve, reject, revise), routine (create, update, schedule, run, #209), reporting (set, #202), goal (create, update, #207),
// hire (create, #201), company (create, #199: scope 'none', it needs no connection; update, #213) and access (invite, revoke, approveJoin,
// rejectJoin, member, #213). Another kind in the grid
// has no plan yet, and is 400 (never sent).
const OFFICE_ADAPTER_TYPE = 'agent_office';   // the word of OFFICE_ADAPTER in paperclip.mjs (which imports this module)
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ISSUE_STATUS = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
export const GOAL_STATUSES = ['planned', 'active', 'achieved', 'cancelled'], GOAL_LEVELS = ['company', 'team', 'agent', 'task'];
const ROUTINE_STATUS = ['active', 'paused', 'archived'];
const CRON_RE = /^[0-9*/,\-A-Za-z ]+$/, TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const JOIN_TYPES = ['human', 'agent', 'both'], HUMAN_ROLES = ['owner', 'admin', 'operator', 'viewer'], MEMBER_STATUS = ['pending', 'active', 'suspended'];
export const FEEDBACK_SHARING = ['allowed', 'not_allowed', 'prompt'], ENVIRONMENT_STATUS = ['active', 'archived'];
export const IMPORT_FILES_MAX = 2000, IMPORT_BYTES_MAX = 10 * 1024 * 1024, EXPORT_INCLUDES = ['company', 'agents', 'projects', 'issues', 'skills'];
const TITLE_MAX = 200, TEXT_MAX = 10000, NOTE_MAX = 2000, DESC_MAX = 4000, NAME_MAX = 80, COMPANY_DESC_MAX = 300;
const short = (t, n = 80) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
function idOf(v, what) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw gridError(400, `Give the ${what}.`);
  return v;
}
function textOf(v, what, max, { required = false } = {}) {
  if (v === undefined || v === null) { if (required) throw gridError(400, `Give the ${what}.`); return ''; }
  if (typeof v !== 'string') throw gridError(400, `The ${what} must be text.`);
  const t = v.trim();
  if (required && !t) throw gridError(400, `Give the ${what}.`);
  if (t.length > max) throw gridError(400, `The ${what} is too long (at most ${max} characters).`);
  return t;
}
const decision = (action, route, summary) => [action, (b) => {
  const approval = idOf(b.approval, 'approval'), note = textOf(b.note, 'note', NOTE_MAX);
  return { method: 'POST', path: () => `/api/approvals/${approval}/${route}`, body: note ? { decisionNote: note } : {}, targets: [{ type: 'approval', id: approval }], summary };
}];
// The HR desk (#201): the role cards. role is Paperclip's role word (AGENT_ROLES of the pinned release); text is what the card says. A hire
// always names a role from this list, so the writer never sends a role Paperclip does not know.
export const HIRE_ROLES = [
  { role: 'engineer', label: 'Engineer', text: 'Writes and changes code.' },
  { role: 'qa', label: 'Quality', text: 'Tests changes and reports faults.' },
  { role: 'designer', label: 'Designer', text: 'Shapes screens and flows.' },
  { role: 'pm', label: 'Project manager', text: 'Plans work and keeps it moving.' },
  { role: 'researcher', label: 'Researcher', text: 'Reads sources and writes findings.' },
  { role: 'devops', label: 'Operations', text: 'Runs builds, releases and servers.' },
  { role: 'security', label: 'Security', text: 'Reviews risk and access.' },
  { role: 'general', label: 'General', text: 'Takes any task.' },
];
const HIRE_ROLE_IDS = new Set(HIRE_ROLES.map((r) => r.role));
// The office Manager (#204) is a hire like any other (one plan, ADR 0010: a hire is supervised and budgeted). Paperclip's role is an enum
// (AGENT_ROLES, validated by createAgentHireSchema) with no 'manager', so the Manager takes the Project manager role; the office marks it
// with adapterConfig.manager and knows its Managers from its own `managers` slice, never from the role.
export const MANAGER_ROLE = 'pm', MANAGER_TITLE = 'Agent Office Manager';
const HIRE_KIND_RE = /^[a-z][a-z0-9-]{0,39}$/, HIRE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/, SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
export const HIRE_BUDGET_MAX = 100000;   // dollars a month: a typing slip (an extra zero) is refused, not sent
export const HIRE_ISOLATIONS = ['worktree', 'same'];
function skillsOf(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw gridError(400, 'Skills are a list of names.');
  const out = [];
  for (const k of v) {
    if (typeof k !== 'string' || !SKILL_RE.test(k)) throw gridError(400, 'A skill name is not valid.');
    if (!out.includes(k)) out.push(k);
  }
  if (out.length > 20) throw gridError(400, 'Give at most 20 skills.');
  return out;
}
const PLANS = {
  task: {
    create(b) {
      const title = textOf(b.title, 'title', TITLE_MAX, { required: true }), description = textOf(b.description, 'description', DESC_MAX);
      const body = { title };
      if (description) body.description = description;
      if (b.status !== undefined && b.status !== null) { if (!ISSUE_STATUS.includes(b.status)) throw gridError(400, 'Unknown task status.'); body.status = b.status; }
      const targets = [];
      // A sub-task (#204: a Manager reports each step as a sub-issue of the task it works on): the parent is read first and must be in the company.
      if (b.parentId !== undefined && b.parentId !== null) { body.parentId = idOf(b.parentId, 'parent task'); targets.push({ type: 'issue', id: body.parentId }); }
      if (b.assigneeAgentId !== undefined && b.assigneeAgentId !== null) { body.assigneeAgentId = idOf(b.assigneeAgentId, 'agent'); targets.push({ type: 'agent', id: body.assigneeAgentId }); }
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/issues`, body, targets, summary: `Create the task "${short(title)}"` };
    },
    // The status of a task (#204: the Manager moves a task and its sub-tasks as the steps run).
    status(b) {
      const issue = idOf(b.issue, 'task');
      if (!ISSUE_STATUS.includes(b.status)) throw gridError(400, 'Unknown task status.');
      return { method: 'PATCH', path: () => `/api/issues/${issue}`, body: { status: b.status }, targets: [{ type: 'issue', id: issue }], summary: `Set a task to ${b.status.replace('_', ' ')}` };
    },
    assign(b) {
      const issue = idOf(b.issue, 'task'), agent = idOf(b.agent, 'agent');
      return { method: 'PATCH', path: () => `/api/issues/${issue}`, body: { assigneeAgentId: agent }, targets: [{ type: 'issue', id: issue }, { type: 'agent', id: agent }], summary: 'Assign a task' };
    },
  },
  comment: {
    add(b) {
      const issue = idOf(b.issue, 'task'), text = textOf(b.text, 'comment', TEXT_MAX, { required: true });
      return { method: 'POST', path: () => `/api/issues/${issue}/comments`, body: { body: text }, targets: [{ type: 'issue', id: issue }], summary: 'Comment on a task' };
    },
  },
  // A hire (#201): POST /agent-hires with the office adapter (its runs go through the Security room, so a new employee is supervised), a
  // monthly budget in whole cents (a hire without a budget is refused: 400) and nothing else the office has not named. The Confirm shows
  // exactly what it creates: role, manager, agent kind, model, budget and skills. The manager is checked as a target. officeManager: true
  // is the office Manager of a building (#204): the same hire, marked adapterConfig.manager, with the Project manager role by default.
  // Paperclip answers { agent, approval } (the writer reads the agent).
  hire: {
    create(b) {
      const name = textOf(b.name, 'name', NAME_MAX, { required: true });
      if (b.officeManager !== undefined && typeof b.officeManager !== 'boolean') throw gridError(400, 'officeManager is true or false.');
      const office = b.officeManager === true, role = office && (b.role === undefined || b.role === null || b.role === '') ? MANAGER_ROLE : b.role;
      if (typeof role !== 'string' || !HIRE_ROLE_IDS.has(role)) throw gridError(400, 'Pick a role.');
      const title = textOf(b.title, 'title', NAME_MAX) || (office ? MANAGER_TITLE : '');
      const manager = b.manager === undefined || b.manager === null || b.manager === '' ? null : idOf(b.manager, 'manager');
      const kind = b.agentKind === undefined || b.agentKind === null || b.agentKind === '' ? 'claude-code' : b.agentKind;
      if (typeof kind !== 'string' || !HIRE_KIND_RE.test(kind)) throw gridError(400, 'Give the agent kind.');
      const model = b.model === undefined || b.model === null || b.model === '' ? '' : b.model;
      if (model && (typeof model !== 'string' || !HIRE_MODEL_RE.test(model))) throw gridError(400, 'The model name is not valid.');
      const isolation = b.isolation === undefined || b.isolation === null || b.isolation === '' ? 'worktree' : b.isolation;
      if (!HIRE_ISOLATIONS.includes(isolation)) throw gridError(400, 'Isolation is worktree or same.');
      const dollars = b.budgetDollars;
      if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars <= 0) throw gridError(400, 'Set a monthly budget for the new employee. The office does not hire without one.');
      if (dollars > HIRE_BUDGET_MAX) throw gridError(400, `The monthly budget is too high (at most $${HIRE_BUDGET_MAX}).`);
      const cents = Math.round(dollars * 100);
      if (cents < 1) throw gridError(400, 'Set a monthly budget of at least one cent.');
      const skills = skillsOf(b.skills);
      const adapterConfig = { agentKind: kind, isolation };
      if (model) adapterConfig.model = model;
      if (office) adapterConfig.manager = true;
      const body = { name, role, adapterType: OFFICE_ADAPTER_TYPE, adapterConfig, budgetMonthlyCents: cents };
      if (title) body.title = title;
      if (manager) body.reportsTo = manager;
      if (skills.length) body.desiredSkills = skills;
      const cardLabel = HIRE_ROLES.find((r) => r.role === role).label, roleLabel = office ? `the office Manager (${cardLabel} role)` : cardLabel;
      const line = (mgr) => `Hire ${short(name, 60)} as ${roleLabel}, reporting to ${mgr}, agent kind ${kind}, model ${model || 'the default'}, $${(cents / 100).toFixed(2)} a month, skills ${skills.length ? skills.join(', ') : 'none'}`;
      const review = (org) => {
        const m = manager ? org.find((x) => x.id === manager) : null;
        if (manager && !m) return { problem: 'Paperclip has no such manager in this company.', status: 404 };
        return { problem: '', summary: line(m ? short(String(m.name || 'a manager'), 60) : 'no manager') };
      };
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/agent-hires`, body, targets: manager ? [{ type: 'agent', id: manager }] : [], review, summary: line(manager ? 'a manager' : 'no manager') };
    },
  },
  // The first company (#199): the one write that has no company to belong to. It names the Paperclip it goes to (url, a loopback address the
  // writer checks) and needs no connection: scope 'none'. The writer reads the company list first and reuses a company of the same name.
  company: {
    create(b) {
      const name = textOf(b.name, 'company name', NAME_MAX, { required: true }), description = textOf(b.description, 'description', COMPANY_DESC_MAX);
      if (typeof b.url !== 'string' || !b.url) throw gridError(400, 'Give the Paperclip address.');
      return { method: 'POST', path: () => '/api/companies', body: { name, description }, targets: [], scope: 'none', url: b.url, name, summary: `Create the company "${short(name)}"` };
    },
  // Company import (#221): a bundle from a company export, as a NEW company (Paperclip: routes/companies.ts POST /import, instance admin only).
  // Never the replace strategy, never secret values or adapter overrides (those stay in Paperclip), and imported routines start paused. The
  // writer first asks Paperclip for a preview (POST /import/preview, no change made): its errors refuse the write, and its counts are the
  // words of the Confirm. The bundle is checked here: a list of files (text or base64), no path that leaves the bundle, and a size limit.
  import(b) {
    const bundle = b.bundle;
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) throw gridError(400, 'Give the company export file.');
    const names = Object.keys(bundle.files);
    if (!names.length) throw gridError(400, 'The company export has no files.');
    if (names.length > IMPORT_FILES_MAX) throw gridError(400, `The company export has too many files (at most ${IMPORT_FILES_MAX}).`);
    let size = 0;
    const files = {};
    for (const n of names) {
      if (!n || n.length > 400 || n.startsWith('/') || n.includes('\\') || n.includes('\0') || n.split('/').some((x) => x === '..')) throw gridError(400, 'A file name in the company export is not valid.');
      const v = bundle.files[n];
      if (typeof v === 'string') { size += v.length; files[n] = v; }
      else if (v && typeof v === 'object' && v.encoding === 'base64' && typeof v.data === 'string') { size += v.data.length; files[n] = { encoding: 'base64', data: v.data, ...(typeof v.contentType === 'string' && v.contentType ? { contentType: v.contentType.slice(0, 100) } : {}) }; }
      else throw gridError(400, 'A file in the company export is not text or base64.');
    }
    if (size > IMPORT_BYTES_MAX) throw gridError(413, 'The company export is too large (at most 10 MB).');
    const rootPath = typeof bundle.rootPath === 'string' && bundle.rootPath ? bundle.rootPath.slice(0, 200) : null;
    const name = textOf(b.name, 'company name', NAME_MAX);
    const source = { type: 'inline', rootPath, files, expectedFileCount: names.length };
    const target = { mode: 'new_company', ...(name ? { newCompanyName: name } : {}) };
    let include;
    if (b.include !== undefined && b.include !== null) {
      if (typeof b.include !== 'object' || Array.isArray(b.include)) throw gridError(400, 'Choose what to import.');
      include = {};
      for (const k of EXPORT_INCLUDES) if (b.include[k] !== undefined) { if (typeof b.include[k] !== 'boolean') throw gridError(400, 'Choose what to import.'); include[k] = b.include[k]; }
    }
    const base = { source, target, collisionStrategy: 'rename', ...(include ? { include } : {}) };
    const front = Object.keys(files).find((n) => n === 'COMPANY.md' || n.endsWith('/COMPANY.md')), fromFile = front && typeof files[front] === 'string' ? (/^name:\s*["']?(.+?)["']?\s*$/m.exec(files[front]) || [])[1] : '';
    const label = name || (bundle.manifest && typeof bundle.manifest === 'object' && bundle.manifest.source && typeof bundle.manifest.source.companyName === 'string' ? bundle.manifest.source.companyName : '') || fromFile || 'a company';
    const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    return {
      method: 'POST', path: () => '/api/companies/import', body: { ...base, pauseAutomations: true }, targets: [], name, timeoutMs: 120000,
      preflight: { path: '/api/companies/import/preview', body: base },
      summarize: (pv) => {
        const pl = pv && pv.plan && typeof pv.plan === 'object' ? pv.plan : {}, n = (x) => (Array.isArray(x) ? x.length : 0);
        return `Import "${short(String(label), 60)}" as a new company (${count(n(pl.agentPlans), 'employee')}, ${count(n(pl.projectPlans), 'project')}, ${count(n(pl.issuePlans), 'task')}; routines start paused)`;
      },
      summary: `Import "${short(String(label), 60)}" as a new company`,
    };
  },
    // Company settings (#213): name, description and whether a new employee needs the board's approval. One PATCH of the connected company.
    update(b) {
      const body = {};
      if (b.name !== undefined) body.name = textOf(b.name, 'company name', NAME_MAX, { required: true });
      if (b.description !== undefined) body.description = textOf(b.description, 'description', COMPANY_DESC_MAX);
      if (b.requireBoardApprovalForNewAgents !== undefined) {
        if (typeof b.requireBoardApprovalForNewAgents !== 'boolean') throw gridError(400, 'Hire approval must be on or off.');
        body.requireBoardApprovalForNewAgents = b.requireBoardApprovalForNewAgents;
      }
      if (!Object.keys(body).length) throw gridError(400, 'Give a setting to change.');
      const what = [body.name !== undefined && 'name', body.description !== undefined && 'description', body.requireBoardApprovalForNewAgents !== undefined && 'hire approval'].filter(Boolean).join(', ');
      return { method: 'PATCH', path: (co) => `/api/companies/${encodeURIComponent(co)}`, body, targets: [], summary: `Change the company settings (${what})` };
    },
  },
  // Invites and access (#213, owner only: the page group is the owner's, and the grid's Access cell decides). Each names its invite, join
  // request or member as a target; the writer reads the company's lists and refuses what is not in them. The answer carries an id, never
  // the invite token or link: a link that lets people in stays in Paperclip.
  access: {
    invite(b) {
      const join = b.allowedJoinTypes === undefined || b.allowedJoinTypes === null ? 'both' : b.allowedJoinTypes;
      if (!JOIN_TYPES.includes(join)) throw gridError(400, 'Choose who may join: people, agents or both.');
      const body = { allowedJoinTypes: join };
      if (b.humanRole !== undefined && b.humanRole !== null && b.humanRole !== '') {
        if (!HUMAN_ROLES.includes(b.humanRole) || b.humanRole === 'owner') throw gridError(400, 'Choose a role: admin, operator or viewer.');
        body.humanRole = b.humanRole;
      }
      const message = textOf(b.agentMessage, 'message', 1000);
      if (message) body.agentMessage = message;
      const who = { human: 'people', agent: 'agents', both: 'people and agents' }[join];
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/invites`, body, targets: [], summary: `Create an invite for ${who}${body.humanRole ? ` as ${body.humanRole}` : ''}` };
    },
    revoke(b) {
      const invite = idOf(b.invite, 'invite');
      return { method: 'POST', path: () => `/api/invites/${invite}/revoke`, body: {}, targets: [{ type: 'invite', id: invite }], summary: 'Revoke an invite' };
    },
    approveJoin(b) {
      const join = idOf(b.join, 'join request');
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/join-requests/${join}/approve`, body: {}, targets: [{ type: 'join', id: join }], summary: 'Approve a join request' };
    },
    rejectJoin(b) {
      const join = idOf(b.join, 'join request');
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/join-requests/${join}/reject`, body: {}, targets: [{ type: 'join', id: join }], summary: 'Reject a join request' };
    },
    member(b) {
      const member = idOf(b.member, 'member'), body = {};
      if (b.role !== undefined && b.role !== null) { if (!HUMAN_ROLES.includes(b.role)) throw gridError(400, 'Choose a role: owner, admin, operator or viewer.'); body.membershipRole = b.role; }
      if (b.status !== undefined && b.status !== null) { if (!MEMBER_STATUS.includes(b.status)) throw gridError(400, 'Choose a status: pending, active or suspended.'); body.status = b.status; }
      if (!Object.keys(body).length) throw gridError(400, 'Give a role or a status.');
      return { method: 'PATCH', path: (co) => `/api/companies/${encodeURIComponent(co)}/members/${member}`, body, targets: [{ type: 'member', id: member }], summary: `Change the access of a member${body.membershipRole ? ` to ${body.membershipRole}` : ''}${body.status ? ` (${body.status})` : ''}` };
    },
  },
  // Instance and environments (#221, owner only: Paperclip needs an instance admin for each). The office changes only what it can show and
  // undo: the two general settings, one environment's name, description and status, and the instance's default environment. It makes and
  // deletes no environment (a sandbox, an ssh host or a plugin: those hold credentials and leases) and never sends a config or env value.
  instance: {
    general(b) {
      const body = {};
      if (b.censorUsernameInLogs !== undefined) { if (typeof b.censorUsernameInLogs !== 'boolean') throw gridError(400, 'Hiding the user name must be on or off.'); body.censorUsernameInLogs = b.censorUsernameInLogs; }
      if (b.feedbackDataSharingPreference !== undefined) { if (!FEEDBACK_SHARING.includes(b.feedbackDataSharingPreference)) throw gridError(400, 'Choose: allowed, not allowed or ask each time.'); body.feedbackDataSharingPreference = b.feedbackDataSharingPreference; }
      if (!Object.keys(body).length) throw gridError(400, 'Give a setting to change.');
      const what = [body.censorUsernameInLogs !== undefined && 'user name in logs', body.feedbackDataSharingPreference !== undefined && 'feedback sharing'].filter(Boolean).join(', ');
      return { method: 'PATCH', path: () => '/api/instance/settings/general', body, targets: [], summary: `Change the Paperclip instance settings (${what})` };
    },
    defaultEnvironment(b) {
      const none = b.environment === undefined || b.environment === null || b.environment === '';
      const env = none ? null : idOf(b.environment, 'environment');
      return { method: 'PATCH', path: () => '/api/instance/settings', body: { defaultEnvironmentId: env }, targets: env ? [{ type: 'environment', id: env }] : [], summary: env ? 'Set the default environment' : 'Clear the default environment' };
    },
    environment(b) {
      const environment = idOf(b.environment, 'environment'), body = {};
      if (b.name !== undefined) body.name = textOf(b.name, 'environment name', NAME_MAX, { required: true });
      if (b.description !== undefined) body.description = b.description === null ? null : textOf(b.description, 'description', DESC_MAX);
      if (b.status !== undefined) { if (!ENVIRONMENT_STATUS.includes(b.status)) throw gridError(400, 'Choose a status: active or archived.'); body.status = b.status; }
      if (!Object.keys(body).length) throw gridError(400, 'Give something to change.');
      const what = body.status && Object.keys(body).length === 1 ? (body.status === 'archived' ? 'Archive an environment' : 'Restore an environment') : 'Change an environment';
      return { method: 'PATCH', path: () => `/api/environments/${environment}`, body, targets: [{ type: 'environment', id: environment }], summary: what };
    },
  },
  // A reporting line (#202): PATCH { reportsTo } of one agent (manager null: no manager). review(org) reads the org chart the writer holds:
  // a loop, a self report or someone who is not in the company is refused before anything is asked (reportingProblem), and the summary
  // names the two employees for the Confirm and the feed.
  reporting: {
    set(b) {
      const agent = idOf(b.agent, 'employee'), manager = b.manager === undefined || b.manager === null || b.manager === '' ? null : idOf(b.manager, 'manager');
      const targets = [{ type: 'agent', id: agent }];
      if (manager) targets.push({ type: 'agent', id: manager });
      const review = (org) => {
        const problem = reportingProblem(org, agent, manager);
        if (problem) return { problem, status: problem.startsWith('This employee') ? 404 : 400 };
        const nameOf = (id) => short(String((org.find((x) => x.id === id) || {}).name || 'an employee'), 60);
        return { problem: '', summary: manager ? `Make ${nameOf(agent)} report to ${nameOf(manager)}` : `Give ${nameOf(agent)} no manager` };
      };
      return { method: 'PATCH', path: () => `/api/agents/${agent}`, body: { reportsTo: manager }, targets, review, summary: 'Change a reporting line' };
    },
  },
  // Goals (#207): a goal of the company (POST) or a change to one (PATCH). A parent goal and an owner are targets: both must belong to the
  // connected company. A goal cannot be its own parent. An update must change something.
  goal: {
    create(b) {
      const title = textOf(b.title, 'title', TITLE_MAX, { required: true }), description = textOf(b.description, 'description', DESC_MAX);
      const body = { title }, targets = [];
      if (description) body.description = description;
      if (b.level !== undefined && b.level !== null && b.level !== '') { if (!GOAL_LEVELS.includes(b.level)) throw gridError(400, 'Unknown goal level.'); body.level = b.level; }
      if (b.status !== undefined && b.status !== null && b.status !== '') { if (!GOAL_STATUSES.includes(b.status)) throw gridError(400, 'Unknown goal status.'); body.status = b.status; }
      if (b.parent !== undefined && b.parent !== null && b.parent !== '') { body.parentId = idOf(b.parent, 'parent goal'); targets.push({ type: 'goal', id: body.parentId }); }
      if (b.owner !== undefined && b.owner !== null && b.owner !== '') { body.ownerAgentId = idOf(b.owner, 'owner'); targets.push({ type: 'agent', id: body.ownerAgentId }); }
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/goals`, body, targets, summary: `Create the goal "${short(title)}"` };
    },
    update(b) {
      const goal = idOf(b.goal, 'goal'), body = {}, targets = [{ type: 'goal', id: goal }];
      if (b.title !== undefined) body.title = textOf(b.title, 'title', TITLE_MAX, { required: true });
      if (b.description !== undefined) body.description = textOf(b.description, 'description', DESC_MAX);
      if (b.status !== undefined) { if (!GOAL_STATUSES.includes(b.status)) throw gridError(400, 'Unknown goal status.'); body.status = b.status; }
      if (b.owner !== undefined) {
        if (b.owner === null || b.owner === '') body.ownerAgentId = null;
        else { body.ownerAgentId = idOf(b.owner, 'owner'); targets.push({ type: 'agent', id: body.ownerAgentId }); }
      }
      if (!Object.keys(body).length) throw gridError(400, 'Give something to change.');
      const what = body.status && Object.keys(body).length === 1 ? `Mark a goal ${body.status}` : 'Change a goal';
      return { method: 'PATCH', path: () => `/api/goals/${goal}`, body, targets, summary: what };
    },
  },
  // Routines (#209): create, edit (title, description, employee, status), change the schedule of one trigger (a cron line) and run now. The
  // routine and trigger must be in the connected company (the writer checks them against what it holds). Run is one POST with no body.
  routine: {
    create(b) {
      const title = textOf(b.title, 'title', TITLE_MAX, { required: true }), description = textOf(b.description, 'description', DESC_MAX);
      const body = { title }, targets = [];
      if (description) body.description = description;
      if (b.agent !== undefined && b.agent !== null && b.agent !== '') { body.assigneeAgentId = idOf(b.agent, 'employee'); targets.push({ type: 'agent', id: body.assigneeAgentId }); }
      if (b.status !== undefined && b.status !== null) { if (!ROUTINE_STATUS.includes(b.status) || b.status === 'archived') throw gridError(400, 'Unknown routine status.'); body.status = b.status; }
      if (b.project !== undefined && b.project !== null && b.project !== '') body.projectId = idOf(b.project, 'project');
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/routines`, body, targets, summary: `Create the routine "${short(title)}"` };
    },
    update(b) {
      const routine = idOf(b.routine, 'routine'), body = {}, targets = [{ type: 'routine', id: routine }];
      if (b.title !== undefined) body.title = textOf(b.title, 'title', TITLE_MAX, { required: true });
      if (b.description !== undefined) body.description = textOf(b.description, 'description', DESC_MAX);
      if (b.agent !== undefined) { if (b.agent === null || b.agent === '') body.assigneeAgentId = null; else { body.assigneeAgentId = idOf(b.agent, 'employee'); targets.push({ type: 'agent', id: body.assigneeAgentId }); } }
      if (b.status !== undefined) { if (!ROUTINE_STATUS.includes(b.status)) throw gridError(400, 'Unknown routine status.'); body.status = b.status; }
      if (!Object.keys(body).length) throw gridError(400, 'Give a change for the routine.');
      return { method: 'PATCH', path: () => `/api/routines/${routine}`, body, targets, summary: 'Change a routine' };
    },
    schedule(b) {
      const routine = idOf(b.routine, 'routine'), trigger = idOf(b.trigger, 'schedule'), cron = textOf(b.cron, 'schedule', 100, { required: true });
      if (!CRON_RE.test(cron) || cron.split(/\s+/).length !== 5) throw gridError(400, 'Give the schedule as five cron fields, for example 0 9 * * 1.');
      const body = { cronExpression: cron.split(/\s+/).join(' ') };
      if (b.timezone !== undefined && b.timezone !== null && b.timezone !== '') { if (typeof b.timezone !== 'string' || !TZ_RE.test(b.timezone)) throw gridError(400, 'Give a time zone such as UTC or Europe/Berlin.'); body.timezone = b.timezone; }
      return { method: 'PATCH', path: () => `/api/routine-triggers/${trigger}`, body, targets: [{ type: 'trigger', id: trigger, routine }], summary: 'Change the schedule of a routine' };
    },
    run(b) {
      const routine = idOf(b.routine, 'routine');
      return { method: 'POST', path: () => `/api/routines/${routine}/run`, body: {}, targets: [{ type: 'routine', id: routine }], summary: 'Run a routine now' };
    },
  },
  approval: Object.fromEntries([decision('approve', 'approve', 'Approve an approval'), decision('reject', 'reject', 'Reject an approval'), decision('revise', 'request-revision', 'Request a revision of an approval')]),
};
export function planWrite(b) {
  const kind = b && b.kind, action = b && b.action;
  const row = typeof kind === 'string' && Object.hasOwn(PLANS, kind) ? PLANS[kind] : null;
  const make = row && typeof action === 'string' && Object.hasOwn(row, action) ? row[action] : null;
  if (!make) throw gridError(400, 'The office cannot make that write.');
  return { kind, action, ...make(b) };
}

// ---------- goals (#207) ----------
const GOAL_DEPTH = 6;
/**
 * The goals of the company as a tree for the executive floor: parents before their children, siblings in the order Paperclip gave, each row
 * with its depth (capped), its owner's name and how many goals sit under it. A goal whose parent is not in the list is a root. Loop-safe and
 * never drops a goal. goals: [{ id, title, status, level, description, parentId, ownerAgentId }]|null (null: unknown), agents: [{ id, name }].
 * out: { total, rows: [{ id, title, status, level, description, parentId, ownerId, owner, depth, children }] }|null.
 */
export function goalsOf(goals, agents) {
  if (!goals) return null;
  const ids = new Set(goals.map((g) => g.id)), kids = new Map(), roots = [], who = new Map((agents || []).map((a) => [a.id, a.name]));
  for (const g of goals) {
    if (g.parentId && g.parentId !== g.id && ids.has(g.parentId)) { if (!kids.has(g.parentId)) kids.set(g.parentId, []); kids.get(g.parentId).push(g); } else roots.push(g);
  }
  const rows = [], seen = new Set();
  const walk = (g, depth) => {
    if (seen.has(g.id)) return;
    seen.add(g.id);
    rows.push({ id: g.id, title: g.title, status: g.status, level: g.level || '', description: g.description || '', parentId: g.parentId && ids.has(g.parentId) ? g.parentId : null,
      ownerId: g.ownerAgentId || null, owner: g.ownerAgentId ? (who.get(g.ownerAgentId) || '') : '', depth: Math.min(depth, GOAL_DEPTH), children: (kids.get(g.id) || []).length });
    for (const k of kids.get(g.id) || []) walk(k, depth + 1);
  };
  for (const g of roots) walk(g, 0);
  for (const g of goals) walk(g, 0);   // a loop has no root: still shown
  return { total: goals.length, rows };
}

// ---------- skills, secrets, plugins and adapters (#212) ----------
/**
 * The catalog: what Paperclip has installed for the company, as names and states only. A secret is its name and provider, never a value
 * (the value, if Paperclip sends one, is dropped here); a skill is its name, description and where it came from, never its files.
 * A part the office could not read is null (unknown, never an empty list that looks real).
 * in: { skills, secrets, plugins, adapters } (each the answer of its route, or null). out: the same four keys, shaped.
 */
export function catalogOf(i) {
  const rows = (v) => (Array.isArray(v) ? v.filter((r) => r && typeof r === 'object') : null);
  const t = (v, n) => (typeof v === 'string' ? short(v.trim(), n) : '');
  const skills = rows(i.skills), secrets = rows(i.secrets), plugins = rows(i.plugins), adapters = rows(i.adapters);
  return {
    skills: skills && skills.filter((r) => r.id).slice(0, 200).map((r) => ({ id: String(r.id), key: t(r.key, 100), name: t(r.name, 80) || t(r.key, 80), description: t(r.description, 200), source: t(r.sourceType, 30), trust: t(r.trustLevel, 30) })),
    secrets: secrets && secrets.filter((r) => r.id && r.name).slice(0, 200).map((r) => ({ id: String(r.id), name: t(r.name, 60), provider: t(r.provider, 40) })),
    plugins: plugins && plugins.filter((r) => r.id).slice(0, 100).map((r) => ({ id: String(r.id), name: t(r.pluginKey, 100) || t(r.packageName, 100), version: t(r.version, 30), status: t(r.status, 30), error: t(r.lastError, 200) })),
    adapters: adapters && adapters.filter((r) => r.type).slice(0, 100).map((r) => ({ type: t(r.type, 60), label: t(r.label, 60) || t(r.type, 60), source: t(r.source, 20), version: t(r.version, 30), loaded: r.loaded !== false, disabled: r.disabled === true })),
  };
}

// ---------- the Costs view (#208) ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const byCost = (x, y) => (y.cost || 0) - (x.cost || 0) || String(x.name).localeCompare(String(y.name));
/** The UTC months the Costs view reads, newest first: [{ key: '2026-11', from, to }] (to is the first instant of the next month). */
export function monthWindows(now, n = 3) {
  const d = new Date(now), out = [];
  for (let i = 0; i < n; i++) {
    const a = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)), b = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 1));
    out.push({ key: `${a.getUTCFullYear()}-${String(a.getUTCMonth() + 1).padStart(2, '0')}`, from: a.toISOString(), to: b.toISOString() });
  }
  return out;
}
/**
 * The Costs view: spend per agent and per project for each month, and the budgets. Unknown stays unknown: a part the office could not
 * read is null (never a zero that looks real), a row with no cost number has cost null and makes its month's total partial.
 * in: { months: [{ key, agents: [{ id, name, cost: dollars|null }]|null, projects: [...]|null }],
 *   budgets: { policies: [{ id, scope, name, metric, limit, used, percent, status, paused }], paused: number|null }|null }.
 * out: { months: [{ key, label, total: dollars|null, partial, agents, projects }], budgets: [...]|null, pausedAgents }.
 */
export function costsOf(i) {
  const side = (rows) => {
    if (!rows) return { rows: null, total: null, partial: false };
    const sorted = rows.slice().sort(byCost);
    return { rows: sorted, total: sorted.reduce((t, r) => t + (r.cost || 0), 0), partial: sorted.some((r) => r.cost == null) };
  };
  const months = i.months.map((m) => {
    const a = side(m.agents), p = side(m.projects);
    // The agent cut is the company's spend; the project cut is a second cut of the same money, so it is the fallback for the total.
    const t = a.rows ? a : p;
    const [y, mo] = m.key.split('-');
    return { key: m.key, label: `${MONTHS[+mo - 1] || m.key} ${y}`, total: t.total == null ? null : Math.round(t.total * 100) / 100, partial: t.partial, agents: a.rows, projects: p.rows };
  });
  const b = i.budgets;
  return { months, budgets: b ? b.policies.slice().sort((x, y) => (y.percent ?? -1) - (x.percent ?? -1)) : null, pausedAgents: b ? b.paused : null };
}

// ---------- the search index (#214) ----------
export const SEARCH_CAPS = { task: 60, goal: 30, approval: 20, routine: 30 };
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const words = (n, one) => `${n} ${n === 1 ? one : one + 's'}`;
/**
 * What Ctrl+K searches in Paperclip: one entry per employee, floor, open task, goal, pending approval and routine, with the words the user
 * types (label) and a hint that says where it is. Names, titles and statuses only, never a payload, a value or a key. Capped per kind
 * (SEARCH_CAPS; employees and floors are never cut), so the snapshot stays small. in: { agents (views), floors, issues, goals, approvals, routines }.
 * Entry: { kind: 'employee'|'floor'|'task'|'goal'|'approval'|'routine', id, label, hint }. The page opens the HQ at the entry (kind and id).
 */
export function searchOf(i) {
  const name = (id) => (i.agents.find((a) => a.id === id) || {}).name || '';
  const out = [];
  for (const f of i.floors || []) if (f.key !== 'records' && (f.key === 'lobby' || f.employees.length)) out.push({ kind: 'floor', id: f.key, label: f.name, hint: f.key === 'lobby' ? 'Floor of the HQ' : `Floor of the HQ, ${words(f.employees.length, 'employee')}` });
  for (const a of i.agents) out.push({ kind: 'employee', id: a.id, label: a.name, hint: [clip(a.title || a.role, 40), a.task ? clip(a.task.title, 50) : ''].filter(Boolean).join(' · ') });
  for (const x of (i.issues || []).filter((t) => t && t.id && t.title).slice(0, SEARCH_CAPS.task)) out.push({ kind: 'task', id: String(x.id), label: `${x.identifier ? clip(x.identifier, 30) + ' ' : ''}${clip(x.title, 100)}`, hint: ['Task', clip(x.status, 30).replace(/_/g, ' '), name(x.assigneeAgentId)].filter(Boolean).join(' · ') });
  for (const g of (i.goals || []).slice(0, SEARCH_CAPS.goal)) out.push({ kind: 'goal', id: g.id, label: g.title, hint: ['Goal', g.status].filter(Boolean).join(' · ') });
  for (const p of (i.approvals || []).slice(0, SEARCH_CAPS.approval)) out.push({ kind: 'approval', id: p.id, label: `Approval: ${String(p.type).replace(/_/g, ' ')}`, hint: ['Approval', name(p.requestedByAgentId) ? 'from ' + name(p.requestedByAgentId) : '', p.status].filter(Boolean).join(' · ') });
  for (const r of (i.routines || []).slice(0, SEARCH_CAPS.routine)) out.push({ kind: 'routine', id: r.id, label: r.title, hint: ['Routine', r.agent ? 'for ' + r.agent : '', r.status].filter(Boolean).join(' · ') });
  return out;
}

// ---------- projects and workspaces as rooms (#211) ----------
const OPEN_RANK = { in_progress: 0, in_review: 1, blocked: 2, todo: 3, backlog: 4 };
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
/**
 * The rooms of the HQ: one per Paperclip project, with its workspaces and the employees who work in it. A Paperclip workspace is the
 * room its employee works in. An employee sits in the room of its best open task (in progress first, then review, blocked, todo,
 * backlog), in the workspace the task names, else the project's primary one. An employee with no open task in a project is in no room.
 * Reads tolerantly (a Paperclip that has no workspaces on a project gives none) and never invents a folder: a workspace with no `cwd`
 * has folder null. projects, issues: Paperclip lists or null; agents: [{ id, name }]. Never throws.
 */
export function roomsOf({ projects, agents, issues }) {
  if (!Array.isArray(projects)) return [];
  const rooms = new Map();
  for (const p of projects) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) continue;
    const workspaces = (Array.isArray(p.workspaces) ? p.workspaces : []).filter((w) => w && typeof w === 'object' && typeof w.id === 'string' && w.id)
      .map((w) => ({ id: w.id, name: str(w.name, 80) || w.id, folder: str(w.cwd, 260) || null, primary: w.isPrimary === true }));
    rooms.set(p.id, { id: p.id, name: str(p.name, 80) || p.id, status: str(p.status, 40) || null, workspaces, employees: [] });
  }
  const best = new Map(); // agent id -> { rank, issue }
  for (const i of Array.isArray(issues) ? issues : []) {
    if (!i || !i.assigneeAgentId || !rooms.has(i.projectId) || !(i.status in OPEN_RANK)) continue;
    const cur = best.get(i.assigneeAgentId), rank = OPEN_RANK[i.status];
    if (!cur || rank < cur.rank) best.set(i.assigneeAgentId, { rank, issue: i });
  }
  for (const a of Array.isArray(agents) ? agents : []) {
    const b = a && best.get(a.id);
    if (!b) continue;
    const room = rooms.get(b.issue.projectId);
    const ws = room.workspaces.find((w) => w.id === b.issue.projectWorkspaceId) || room.workspaces.find((w) => w.primary) || null;
    room.employees.push({ id: a.id, name: str(a.name, 80) || a.id, workspace: ws ? ws.name : null });
  }
  return [...rooms.values()];
}
