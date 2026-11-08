// Write kind `reporting` (#202, ADR 0010): one reporting line, PATCH /api/agents/:id { reportsTo } (manager null: no manager). review(org)
// reads the org chart the writer holds: a loop, a self report or someone who is not in the company is refused before anything is asked
// (hq-model.mjs reportingProblem), and the summary names the two employees for the Confirm and the feed. The employee is marked busy while
// it sends and read again after, so the floors and the cables rebuild from what Paperclip keeps.
import { RULES, idOf, short, SAMPLE as S } from './shared.mjs';
import { reportingProblem } from '../hq-model.mjs';

export default {
  kind: 'reporting', label: 'Reporting lines', options: RULES, def: 'confirm',
  actions: {
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
  busy: (plan) => plan.targets[0].id,
  samples: {
    set: {
      body: { kind: 'reporting', action: 'set', agent: S.agent, manager: S.manager },
      request: { method: 'PATCH', path: `/api/agents/${S.agent}`, body: { reportsTo: S.manager } },
      answer: { id: S.agent, reportsTo: S.manager },
      result: { ok: true },
    },
  },
};
