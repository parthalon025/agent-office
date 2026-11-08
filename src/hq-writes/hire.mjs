// Write kind `hire` (#201, ADR 0010): POST /api/companies/:id/agent-hires with the office adapter (adapterType agent_office: its runs are
// office sessions of its agent kind, so the employee is as supervised as that kind, ADR 0001, paperclip.mjs supervisionOf), adapterConfig
// { agentKind, isolation, model? }, a monthly budget in whole cents from budgetDollars (a missing, zero or non-number budget is 400 before
// anything is asked; at most HIRE_BUDGET_MAX), the role from the role cards only (HIRE_ROLES, so the writer never sends a role Paperclip
// does not know) and skills as names. Nothing else the office has not named.
// - review(org, { kindOf }) names the manager and the agent kind's supervision in the Confirm (role, manager, kind and supervision, model,
//   budget, skills, and with `welcome` the first task and the run it starts), and refuses a kind the office does not have (400). The
//   manager is a target.
// - `before` reads the adapter list (#222): Paperclip refuses a hire for an adapter type it has not installed (assertKnownAdapterType), so
//   a hire (the HR desk and the Manager alike) is 409 with the reason, before any Confirm, unless the office adapter is installed.
// - Paperclip answers 201 { agent, approval } (routes/agents.ts handleAgentHire): the employee is the agent, and the approval is the board's
//   pending hire_agent approval when the company sets requireBoardApprovalForNewAgents. The new employee is read back at once (`employee`),
//   so the onboarding task can name it before the next read of the company; the result and the feed say when the board must approve.
// - The office Manager (#204) is this same plan with officeManager: true (adapterConfig.manager, the Project manager role by default:
//   Paperclip's AGENT_ROLES has no 'manager'); there is no second hire plan.
// - The onboarding task (opt-in on the HR desk) is a `task create` of its own (office.mjs hireHq, onboardingTask), through its own Tasks
//   cell, never the hire's Confirm. Paperclip wakes the assignee of a new task (routes/issues.js, issue_assigned), so the task starts a run.
// - Routes (page group): POST /api/hq/hire (office.mjs hireHq: the hire, then with `welcome` the onboarding task: Deny of the Tasks cell
//   refuses the hire before anything is sent, Confirm answers onboarding 'ask' with the task for its own Confirm, Allow sends; a failed
//   task never undoes the hire, onboarding: 'failed') and GET /api/hq/hire-desk (the role cards; `write` is false when this cell is Deny).
//   The page is `HireForm` and `HireDialog` in public/hq.js (Ctrl+K Hire an employee, the Orientation step `hire`). Tested in
//   test/hq-hire.test.mjs; the core-jobs gate has a `hire` job (5 steps).
import { gridError, idOf, textOf, short, obj, RULES, NAME_MAX, HIRE_BUDGET_MAX, SAMPLE as S } from './shared.mjs';
import { OFFICE_ADAPTER_TYPE } from '../hq-model.mjs';

// The HR desk: the role cards. role is Paperclip's role word (AGENT_ROLES of the pinned release); text is what the card says.
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
// The office Manager takes the Project manager role (Paperclip validates the role with createAgentHireSchema); the office marks it with
// adapterConfig.manager and knows its Managers from its own `managers` slice, never from the role.
export const MANAGER_ROLE = 'pm', MANAGER_TITLE = 'Agent Office Manager';
export const ONBOARDING_TEXT = 'Introduce yourself. Read the room notes, then add one line to the notes board with office_room_update: who you are, what you will do first and what you need. That is your first stand-up note.';
/** The onboarding task of a new employee as a `task create` write: { kind, action, title, description, assigneeAgentId? }. */
export function onboardingTask(name, agentId) {
  const t = { kind: 'task', action: 'create', title: `Welcome, ${String(name || 'new employee').slice(0, 60)}: post your first stand-up note`, description: ONBOARDING_TEXT };
  return agentId ? { ...t, assigneeAgentId: agentId } : t;
}
const HIRE_KIND_RE = /^[a-z][a-z0-9-]{0,39}$/, HIRE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/, SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
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
// Paperclip's answer { agent, approval }: the agent, and whether the board must approve the hire.
const agentOf = (made) => obj(made.agent);
const waitsForBoard = (made) => { const approval = made.approval && typeof made.approval === 'object' ? made.approval : null; return agentOf(made).status === 'pending_approval' || !!(approval && approval.id); };

export default {
  kind: 'hire', label: 'Hires', options: RULES, def: 'confirm',
  actions: {
    create(b) {
      const name = textOf(b.name, 'name', NAME_MAX, { required: true });
      if (b.officeManager !== undefined && typeof b.officeManager !== 'boolean') throw gridError(400, 'officeManager is true or false.');
      if (b.welcome !== undefined && typeof b.welcome !== 'boolean') throw gridError(400, 'welcome is true or false.');
      const welcome = b.welcome === true;
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
      const who = short(name, 60);
      const then = welcome ? `. Then the first task "${short(onboardingTask(name).title, 90)}", assigned to ${who}: Paperclip wakes ${who} on it, which starts a run of ${who}` : '';
      const line = (mgr, sup) => `Hire ${who} as ${roleLabel}, reporting to ${mgr}, agent kind ${kind}${sup ? ` (${sup})` : ''}, model ${model || 'the default'}, $${(cents / 100).toFixed(2)} a month, skills ${skills.length ? skills.join(', ') : 'none'}${then}`;
      // ctx.kindOf(kind) -> { word } (the supervision words of the kind, OfficeVocab.hq.kindSupervision) or null for a kind the office does not have
      const review = (org, ctx = {}) => {
        const m = manager ? org.find((x) => x.id === manager) : null;
        if (manager && !m) return { problem: 'Paperclip has no such manager in this company.', status: 404 };
        const k = typeof ctx.kindOf === 'function' ? ctx.kindOf(kind) : null;
        if (!k) return { problem: `This office has no agent kind ${kind}, so the new employee could never run. Pick one of the office's agent kinds.`, status: 400 };
        return { problem: '', summary: line(m ? short(String(m.name || 'a manager'), 60) : 'no manager', k.word) };
      };
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/agent-hires`, body, targets: manager ? [{ type: 'agent', id: manager }] : [], review, summary: line(manager ? 'a manager' : 'no manager') };
    },
  },
  async before(plan, ctx) {
    const a = await ctx.adapter();
    if (a.state !== 'installed') { ctx.feed(`Hire not sent: ${a.why}`, 'wait'); throw gridError(409, a.why); }
    return undefined;
  },
  employee: (plan, made) => agentOf(made).id,
  expect: (plan, made) => (typeof agentOf(made).id === 'string' && agentOf(made).id ? '' : 'Paperclip did not name the employee it hired'),
  result: (plan, made) => ({ id: String(agentOf(made).id), name: plan.body.name, pendingApproval: waitsForBoard(made) }),
  note: (plan, made) => (waitsForBoard(made) ? ' Paperclip waits for the board to approve the hire.' : ''),
  samples: {
    create: {
      body: { kind: 'hire', action: 'create', name: 'N', role: 'engineer', title: 'T', manager: S.manager, model: 'sonnet', budgetDollars: 10, skills: ['tdd'] },
      request: { method: 'POST', path: `/api/companies/${S.co}/agent-hires`, body: { name: 'N', role: 'engineer', adapterType: OFFICE_ADAPTER_TYPE, adapterConfig: { agentKind: 'claude-code', isolation: 'worktree', model: 'sonnet' }, budgetMonthlyCents: 1000, title: 'T', reportsTo: S.manager, desiredSkills: ['tdd'] } },
      answer: { agent: { id: 'a3', companyId: S.co, name: 'N', status: 'pending_approval' }, approval: { id: 'ap2', type: 'hire_agent', status: 'pending' } },
      result: { ok: true, id: 'a3', name: 'N', pendingApproval: true },
    },
  },
};
