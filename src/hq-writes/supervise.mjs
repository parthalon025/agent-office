// Write kind `supervise` (#76, ADR 0005, then 0010): Supervise in office, one PATCH /api/agents/:id { adapterConfig } of a claude_local
// agent. Its painted Confirm on the Agents screen of the Security room is its Confirm (the route refuses a call without it), so the cell
// offers Confirm and Deny only. The body is never a field of the request: `send` reads the agent again just before the PATCH and builds the
// change from that read and the office's own hooks file (paperclip.mjs supervisePatch), so no page can write other arguments into an agent
// and a change made in Paperclip since the office last read the company stays. Paperclip's PATCH has no version check, so the agent is read
// once more after it: the supervision the result and the feed name is what Paperclip keeps, never what the office sent.
import { RULES, gridError, idOf, short, text, obj, strings, SAMPLE as S } from './shared.mjs';

export default {
  kind: 'supervise', label: 'Supervise in office', options: ['confirm', 'deny'], def: 'confirm',
  actions: {
    set(b) {
      const agent = idOf(b.agent, 'employee');
      const review = (org) => {
        const a = org.find((x) => x.id === agent);
        if (!a) return { problem: 'Paperclip has no such agent in this company.', status: 404 };
        return { problem: '', summary: `Supervise ${short(String(a.name || 'an employee'), 60)} in the office (its Claude Code runs with the office hooks and asks here)` };
      };
      // fill: the body is filled by `send`, never taken from the request
      return { method: 'PATCH', path: () => `/api/agents/${agent}`, body: {}, targets: [{ type: 'agent', id: agent }], review, fill: 'supervise', summary: 'Supervise an employee in the office' };
    },
  },
  // Read, then PATCH, then read. Resolves { ok, supervision, already? } ({ ok: false } when the connection changed meanwhile).
  async send(plan, ctx) {
    const id = plan.targets[0].id, sup = ctx.supervision, who = ctx.employee;
    const file = sup.hooksFile();
    if (!file) throw gridError(500, 'The office has no hooks file yet.');
    return ctx.hold(id, 'The office is already setting up this agent.', async () => {
      const a = await who.read(id);
      if (!ctx.connected()) return { ok: false };
      if (!a || a.id !== id || a.companyId !== ctx.companyId) throw gridError(404, 'Paperclip has no such agent in this company.');
      who.keep(a);
      const before = sup.of(id);
      if (before.state === 'supervised') return { ok: true, already: true, supervision: before };
      if (!before.can) throw gridError(409, `Supervise in office cannot set up ${text(a.name, 60)}: ${before.why}`);
      const patch = sup.patch(a, file);
      ctx.confirm();
      const out = await ctx.request(patch);
      if (!ctx.connected()) return { ok: false };
      const saved = await who.read(id);
      if (!ctx.connected()) return { ok: false };
      const now = saved && saved.id === id ? saved : out && out.id === id ? out : null;
      if (now) who.keep(now);
      who.changed(id);
      const after = sup.of(id), name = text(a.name, 60);
      const sent = patch.adapterConfig.extraArgs, got = strings(obj(obj(now).adapterConfig).extraArgs);
      if (now && (got.length !== sent.length || got.some((x, k) => x !== sent[k]))) {
        ctx.feed(`Supervise in office: Paperclip saved other arguments for ${name} than the office sent (a change made in Paperclip at the same time). The office shows the saved config${after.why ? `: ${after.why}` : ', which holds its calls here.'}`, 'wait');
        return { ok: after.state === 'supervised', supervision: after };
      }
      // the agent's own --settings stay in its arguments, but only the last one loads, and that is the office's now
      const own = sup.otherSettings(sent, file).map((f) => text(f, 80));
      const lost = after.state === 'supervised' && own.length ? ` Its own --settings ${own.join(', ')} no longer ${own.length > 1 ? 'load' : 'loads'}: Claude Code loads only the last --settings.` : '';
      ctx.feed(after.state === 'supervised'
        ? `Supervise in office: ${name} now runs Claude Code with the office hooks. Its next run asks here.${lost}`
        : `Supervise in office: Paperclip took the change for ${name}, but ${after.why.charAt(0).toLowerCase()}${after.why.slice(1)}`);
      return { ok: after.state === 'supervised', supervision: after };
    });
  },
  // The request of a sample is the plan's (body {}); the body send builds is checked by test/paperclip-contract.test.mjs with
  // supervisePatch, and the result (the supervision Paperclip keeps) by test/hq-write.test.mjs and test/paperclip.test.mjs.
  samples: {
    set: {
      body: { kind: 'supervise', action: 'set', agent: S.agent },
      request: { method: 'PATCH', path: `/api/agents/${S.agent}`, body: {} },
      answer: { id: S.agent, companyId: S.co, adapterType: 'claude_local', adapterConfig: { engine: 'cli', dangerouslySkipPermissions: false } },
    },
  },
};
