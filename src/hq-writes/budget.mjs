// Write kind `budget` (#203, ADR 0010): one monthly limit in whole cents, for the company or for one employee (PATCH .../budgets
// { budgetMonthlyCents }). The office never sets no limit (0 in Paperclip): an employee always has a budget (ADR 0010), so 0 and a typing
// slip over HIRE_BUDGET_MAX are 400. An employee's budget marks the employee busy while it sends, and the employee is read again after.
import { RULES, gridError, idOf, short, HIRE_BUDGET_MAX, SAMPLE as S } from './shared.mjs';

const dollarsOf = (cents) => `$${(cents / 100).toFixed(2)}`;
function budgetCents(dollars) {
  if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars <= 0) throw gridError(400, 'Give a monthly budget above zero. The office does not remove a budget.');
  if (dollars > HIRE_BUDGET_MAX) throw gridError(400, `The monthly budget is too high (at most $${HIRE_BUDGET_MAX}).`);
  const cents = Math.round(dollars * 100);
  if (cents < 1) throw gridError(400, 'Set a monthly budget of at least one cent.');
  return cents;
}

export default {
  kind: 'budget', label: 'Budgets', options: RULES, def: 'confirm',
  actions: {
    company(b) {
      const cents = budgetCents(b.budgetDollars);
      return { method: 'PATCH', path: (co) => `/api/companies/${encodeURIComponent(co)}/budgets`, body: { budgetMonthlyCents: cents }, targets: [], summary: `Set the company budget to ${dollarsOf(cents)} a month` };
    },
    agent(b) {
      const agent = idOf(b.agent, 'employee'), cents = budgetCents(b.budgetDollars);
      const review = (org) => {
        const a = org.find((x) => x.id === agent);
        if (!a) return { problem: 'Paperclip has no such agent in this company.', status: 404 };
        return { problem: '', summary: `Set the budget of ${short(String(a.name || 'an employee'), 60)} to ${dollarsOf(cents)} a month` };
      };
      return { method: 'PATCH', path: () => `/api/agents/${agent}/budgets`, body: { budgetMonthlyCents: cents }, targets: [{ type: 'agent', id: agent }], review, summary: `Set the budget of an employee to ${dollarsOf(cents)} a month` };
    },
  },
  busy: (plan) => (plan.action === 'agent' ? plan.targets[0].id : null),
  samples: {
    company: {
      body: { kind: 'budget', action: 'company', budgetDollars: 50 },
      request: { method: 'PATCH', path: `/api/companies/${S.co}/budgets`, body: { budgetMonthlyCents: 5000 } },
      answer: { id: S.co, budgetMonthlyCents: 5000 },
      result: { ok: true },
    },
    agent: {
      body: { kind: 'budget', action: 'agent', agent: S.agent, budgetDollars: 5 },
      request: { method: 'PATCH', path: `/api/agents/${S.agent}/budgets`, body: { budgetMonthlyCents: 500 } },
      answer: { id: S.agent, budgetMonthlyCents: 500 },
      result: { ok: true },
    },
  },
};
