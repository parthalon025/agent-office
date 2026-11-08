// The HQ read model, the pure part (#197, spec #191): the org chart as the floors of the HQ building, the Lobby dashboard, and the
// contract of the Paperclip API shapes the office reads. paperclip.mjs holds the connection and reads; this module only shapes what it
// read. The write kinds (the write grid and the request of each write) are in src/hq-writes/ (#232); self-approval (#203) and the office
// adapter state (#222) stay here. No I/O, no clock. Tested in test/hq-model.test.mjs against test/fixtures/paperclip-shapes.json (the recorded shapes).
//
// Read model (the views the page shows; each is `view().<name>` of paperclip.mjs unless said). A null is unknown, never a zero that
// looks real.
// - floorsOf(agents): the org chart as the floors of the HQ building, bottom to top: Records, Lobby, then one floor per reporting rank,
//   the top role on top. Loop-safe, depth capped at 8, no employee lost.
// - cablesOf(agents): one cable per reporting line whose manager is in the chart; none for a self report, a ghost manager or a loop.
//   reportingProblem(agents, id, managerId) says why a reporting line change is refused: unknown employee or manager, self, loop (#202).
// - lobbyOf(...): the dashboard counts and short lists.
// - inboxOf({ agents, issues, approvals }) (#210): what Paperclip holds for the user, as items of the one queue: each pending
//   approval, then each open task with a person assignee (assigneeUserId), oldest first, capped at INBOX_CAP. Names only, never a
//   payload. Null when neither list was read. It is `view().inbox`. An approval item also carries `approval`, the plain id the page
//   sends to hq.write (never the queue id). public/building.js hqRequests makes them requests of kind `paperclip` (id hq:..., no uid),
//   so they count in Needs you, the queue, the alerts and the tab title. An approval is decided in that list and in the HQ lobby.
//   A task row stays Open Paperclip HQ. Neither opens a desk. Tested in test/hq-inbox.test.mjs, test/building.test.mjs and
//   test/approval-desk.test.mjs.
// - searchOf(...) (the Ctrl+K index, #214): one entry per employee, floor, open task, goal, pending approval and routine, names and
//   statuses only, capped per kind by SEARCH_CAPS. It is `view().search`. The page turns it into palette actions with
//   OfficeVocab.hq.searchItems, and a pick opens the HQ dialog with focus: { kind, id }: a found card, and the row of an employee,
//   floor or routine marked and scrolled into view. Tested in test/hq-search.test.mjs.
// - monthWindows and costsOf (the Costs view, #208): the last three UTC months per agent and per project, and the budgets. A part not
//   read is null; a row with no cost is null and its month total is partial, never $0.00.
// - goalsOf(goals, agents) (#207): the goals as a tree for the executive floor, parents first, depth capped at 6, owner names,
//   children counts. Loop-safe, drops no goal. It is `view().goals`. The snapshot `hq.goalWrite` is false only when the grid says
//   Deny. The page is `Goals` in public/hq.js (the HQ dialog and the Manager board), with its words in OfficeVocab.hq.goals.
// - roomsOf({ projects, agents, issues }) (#211): a project is a room with its workspaces. An employee sits in the room of its best
//   open task and in that task's workspace, else the primary one. The folder is null when Paperclip gives none. It is `view().rooms`,
//   listed in the HQ dialog.
// - catalogOf (#212) keeps names, descriptions, versions and states only (see paperclip.mjs catalog()).
//
// The contract. SHAPES lists the fields of each Paperclip route the office reads (also costsByAgent, costsByProject, budgets; one task
// and one approval included). #213 adds the shapes invites, joinRequests and members. #221 adds instanceSettings, environments,
// exportBundle, importPreview and importResult. shapeOf and shapeProblems check an answer. test/fixtures/paperclip-shapes.json holds
// the recorded shapes of the pinned release: the test fails when a recorded type changes or the office reads a field nobody
// recorded. The shapes follow the Paperclip source, not a live run, so record again against a real pinned Paperclip when the pin
// moves. test/hq-read.test.mjs runs the watcher against the fake.
//
// The write side (#198, ADR 0010) is src/hq-writes/: one file per write kind (its grid row, its requests, what Paperclip must answer and
// the ids it returns), listed in grid order by src/hq-writes/index.mjs, which also has the grid rules (cleanWriteGrid, writeValueOf,
// setWriteCell, gridRows) and planWrite. paperclip.mjs hq.write is the one writer and names no kind. Kept here:
// - Self-approval (ADR 0010). The saved slice is `hqSelfApproval` ({ approvalType: true }). SELF_APPROVAL_KINDS lists the kinds the
//   user may turn on; NEVER_SELF_APPROVED (hire_agent and budget_override_required) are never self-approved. setSelfApproval: turning
//   on is 409 until `confirmed: true`, a never kind is 400. After each read, selfApprove (paperclip.mjs) approves once each pending
//   approval an employee of the company asked for, of a kind that is on, through `write`, so a Deny in the Approvals cell still wins.
//   Routes (page group): GET /api/hq/grid also carries `selfApproval`, and POST /api/hq/self-approval/set { type, value, confirmed }.
// - officeAdapterOf (#222): whether Paperclip has the office adapter, from its adapter list (installed, off, missing, unknown). The
//   writer's `adapter` kind reads it before an install, and the `hire` kind before every hire. OFFICE_ADAPTER_TYPE is its type word.
// - The routes of the grid and the writer are in the header of src/hq-writes/index.mjs; the routes and page parts of each write kind
//   are in the header of its file, and the user side in docs/paperclip.md.
import { ID_RE, short, gridError } from './hq-writes/shared.mjs';

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
  // The answer of POST /api/adapters/install (routes/adapters.ts, 201): the adapter the install loaded. version is left out when the package has none.
  adapterInstall: { list: false, fields: { type: 'string', packageName: 'string', installedAt: 'string', requiresRestart: 'boolean' } },
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
  const link = i.link || (() => null);
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
    approvals: i.approvals ? { pending: i.approvals.length, items: i.approvals.slice(0, 5).map((p) => ({ id: p.id, kind: p.type, by: nameOf(p.requestedByAgentId), approval: typeof p.id === 'string' && ID_RE.test(p.id) ? p.id : null, link: link('approval', p.id) })) } : null,
    goals: i.goals ? { total: i.goals.length, items: i.goals.slice(0, 6).map((g) => ({ id: g.id, title: g.title, status: g.status })) } : null,
    spend: i.costs ? { spent: i.costs.spent, limit: i.costs.limit, percent: pct } : null,
    activity: i.activity,
    secrets: i.secrets ? { count: i.secrets.length, names: i.secrets.slice(0, 20) } : null,
    unread: i.unread || [],
  };
}


// ---------- the link out (#225, story 40 of #191) ----------
// The page of an approval or a task in Paperclip's own web UI: <address>/<issuePrefix>/approvals/<id> and <address>/<issuePrefix>/issues/<id or identifier>.
// Routes from the UI router (ui/src/App.tsx, Paperclip 0.3.1, read from D:\SSD\AI_Tools\paperclip: the pinned server serves the built UI from ui-dist,
// which npm run paperclip:source does not fetch). The company prefix comes first (company.issuePrefix, @paperclipai/shared types/company.d.ts); an
// unprefixed approval path is not routed. Built here so the page holds no Paperclip routing rule. The address is the connected loopback address;
// no key, no query. null: unknown.
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/;
const LINK_PATH = { approval: 'approvals', issue: 'issues' };
export function paperclipLinker(base, prefix) {
  let origin = '';
  try { const u = new URL(String(base || '')); if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password) origin = u.origin; } catch { /* no address */ }
  const pre = typeof prefix === 'string' && PREFIX_RE.test(prefix) ? prefix : '';
  return (kind, id) => {
    const seg = LINK_PATH[kind] || '';
    const t = typeof id === 'string' ? id : '';
    return origin && pre && seg && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(t) ? `${origin}/${pre}/${seg}/${encodeURIComponent(t)}` : null;
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
  const link = i.link || (() => null);
  if (!i.approvals && !i.issues) return null;
  const nameOf = (id) => (i.agents.find((a) => a.id === id) || {}).name || '';
  const out = [];
  for (const p of i.approvals || []) {
    const by = nameOf(p.requestedByAgentId), kind = String(p.type || 'request').replace(/_/g, ' ');
    const raw = typeof p.id === 'string' ? p.id : '';
    out.push({ id: `approval:${raw}`, kind: 'approval', approval: ID_RE.test(raw) ? raw : null, link: link('approval', raw), text: by ? `Approval from ${by}: ${kind}` : `Approval: ${kind}`, by, at: p.at || 0 });
  }
  for (const x of i.issues || []) {
    if (!x || !x.id || !x.assigneeUserId || x.status === 'done' || x.status === 'cancelled') continue;
    const name = [x.identifier, x.title].filter(Boolean).join(' ');
    out.push({ id: `issue:${x.id}`, kind: 'issue', link: link('issue', x.identifier || x.id), text: `Task for you${x.status === 'blocked' ? ' (blocked)' : ''}: ${name || 'untitled'}`, by: '', at: Date.parse(x.updatedAt || x.createdAt || '') || 0 });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, INBOX_CAP);
}

// ---------- the mailroom list (#224) ----------
/**
 * The open tasks of the company for the mailroom: { id, identifier, title, status, assigneeId, assignee, link }, newest first, at most TASKS_CAP.
 * null: the issues were not read (unknown, never an empty list). Names and statuses only: no description, no comment, no payload.
 * in: { link, agents: [agent views], issues: [Paperclip issues]|null }.
 */
export const TASKS_CAP = 50;
export function mailroomOf(i) {
  if (!i.issues) return null;
  const link = i.link || (() => null);
  const nameOf = (id) => (i.agents.find((a) => a.id === id) || {}).name || '';
  const when = (x) => Date.parse(x.updatedAt || x.createdAt || '') || 0;
  return i.issues.filter((x) => x && typeof x.id === 'string' && ID_RE.test(x.id) && x.status !== 'done' && x.status !== 'cancelled')
    .sort((a, b) => when(b) - when(a)).slice(0, TASKS_CAP)
    .map((x) => ({ id: x.id, identifier: clip(x.identifier || '', 30), title: clip(x.title || 'Untitled', 200), status: String(x.status || ''), assigneeId: typeof x.assigneeAgentId === 'string' ? x.assigneeAgentId : '', assignee: nameOf(x.assigneeAgentId), link: link('issue', x.identifier || x.id) }));
}

// ---------- self-approval (#203, ADR 0010) ----------
// An employee may approve its own work only for the approval kinds the user allows here. Paperclip's approval types (APPROVAL_TYPES of the
// pinned release): hire_agent and budget_override_required are the hire and the budget, so they are never self-approvable; access and
// secrets are not approval types at all. The saved slice holds the kinds the user turned on: { approval_type: true }.
export const SELF_APPROVAL_KINDS = [
  { type: 'request_board_approval', label: 'Request for the board', text: 'A request the employee makes of the board, for example a plan.' },
  { type: 'approve_ceo_strategy', label: 'Strategy of the chief', text: 'The strategy the top employee proposes.' },
];
export const NEVER_SELF_APPROVED = ['hire_agent', 'budget_override_required'];
const selfKind = (t) => (typeof t === 'string' && SELF_APPROVAL_KINDS.some((k) => k.type === t) ? t : null);
export function cleanSelfApproval(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of SELF_APPROVAL_KINDS) if (Object.hasOwn(raw, k.type) && raw[k.type] === true) out[k.type] = true;
  return out;
}
export const selfApprovalOn = (slice, type) => !!selfKind(type) && !!slice && typeof slice === 'object' && Object.hasOwn(slice, type) && slice[type] === true;
/** One change: { type, value: true|false, confirmed }. Turning it on is looser (409 until confirmed: true); a never-self kind is 400. Returns { slice, from, to }. */
export function setSelfApproval(slice, change) {
  const type = change && change.type;
  if (NEVER_SELF_APPROVED.includes(type)) throw gridError(400, 'An employee never approves this kind itself. It stays with you.');
  if (!selfKind(type)) throw gridError(400, 'Unknown approval kind.');
  if (typeof change.value !== 'boolean') throw gridError(400, 'Self-approval is on or off.');
  const from = selfApprovalOn(slice, type);
  if (change.value && !from && change.confirmed !== true) throw gridError(409, 'Confirm the looser rule first.');
  const next = { ...cleanSelfApproval(slice) };
  if (change.value) next[type] = true; else delete next[type];
  return { slice: next, from, to: change.value };
}

// ---------- the office adapter (#222) ----------
export const OFFICE_ADAPTER_TYPE = 'agent_office';   // the word of OFFICE_ADAPTER in paperclip.mjs (which imports this module)

/**
 * Whether Paperclip has the office adapter (#222), from the adapter list it answers (rows: the shaped rows, or null when the list was not
 * read). { state: 'installed' | 'off' | 'missing' | 'unknown', why }. Only 'installed' lets a hire go: Paperclip refuses a hire for an
 * adapter type it does not have (routes/agents.ts assertKnownAdapterType) and a disabled adapter takes no run. Pure.
 */
export function officeAdapterOf(rows) {
  if (!Array.isArray(rows)) return { state: 'unknown', why: 'The office cannot read the adapter list of Paperclip.' };
  const r = rows.find((x) => x && x.type === OFFICE_ADAPTER_TYPE);
  if (!r) return { state: 'missing', why: 'Paperclip does not have the office adapter yet. Install it at the HQ first. Then hire.' };
  if (r.disabled) return { state: 'off', why: 'Paperclip has the office adapter switched off. Switch it on in Paperclip. Then hire.' };
  return { state: 'installed', why: '' };
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
