// Write kind `adapter` (#222, ADR 0010): the one install of the plugin the office ships (src/integrations/paperclip-adapter) into the
// Paperclip it is connected to: POST /api/adapters/install { packageName: <folder>, isLocalPath: true } (routes/adapters.ts: instance admin
// only, the folder must be readable by the Paperclip process, it loads at once; it answers 201 { type, packageName, version, installedAt,
// requiresRestart }). The folder is never a field of the request: `before` fills it from the office's own folder (ctx.adapterDir(), a
// missing folder is 500 before anything is sent), so no page can make Paperclip load other code. It is idempotent: `before` reads the
// adapter list first, and an adapter that is there (installed or switched off) sends nothing and asks nothing (existed: true). A 403 from
// Paperclip says an instance admin is needed (the plan's `forbidden`). The same read gates every hire (hire.mjs `before`). GET
// /api/hq/adapter (page group: { adapter: { state, why }, write }) and `adapter` on GET /api/hq/hire-desk feed `AdapterInstall` in
// public/hq.js (the HQ dialog, the company step of Orientation after the company exists, the HR desk and the Hire Manager dialog in place
// of the form while it is missing; OfficeVocab.hq.adapter has the words). Tested in test/hq-write.test.mjs, test/hq-hire.test.mjs and
// test/hq-model.test.mjs (the recorded adapterInstall shape; the fake loads the plugin the way Paperclip does).
import { RULES, gridError } from './shared.mjs';
import { shapeProblems, OFFICE_ADAPTER_TYPE } from '../hq-model.mjs';

export default {
  kind: 'adapter', label: 'Office adapter', options: RULES, def: 'confirm',
  actions: {
    install: () => ({ method: 'POST', path: () => '/api/adapters/install', body: { isLocalPath: true }, targets: [], forbidden: 'Installing an adapter needs an instance admin. The board key of the office may not be one, or this Paperclip manages its adapters itself.', summary: 'Install the office adapter in Paperclip' }),
  },
  async before(plan, ctx) {
    const a = await ctx.adapter();
    if (a.state === 'unknown') throw gridError(502, a.why);
    if (a.state !== 'missing') { ctx.feed('The office adapter was already in Paperclip. Nothing was sent.'); return { ok: true, type: OFFICE_ADAPTER_TYPE, existed: true, off: a.state === 'off' }; }
    const dir = ctx.adapterDir();
    if (!dir) throw gridError(500, 'The office cannot find its adapter folder.');
    plan.body = { ...plan.body, packageName: dir };
    return undefined;
  },
  expect: (plan, made) => (shapeProblems('adapterInstall', made).length || made.type !== OFFICE_ADAPTER_TYPE
    ? { line: 'Paperclip did not confirm the office adapter', error: 'Paperclip did not confirm that it loaded the office adapter.' } : ''),
  result: (plan, made) => ({ type: OFFICE_ADAPTER_TYPE, existed: false, requiresRestart: made.requiresRestart === true }),
  samples: {
    install: {
      body: { kind: 'adapter', action: 'install', packageName: 'C:/never-from-the-request' },
      request: { method: 'POST', path: '/api/adapters/install', body: { isLocalPath: true } },
      answer: { type: OFFICE_ADAPTER_TYPE, packageName: 'C:/office/src/integrations/paperclip-adapter', version: '0.1.0', installedAt: '2026-11-07T10:00:00.000Z', requiresRestart: false },
      result: { ok: true, type: OFFICE_ADAPTER_TYPE, existed: false, requiresRestart: false },
    },
  },
};
