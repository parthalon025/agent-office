// Write kind `company` (ADR 0010): the first company (#199), the company settings (#213) and a company import (#221).
// - create: the one write with no company to belong to. It names the Paperclip it goes to (url, a loopback address the writer checks) and
//   needs no connection: scope 'none', and the kind has ownAddress, so the writer plans it before it asks for a connection. `before` reads
//   the company list first and reuses a company of the same name: no write and no question.
// - update: name, description and whether a new employee needs the board's approval. One PATCH of the connected company.
// - import: a bundle from a company export, as a NEW company (Paperclip routes/companies.ts POST /import, instance admin only). Never the
//   replace strategy, never secret values or adapter overrides (those stay in Paperclip), and imported routines start paused. `before`
//   first asks Paperclip for a preview (the plan's preflight, POST /import/preview, no change made): its errors refuse the write, and its
//   counts are the words of the Confirm. The bundle is checked here: a list of files (text or base64), no path that leaves the bundle,
//   at most IMPORT_FILES_MAX files and IMPORT_BYTES_MAX. The page sends it as POST /api/hq/write { kind: 'company', action: 'import',
//   bundle: { rootPath, files, manifest? }, name? }.
import { RULES, gridError, textOf, short, text, obj, NAME_MAX, COMPANY_DESC_MAX, EXPORT_INCLUDES, SAMPLE as S } from './shared.mjs';
import { shapeProblems } from '../hq-model.mjs';

export const IMPORT_FILES_MAX = 2000, IMPORT_BYTES_MAX = 10 * 1024 * 1024;

export default {
  kind: 'company', label: 'Company', options: RULES, def: 'confirm',
  ownAddress: true,
  actions: {
    create(b) {
      const name = textOf(b.name, 'company name', NAME_MAX, { required: true }), description = textOf(b.description, 'description', COMPANY_DESC_MAX);
      if (typeof b.url !== 'string' || !b.url) throw gridError(400, 'Give the Paperclip address.');
      return { method: 'POST', path: () => '/api/companies', body: { name, description }, targets: [], scope: 'none', url: b.url, name, summary: `Create the company "${short(name)}"` };
    },
    import(b) {
      const bundle = b.bundle;
      if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) throw gridError(400, 'Give the company export file.');
      const names = Object.keys(bundle.files);
      if (!names.length) throw gridError(400, 'The company export has no files.');
      if (names.length > IMPORT_FILES_MAX) throw gridError(400, `The company export has too many files (at most ${IMPORT_FILES_MAX}).`);
      let size = 0;
      const files = {};
      for (const n of names) {
        if (!n || n.length > 400 || n.startsWith('/') || n.includes('\\') || n.includes('\0') || n.split('/').some((x) => x === '..')) throw gridError(400, 'A file name in the company export is not valid.');
        const v = bundle.files[n];
        if (typeof v === 'string') { size += v.length; files[n] = v; }
        else if (v && typeof v === 'object' && v.encoding === 'base64' && typeof v.data === 'string') { size += v.data.length; files[n] = { encoding: 'base64', data: v.data, ...(typeof v.contentType === 'string' && v.contentType ? { contentType: v.contentType.slice(0, 100) } : {}) }; }
        else throw gridError(400, 'A file in the company export is not text or base64.');
      }
      if (size > IMPORT_BYTES_MAX) throw gridError(413, 'The company export is too large (at most 10 MB).');
      const rootPath = typeof bundle.rootPath === 'string' && bundle.rootPath ? bundle.rootPath.slice(0, 200) : null;
      const name = textOf(b.name, 'company name', NAME_MAX);
      const source = { type: 'inline', rootPath, files, expectedFileCount: names.length };
      const target = { mode: 'new_company', ...(name ? { newCompanyName: name } : {}) };
      let include;
      if (b.include !== undefined && b.include !== null) {
        if (typeof b.include !== 'object' || Array.isArray(b.include)) throw gridError(400, 'Choose what to import.');
        include = {};
        for (const k of EXPORT_INCLUDES) if (b.include[k] !== undefined) { if (typeof b.include[k] !== 'boolean') throw gridError(400, 'Choose what to import.'); include[k] = b.include[k]; }
      }
      const base = { source, target, collisionStrategy: 'rename', ...(include ? { include } : {}) };
      const front = Object.keys(files).find((n) => n === 'COMPANY.md' || n.endsWith('/COMPANY.md')), fromFile = front && typeof files[front] === 'string' ? (/^name:\s*["']?(.+?)["']?\s*$/m.exec(files[front]) || [])[1] : '';
      const label = name || (bundle.manifest && typeof bundle.manifest === 'object' && bundle.manifest.source && typeof bundle.manifest.source.companyName === 'string' ? bundle.manifest.source.companyName : '') || fromFile || 'a company';
      const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      return {
        method: 'POST', path: () => '/api/companies/import', body: { ...base, pauseAutomations: true }, targets: [], name, timeoutMs: 120000,
        preflight: { path: '/api/companies/import/preview', body: base },
        summarize: (pv) => {
          const pl = pv && pv.plan && typeof pv.plan === 'object' ? pv.plan : {}, n = (x) => (Array.isArray(x) ? x.length : 0);
          return `Import "${short(String(label), 60)}" as a new company (${count(n(pl.agentPlans), 'employee')}, ${count(n(pl.projectPlans), 'project')}, ${count(n(pl.issuePlans), 'task')}; routines start paused)`;
        },
        summary: `Import "${short(String(label), 60)}" as a new company`,
      };
    },
    update(b) {
      const body = {};
      if (b.name !== undefined) body.name = textOf(b.name, 'company name', NAME_MAX, { required: true });
      if (b.description !== undefined) body.description = textOf(b.description, 'description', COMPANY_DESC_MAX);
      if (b.requireBoardApprovalForNewAgents !== undefined) {
        if (typeof b.requireBoardApprovalForNewAgents !== 'boolean') throw gridError(400, 'Hire approval must be on or off.');
        body.requireBoardApprovalForNewAgents = b.requireBoardApprovalForNewAgents;
      }
      if (!Object.keys(body).length) throw gridError(400, 'Give a setting to change.');
      const what = [body.name !== undefined && 'name', body.description !== undefined && 'description', body.requireBoardApprovalForNewAgents !== undefined && 'hire approval'].filter(Boolean).join(', ');
      return { method: 'PATCH', path: (co) => `/api/companies/${encodeURIComponent(co)}`, body, targets: [], summary: `Change the company settings (${what})` };
    },
  },
  async before(plan, ctx) {
    if (plan.scope === 'none') {
      // A retry never doubles the company: a name that exists is reused, with no write and no question.
      const all = await ctx.read('/api/companies');
      const have = (Array.isArray(all) ? all : []).find((x) => x && x.id && text(x.name, 80) === plan.name);
      if (have) { ctx.feed(`The company "${plan.name}" was already in Paperclip. Nothing was sent.`); return { ok: true, id: String(have.id), name: plan.name, existed: true }; }
    }
    if (plan.preflight) {
      const pv = await ctx.preview();
      const bad = shapeProblems('importPreview', pv);
      if (bad.length) throw gridError(502, `Paperclip answered in a shape the office does not know (${bad[0]}) Update the office or the pinned Paperclip.`);
      if (pv.errors.length) throw gridError(400, `Paperclip cannot import this file: ${text(pv.errors[0], 200)}`);
      plan.summary = plan.summarize(pv);
    }
    return undefined;
  },
  expect(plan, made) {
    if (plan.action === 'create' && !made.id) return 'Paperclip did not name the company it made';
    if (plan.action === 'import' && (shapeProblems('importResult', made).length || typeof obj(made.company).id !== 'string' || !obj(made.company).id)) return 'Paperclip did not name the company it imported';
    return '';
  },
  result(plan, made) {
    if (plan.action === 'create') return { id: String(made.id), name: plan.name, existed: false };
    if (plan.action === 'import') return { id: String(made.company.id), name: text(made.company.name, 80) || plan.name };
    return {};
  },
  samples: {
    create: {
      body: { kind: 'company', action: 'create', name: 'Co', description: 'D', url: 'http://127.0.0.1:3100' },
      request: { method: 'POST', path: '/api/companies', body: { name: 'Co', description: 'D' } },
      answer: { id: 'c2', name: 'Co', issuePrefix: 'CO' },
      result: { ok: true, id: 'c2', name: 'Co', existed: false },
    },
    import: {
      body: { kind: 'company', action: 'import', bundle: { rootPath: 'acme', files: { 'COMPANY.md': '---\nname: Acme Labs\n---\n' } }, name: 'Acme Labs', include: { company: true, agents: true } },
      request: { method: 'POST', path: '/api/companies/import', body: { source: { type: 'inline', rootPath: 'acme', files: { 'COMPANY.md': '---\nname: Acme Labs\n---\n' }, expectedFileCount: 1 }, target: { mode: 'new_company', newCompanyName: 'Acme Labs' }, collisionStrategy: 'rename', include: { company: true, agents: true }, pauseAutomations: true } },
      answer: { company: { id: 'c2', name: 'Acme Labs', action: 'created' }, agents: [], projects: [], warnings: [] },
      result: { ok: true, id: 'c2', name: 'Acme Labs' },
    },
    update: {
      body: { kind: 'company', action: 'update', name: 'Co', description: 'D', requireBoardApprovalForNewAgents: true },
      request: { method: 'PATCH', path: `/api/companies/${S.co}`, body: { name: 'Co', description: 'D', requireBoardApprovalForNewAgents: true } },
      answer: { id: S.co, name: 'Co' },
      result: { ok: true },
    },
  },
};
