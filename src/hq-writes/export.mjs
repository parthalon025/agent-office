// Write kind `export` (#221, ADR 0010): POST /api/companies/:id/export (routes/companies.js, companyPortabilityExportSchema: include). It
// changes nothing in Paperclip and Paperclip leaves secret values out, so its cell offers Allow and Deny only (never asked), and Deny stops
// it. It is the one write whose result is a body: `send` returns the bundle the page saves as a file (the office keeps no copy), checks it
// against the exportBundle shape (502 otherwise), refuses a bundle of a company that is no longer the watched one (409), and does not read
// the company again. POST /api/hq/company/export (page group) hands the bundle to the page as a file (paperclip.mjs exportCompany).
import { RULES, gridError, text, EXPORT_INCLUDES, SAMPLE as S } from './shared.mjs';
import { shapeProblems } from '../hq-model.mjs';

export default {
  kind: 'export', label: 'Company export', options: ['allow', 'deny'], def: 'allow',
  actions: {
    company(b) {
      const include = {};
      if (b.include !== undefined && b.include !== null) {
        if (typeof b.include !== 'object' || Array.isArray(b.include)) throw gridError(400, 'Choose what to export.');
        for (const k of EXPORT_INCLUDES) if (b.include[k] !== undefined) { if (typeof b.include[k] !== 'boolean') throw gridError(400, 'Choose what to export.'); include[k] = b.include[k]; }
      }
      return { method: 'POST', path: (co) => `/api/companies/${encodeURIComponent(co)}/export`, body: Object.keys(include).length ? { include } : {}, targets: [], timeoutMs: 120000, summary: 'Export the company as a file' };
    },
  },
  async send(plan, ctx) {
    ctx.confirm();
    const made = await ctx.request(plan.body);
    const p = shapeProblems('exportBundle', made);
    if (p.length) throw gridError(502, `Paperclip answered in a shape the office does not know (${p[0]}) Update the office or the pinned Paperclip.`);
    if (!ctx.connected()) throw gridError(409, 'Paperclip is not connected.');
    ctx.feed(`Exported the company ${ctx.company} from Paperclip as a file (${Object.keys(made.files).length} files). The office keeps no copy.`);
    return { rootPath: made.rootPath, manifest: made.manifest, files: made.files, warnings: Array.isArray(made.warnings) ? made.warnings.map((w) => text(w, 200)).slice(0, 50) : [] };
  },
  samples: {
    company: {
      body: { kind: 'export', action: 'company', include: { company: true, agents: false, projects: true, issues: true, skills: true } },
      request: { method: 'POST', path: `/api/companies/${S.co}/export`, body: { include: { company: true, agents: false, projects: true, issues: true, skills: true } } },
      answer: { rootPath: 'acme', manifest: { source: { companyName: 'Acme' } }, files: { 'COMPANY.md': '---\nname: Acme\n---\n' }, warnings: ['One   warning.'] },
      result: { rootPath: 'acme', manifest: { source: { companyName: 'Acme' } }, files: { 'COMPANY.md': '---\nname: Acme\n---\n' }, warnings: ['One warning.'] },
    },
  },
};
