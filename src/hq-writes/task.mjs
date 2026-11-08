// Write kind `task` (#198, ADR 0010): create a task of the connected company (with parentId a sub-task, #204), assign it, set its status
// (#204: the Manager moves a task and its sub-tasks as the steps run). Allow by default: the user's own task edits. The goal handoff
// (ADR 0007) and the onboarding task of a hire (#201) are task creates too. The entry's shape is in index.mjs.
import { RULES, gridError, idOf, textOf, short, text, TITLE_MAX, DESC_MAX, SAMPLE as S } from './shared.mjs';

export const ISSUE_STATUS = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];

export default {
  kind: 'task', label: 'Tasks', options: RULES, def: 'allow',
  actions: {
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
  // A created task must have an id: the handoff and the onboarding name it.
  expect: (plan, made) => (plan.action === 'create' && !made.id ? 'Paperclip did not name the task it made' : ''),
  result(plan, made) {
    if (plan.action !== 'create') return {};
    const out = { id: String(made.id) };
    if (typeof made.identifier === 'string') out.identifier = text(made.identifier, 30);
    return out;
  },
  samples: {
    create: {
      body: { kind: 'task', action: 'create', title: 'T', description: 'D', status: 'todo', parentId: S.issue, assigneeAgentId: S.agent },
      request: { method: 'POST', path: `/api/companies/${S.co}/issues`, body: { title: 'T', description: 'D', status: 'todo', parentId: S.issue, assigneeAgentId: S.agent } },
      answer: { id: 'i2', companyId: S.co, identifier: 'ACME-2', title: 'T', status: 'todo' },
      result: { ok: true, id: 'i2', identifier: 'ACME-2' },
    },
    status: {
      body: { kind: 'task', action: 'status', issue: S.issue, status: 'done' },
      request: { method: 'PATCH', path: `/api/issues/${S.issue}`, body: { status: 'done' } },
      answer: { id: S.issue, status: 'done' },
      result: { ok: true },
    },
    assign: {
      body: { kind: 'task', action: 'assign', issue: S.issue, agent: S.agent },
      request: { method: 'PATCH', path: `/api/issues/${S.issue}`, body: { assigneeAgentId: S.agent } },
      answer: { id: S.issue, assigneeAgentId: S.agent },
      result: { ok: true },
    },
  },
};
