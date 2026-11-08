// Write kind `goal` (#207, ADR 0010): a goal of the company (POST) or a change to one (PATCH). A parent goal and an owner are targets: both
// must belong to the connected company. A goal cannot be its own parent. An update must change something.
import { RULES, gridError, idOf, textOf, short, TITLE_MAX, DESC_MAX, SAMPLE as S } from './shared.mjs';

export const GOAL_STATUSES = ['planned', 'active', 'achieved', 'cancelled'], GOAL_LEVELS = ['company', 'team', 'agent', 'task'];

export default {
  kind: 'goal', label: 'Goals', options: RULES, def: 'confirm',
  actions: {
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
  expect: (plan, made) => (plan.action === 'create' && !made.id ? 'Paperclip did not name the goal it made' : ''),
  result: (plan, made) => (plan.action === 'create' ? { id: String(made.id) } : {}),
  samples: {
    create: {
      body: { kind: 'goal', action: 'create', title: 'G', description: 'D', level: 'team', status: 'active', parent: S.goal, owner: S.agent },
      request: { method: 'POST', path: `/api/companies/${S.co}/goals`, body: { title: 'G', description: 'D', level: 'team', status: 'active', parentId: S.goal, ownerAgentId: S.agent } },
      answer: { id: 'g2', companyId: S.co, title: 'G', status: 'active' },
      result: { ok: true, id: 'g2' },
    },
    update: {
      body: { kind: 'goal', action: 'update', goal: S.goal, title: 'G', description: 'D', status: 'achieved', owner: S.agent },
      request: { method: 'PATCH', path: `/api/goals/${S.goal}`, body: { title: 'G', description: 'D', status: 'achieved', ownerAgentId: S.agent } },
      answer: { id: S.goal, status: 'achieved' },
      result: { ok: true },
    },
  },
};
