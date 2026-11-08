// Write kind `pause` (#203, ADR 0010): pause, resume and let go of one employee (POST /api/agents/:id/pause|resume|terminate, no body).
// Letting go is Paperclip's terminate: it keeps the record, tasks and history (never DELETE /api/agents/:id, which erases it). A move is
// the `reporting` kind. review(org) names the employee for the Confirm and refuses a change that cannot apply: a pause of a paused
// employee, a resume of one that is not paused (409). The employee is marked busy while it sends and read again after. The snapshot
// `hq.employeeWrite` is false when this cell is Deny. The page parts are `EmployeeTools`, `CompanyBudget` and `SelfApproval` in
// public/hq.js. Tested in test/hq-employees.test.mjs with the fake's pause|resume|terminate and budgets routes.
import { RULES, idOf, short, SAMPLE as S } from './shared.mjs';

// One lifecycle POST of one employee (/api/agents/:id/<route>, no body): the employee is a target (it must be in the company) and review
// names it. (The contract test reads the route words from the calls below.)
function employeeStep(route, verb, problemOf, tail = '') {
  return (b) => {
    const agent = idOf(b.agent, 'employee');
    const review = (org) => {
      const a = org.find((x) => x.id === agent);
      if (!a) return { problem: 'Paperclip has no such agent in this company.', status: 404 };
      const problem = problemOf(a);
      if (problem) return { problem, status: 409 };
      return { problem: '', summary: `${verb} ${short(String(a.name || 'an employee'), 60)}${tail}` };
    };
    return { method: 'POST', path: () => `/api/agents/${agent}/${route}`, body: {}, targets: [{ type: 'agent', id: agent }], review, summary: `${verb} an employee${tail}` };
  };
}

export default {
  kind: 'pause', label: 'Pause and retire', options: RULES, def: 'confirm',
  actions: {
    pause: employeeStep('pause', 'Pause', (a) => (a.status === 'paused' ? 'This employee is already paused.' : '')),
    resume: employeeStep('resume', 'Resume', (a) => (a.status === 'paused' ? '' : 'This employee is not paused.')),
    retire: employeeStep('terminate', 'Let go of', () => '', ' (its tasks and history stay in Paperclip)'),
  },
  busy: (plan) => plan.targets[0].id,
  samples: {
    pause: {
      body: { kind: 'pause', action: 'pause', agent: S.agent },
      request: { method: 'POST', path: `/api/agents/${S.agent}/pause`, body: {} },
      answer: { id: S.agent, status: 'paused' },
      result: { ok: true },
    },
    resume: {
      body: { kind: 'pause', action: 'resume', agent: S.agent },
      request: { method: 'POST', path: `/api/agents/${S.agent}/resume`, body: {} },
      answer: { id: S.agent, status: 'idle' },
      result: { ok: true },
    },
    retire: {
      body: { kind: 'pause', action: 'retire', agent: S.agent },
      request: { method: 'POST', path: `/api/agents/${S.agent}/terminate`, body: {} },
      answer: { id: S.agent, status: 'terminated' },
      result: { ok: true },
    },
  },
};
