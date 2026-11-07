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
// (add) and approval (approve, reject, revise). Another kind in the grid has no plan yet, and is 400 (never sent).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ISSUE_STATUS = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
const TITLE_MAX = 200, TEXT_MAX = 10000, NOTE_MAX = 2000, DESC_MAX = 4000;
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
const PLANS = {
  task: {
    create(b) {
      const title = textOf(b.title, 'title', TITLE_MAX, { required: true }), description = textOf(b.description, 'description', DESC_MAX);
      const body = { title };
      if (description) body.description = description;
      if (b.status !== undefined && b.status !== null) { if (!ISSUE_STATUS.includes(b.status)) throw gridError(400, 'Unknown task status.'); body.status = b.status; }
      const targets = [];
      if (b.assigneeAgentId !== undefined && b.assigneeAgentId !== null) { body.assigneeAgentId = idOf(b.assigneeAgentId, 'agent'); targets.push({ type: 'agent', id: body.assigneeAgentId }); }
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/issues`, body, targets, summary: `Create the task "${short(title)}"` };
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
  approval: Object.fromEntries([decision('approve', 'approve', 'Approve an approval'), decision('reject', 'reject', 'Reject an approval'), decision('revise', 'request-revision', 'Request a revision of an approval')]),
};
export function planWrite(b) {
  const kind = b && b.kind, action = b && b.action;
  const row = typeof kind === 'string' && Object.hasOwn(PLANS, kind) ? PLANS[kind] : null;
  const make = row && typeof action === 'string' && Object.hasOwn(row, action) ? row[action] : null;
  if (!make) throw gridError(400, 'The office cannot make that write.');
  return { kind, action, ...make(b) };
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
