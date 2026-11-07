// Office Managers as Paperclip employees (#204, spec #191, ADR 0010): the bridge between the Manager (manager.mjs, the rules of a goal) and the
// HQ (paperclip.mjs, the one writer). A distinct job, so its own file: manager.mjs knows nothing of Paperclip and paperclip.mjs nothing of goals.
// `createManagerEmployees({ hq, manager, state, feed, now })` gives `register`, `list` and `sync`.
//   register({ building, name, budgetDollars, confirmed })
//                                            hire the Manager as a Paperclip employee through the one hire plan (hq.write, kind hire, action
//                                            create, officeManager: true: the Project manager role, since Paperclip has no 'manager' role, the
//                                            office adapter and a monthly budget like every hire; the write grid's Hires cell decides, Confirm by
//                                            default), and keep it as the Manager of that building.
//   list()                                   the Managers of the connected company.
//   sync()                                   a task assigned to a registered Manager becomes an office goal in its building; each step of the
//                                            goal is a sub-issue of that task; a step's state moves its sub-issue; the result is a comment on
//                                            the task, and a finished goal sets the task to done. Every write is hq.write (the one writer), so
//                                            the write grid decides it: a cell set to Deny or Confirm leaves the write undone and says so once.
// The hire plan (hq-model.mjs): `hq.write` kind `hire`, action `create` with `officeManager: true` sends `POST /agent-hires` with role `pm`
// (`MANAGER_ROLE`: Paperclip's `AGENT_ROLES` enum has no `manager`, so `manager` would be a 400 of its validator), title `MANAGER_TITLE`,
// `adapterConfig.manager: true`, isolation `same`, and a monthly budget (400 without one, as for every hire, ADR 0010). One Manager per
// building and company. The office knows its Managers from the `managers` slice, never from the role.
// sync() is single flight (`office.mjs` `managerSync` calls it from `broadcast()`). A task of the connected company assigned to a
// registered Manager (`hq.tasksOf(id)`: open tasks, null while not connected or the list is unread or cut; sub-tasks and tasks with a
// goal are skipped) becomes `manager.submit(building, goalTextOf(task), { approveFirst: true, paperclip: { task, ... } })` and is set in
// progress. Each step is a sub-issue (task create with `parentId`, assigned to nobody) kept in `g.paperclip.subs`; a step's state moves
// its sub-issue (`pushed`); an ended goal gets one result comment on the task (`reported`). A Confirm or Deny leaves the report undone,
// with one feed line and a 30 s wait. Nothing here sends a request itself.
// The goal keeps `g.paperclip` (`manager.mjs cleanLink`, saved, restored, in the snapshot and the plan board as `task`;
// `OfficeVocab.plan.fromTask`).
// The quick office goal (POST /api/goal/start) does not pass through here, so it works with no Paperclip at all. One Manager board shows both
// (the plan board, manager.mjs createPlanBoard). Nothing here holds the board key: it only calls hq.write and reads hq.tasksOf.
// Saved as the slice `managers` (`cleanManagers`): { [employee id]: { building, name, company } }.
// Not yet: the Manager does not run its own Paperclip runs through the office adapter (the plan comes from the task, the adapter is
// registered for it).
// Tested in test/manager-employees.test.mjs and test/manager-employees-routes.test.mjs.

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const STEP_TO_TASK = { pending: 'backlog', working: 'in_progress', finished: 'done', error: 'blocked' };
const END = new Set(['finished', 'failed', 'stopped', 'cancelled', 'blocked', 'handed-off', 'handoff-failed']);
const RETRY_MS = 30000;   // after a refused write the same goal waits before it tries again

/** The saved slice: only records with a plain id, a building and a company. */
export function cleanManagers(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, r] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !r || typeof r !== 'object' || typeof r.building !== 'string' || typeof r.company !== 'string' || !r.company) continue;
    out[id] = { building: r.building, name: clip(r.name || 'Manager', 80), company: r.company };
  }
  return out;
}

/** The text a goal is made from: the task's own lines (one step per line), else its title. */
export const goalTextOf = (t) => (t.description && t.description.trim() ? t.description.trim() : t.title);

/** The result for the task: the goal's end, then one line per step. */
function resultText(g) {
  const lines = g.steps.map((s) => `${s.status === 'finished' ? '[x]' : s.status === 'error' ? '[!]' : '[ ]'} ${clip(s.text, 200)}${s.result ? `: ${clip(s.result, 200)}` : ''}`);
  const head = g.status === 'finished' ? 'The Manager finished this task.' : `The Manager stopped with the goal ${g.status}.${g.reason ? ` ${clip(g.reason, 200)}` : ''}`;
  return [head, ...lines].join('\n');
}

/**
 * createManagerEmployees({ hq, manager, state, feed, now? })
 * hq: { write, tasksOf, view }; manager: the Manager of manager.mjs (submit, snapshot, get, link); state: { get(key), set(key, value), save() };
 * feed(text): a line in the office feed; now(): the clock.
 */
export function createManagerEmployees({ hq, manager, state, feed = () => {}, now = Date.now }) {
  const records = () => cleanManagers(state.get('managers'));
  const wait = new Map();   // goal id -> time before which it does not try its writes again
  let running = false, again = false;

  /**
   * Hire the Manager of a building as a Paperclip employee. Resolves { ok, id, building, pendingApproval }; the writer's errors (400 for no
   * budget, 403, 409 ask-first, 502) pass through.
   */
  async function register({ building, name, budgetDollars, confirmed = false } = {}) {
    const b = typeof building === 'string' ? building : '';
    if (!b) { const e = new Error('Say which building this Manager works in.'); e.status = 400; throw e; }
    const company = hq.view()?.company;
    if (!company) { const e = new Error('Paperclip is not connected, so there is no company to hire the Manager into.'); e.status = 409; throw e; }
    const have = Object.entries(records()).find(([, r]) => r.building === b && r.company === company.id);
    if (have) { const e = new Error('This building already has a Manager in Paperclip.'); e.status = 409; throw e; }
    const who = typeof name === 'string' && name.trim() ? name.trim() : 'Manager';
    const made = await hq.write({ kind: 'hire', action: 'create', officeManager: true, name: who, agentKind: 'claude-code', isolation: 'same', budgetDollars }, { confirmed });
    const next = records();
    next[made.id] = { building: b, name: clip(who, 80), company: company.id };
    state.set('managers', next); state.save();
    feed(`The Manager of this building now works in ${company.name} as an employee.${made.pendingApproval ? ' Paperclip waits for the board to approve the hire.' : ''}`);
    return { ok: true, id: made.id, building: b, pendingApproval: made.pendingApproval === true };
  }

  /** The Managers of the connected company, for the page: [{ id, name, building }]. */
  function list() {
    const co = hq.view()?.company;
    return Object.entries(records()).filter(([, r]) => co && r.company === co.id).map(([id, r]) => ({ id, name: r.name, building: r.building }));
  }

  // One write of the sync: never throws. A refusal (the grid says Deny or Confirm, Paperclip failed) keeps the goal from trying again for 30 s.
  async function put(g, body) {
    try { return await hq.write(body, { confirmed: false }); }
    catch (e) {
      wait.set(g.id, now() + RETRY_MS);
      if (!(e.answer && e.answer.body && e.answer.body.confirm)) feed(`The Manager could not report to Paperclip: ${clip(e.message, 160)}`);
      else feed('The Manager has a result for Paperclip, but the write grid asks first for tasks. Set Tasks to Allow so it can report.');
      return null;
    }
  }

  async function mirror(g) {
    const p = g.paperclip;
    if (!p || !p.task || (wait.get(g.id) || 0) > now()) return;
    // a sub-issue for each step: made once, its id kept on the goal
    for (const s of g.steps) {
      if (p.subs[s.id]) continue;
      const r = await put(g, { kind: 'task', action: 'create', title: clip(s.text, 200), description: `Agent Office goal ${g.id} step ${s.id}`, status: 'backlog', parentId: p.task });
      if (!r) return;
      manager.link(g.id, { subs: { [s.id]: r.id }, pushed: { [s.id]: 'backlog' } });
    }
    const cur = manager.get(g.id);
    for (const s of cur.steps) {
      const want = STEP_TO_TASK[s.status] || 'backlog', sub = cur.paperclip.subs[s.id];
      if (!sub || cur.paperclip.pushed[s.id] === want) continue;
      const r = await put(g, { kind: 'task', action: 'status', issue: sub, status: want });
      if (!r) return;
      manager.link(g.id, { pushed: { [s.id]: want } });
    }
    // the result: once for each end state, as a comment on the task (and done for a finished goal)
    const end = manager.get(g.id);
    if (END.has(end.status) && end.paperclip.reported !== end.status) {
      if (!await put(g, { kind: 'comment', action: 'add', issue: p.task, text: resultText(end) })) return;
      if (end.status === 'finished' && !await put(g, { kind: 'task', action: 'status', issue: p.task, status: 'done' })) return;
      manager.link(g.id, { reported: end.status });
    }
  }

  async function pass() {
    const co = hq.view()?.company;
    if (!co) return;
    const known = new Set(manager.snapshot().filter((g) => g.paperclip).map((g) => g.paperclip.task));
    // a task assigned to a Manager becomes a goal in its building (once: a task with a goal, even a finished one, is never made again)
    for (const [id, r] of Object.entries(records())) {
      if (r.company !== co.id) continue;
      const got = hq.tasksOf(id);
      if (!got || got.company !== co.id) continue;
      for (const t of got.tasks) {
        if (known.has(t.id) || t.parentId) continue;
        known.add(t.id);
        let gid;
        try {
          gid = await manager.submit(r.building, goalTextOf(t), { approveFirst: true, paperclip: { task: t.id, identifier: t.identifier, title: t.title, company: co.id, employee: id } });
        } catch (e) { feed(`The Manager could not take the task ${t.identifier || t.title}: ${clip(e.message, 160)}`); continue; }
        feed(`The Manager of ${r.name} took the task ${t.identifier ? `${t.identifier} ` : ''}"${clip(t.title, 60)}" as the goal ${gid}.`);
        if (t.status !== 'in_progress') await put(manager.get(gid), { kind: 'task', action: 'status', issue: t.id, status: 'in_progress' });
      }
    }
    for (const g of manager.snapshot()) {
      if (!g.paperclip || g.paperclip.company !== co.id) continue;
      await mirror(manager.get(g.id));
    }
  }

  /** Look at the HQ and the goals once; a call while one runs asks for one more pass. Resolves when no pass is left. */
  async function sync() {
    if (running) { again = true; return; }
    if (!Object.keys(records()).length && !manager.snapshot().some((g) => g.paperclip)) return;
    running = true;
    try {
      do { again = false; try { await pass(); } catch (e) { feed(`The Manager could not sync with Paperclip: ${clip(e && e.message, 160)}`); } } while (again);
    } finally { running = false; }
  }

  return { register, list, sync };
}
