// Write kind `routine` (#209, ADR 0010): create a routine, edit it (title, description, employee, status), change the schedule of one
// trigger (a cron line) and run it now (one POST with no body). The routine and the trigger are checked against the routines the office
// holds, so a stranger is 404. A new routine has no schedule: Paperclip's trigger create is not planned yet. The HQ dialog `Routines` in
// public/hq.js sends them through `hqWrite`, asks nothing itself, shows the server's ask-first text in a painted Confirm and sends the
// same calls again with `confirmed: true`; OfficeVocab.hq.routineForm and routineCalls send only what changed.
import { RULES, gridError, idOf, textOf, short, TITLE_MAX, DESC_MAX, SAMPLE as S } from './shared.mjs';

export const ROUTINE_STATUS = ['active', 'paused', 'archived'];
const CRON_RE = /^[0-9*/,\-A-Za-z ]+$/, TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

export default {
  kind: 'routine', label: 'Routines', options: RULES, def: 'confirm',
  actions: {
    create(b) {
      const title = textOf(b.title, 'title', TITLE_MAX, { required: true }), description = textOf(b.description, 'description', DESC_MAX);
      const body = { title }, targets = [];
      if (description) body.description = description;
      if (b.agent !== undefined && b.agent !== null && b.agent !== '') { body.assigneeAgentId = idOf(b.agent, 'employee'); targets.push({ type: 'agent', id: body.assigneeAgentId }); }
      if (b.status !== undefined && b.status !== null) { if (!ROUTINE_STATUS.includes(b.status) || b.status === 'archived') throw gridError(400, 'Unknown routine status.'); body.status = b.status; }
      if (b.project !== undefined && b.project !== null && b.project !== '') body.projectId = idOf(b.project, 'project');
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/routines`, body, targets, summary: `Create the routine "${short(title)}"` };
    },
    update(b) {
      const routine = idOf(b.routine, 'routine'), body = {}, targets = [{ type: 'routine', id: routine }];
      if (b.title !== undefined) body.title = textOf(b.title, 'title', TITLE_MAX, { required: true });
      if (b.description !== undefined) body.description = textOf(b.description, 'description', DESC_MAX);
      if (b.agent !== undefined) { if (b.agent === null || b.agent === '') body.assigneeAgentId = null; else { body.assigneeAgentId = idOf(b.agent, 'employee'); targets.push({ type: 'agent', id: body.assigneeAgentId }); } }
      if (b.status !== undefined) { if (!ROUTINE_STATUS.includes(b.status)) throw gridError(400, 'Unknown routine status.'); body.status = b.status; }
      if (!Object.keys(body).length) throw gridError(400, 'Give a change for the routine.');
      return { method: 'PATCH', path: () => `/api/routines/${routine}`, body, targets, summary: 'Change a routine' };
    },
    schedule(b) {
      const routine = idOf(b.routine, 'routine'), trigger = idOf(b.trigger, 'schedule'), cron = textOf(b.cron, 'schedule', 100, { required: true });
      if (!CRON_RE.test(cron) || cron.split(/\s+/).length !== 5) throw gridError(400, 'Give the schedule as five cron fields, for example 0 9 * * 1.');
      const body = { cronExpression: cron.split(/\s+/).join(' ') };
      if (b.timezone !== undefined && b.timezone !== null && b.timezone !== '') { if (typeof b.timezone !== 'string' || !TZ_RE.test(b.timezone)) throw gridError(400, 'Give a time zone such as UTC or Europe/Berlin.'); body.timezone = b.timezone; }
      return { method: 'PATCH', path: () => `/api/routine-triggers/${trigger}`, body, targets: [{ type: 'trigger', id: trigger, routine }], summary: 'Change the schedule of a routine' };
    },
    run(b) {
      const routine = idOf(b.routine, 'routine');
      return { method: 'POST', path: () => `/api/routines/${routine}/run`, body: {}, targets: [{ type: 'routine', id: routine }], summary: 'Run a routine now' };
    },
  },
  expect: (plan, made) => (plan.action === 'create' && !made.id ? 'Paperclip did not name the routine it made' : ''),
  result: (plan, made) => (plan.action === 'create' ? { id: String(made.id) } : {}),
  samples: {
    create: {
      body: { kind: 'routine', action: 'create', title: 'R', description: 'D', agent: S.agent, status: 'active', project: S.project },
      request: { method: 'POST', path: `/api/companies/${S.co}/routines`, body: { title: 'R', description: 'D', assigneeAgentId: S.agent, status: 'active', projectId: S.project } },
      answer: { id: 'r2', companyId: S.co, title: 'R', status: 'active' },
      result: { ok: true, id: 'r2' },
    },
    update: {
      body: { kind: 'routine', action: 'update', routine: S.routine, title: 'R', description: 'D', agent: S.agent, status: 'paused' },
      request: { method: 'PATCH', path: `/api/routines/${S.routine}`, body: { title: 'R', description: 'D', assigneeAgentId: S.agent, status: 'paused' } },
      answer: { id: S.routine, status: 'paused' },
      result: { ok: true },
    },
    schedule: {
      body: { kind: 'routine', action: 'schedule', routine: S.routine, trigger: S.trigger, cron: '0 9 * * *', timezone: 'UTC' },
      request: { method: 'PATCH', path: `/api/routine-triggers/${S.trigger}`, body: { cronExpression: '0 9 * * *', timezone: 'UTC' } },
      answer: { id: S.trigger, cronExpression: '0 9 * * *' },
      result: { ok: true },
    },
    run: {
      body: { kind: 'routine', action: 'run', routine: S.routine },
      request: { method: 'POST', path: `/api/routines/${S.routine}/run`, body: {} },
      answer: { id: 'rr1', routineId: S.routine, status: 'queued' },
      result: { ok: true },
    },
  },
};
