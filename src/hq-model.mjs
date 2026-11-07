// The HQ read model, the pure part (#197, spec #191): the org chart as the floors of the HQ building, the Lobby dashboard, and the
// contract of the Paperclip API shapes the office reads. paperclip.mjs holds the connection and reads; this module only shapes what it
// read. No I/O, no clock. Tested in test/hq-model.test.mjs against test/fixtures/paperclip-shapes.json (the recorded shapes).

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
