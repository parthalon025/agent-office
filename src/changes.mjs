// Paper flow (#93, spec #88 phase 4): a change (pull request) is a folder that travels, agents and rooms stay.
// Pure rules from `gh pr list --json` to a folder state, a pipeline stage and the Ready to merge entries, and a reader that asks
// `gh` (read-only, through an injected runner: git.mjs ghRun, argument lists, today's hardening) and never shows old data as live:
// a failed read is "PR state unknown", with no old list behind it. Nothing here starts a process or reads a clock but through deps.

const FIELDS = 'number,title,state,isDraft,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,url,mergedAt,latestReviews,reviewRequests';
export const UNKNOWN = 'PR state unknown';

/** The read-only `gh` arguments: the 40 newest changes, open, merged and closed. */
export const readArgs = () => ['pr', 'list', '--state', 'all', '--limit', '40', '--json', FIELDS];
/** The one write: merge. Only called after the user's confirm (server.mjs). */
export const mergeArgs = (n) => ['pr', 'merge', String(Number(n)), '--merge'];

const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const OKAY = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
/** { total, passed, failed, pending } of the check rollup (check runs and status contexts). */
export function checksOf(pr) {
  const out = { total: 0, passed: 0, failed: 0, pending: 0 };
  for (const c of Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : []) {
    out.total++;
    const v = String(c?.conclusion || c?.state || '').toUpperCase(), done = !c?.status || String(c.status).toUpperCase() === 'COMPLETED';
    if (FAIL.has(v)) out.failed++;
    else if (done && OKAY.has(v)) out.passed++;
    else out.pending++;
  }
  return out;
}

/** The folder's state: draft, open, checks, review, changes, approved, ready, conflict, merged, closed or unknown. */
export function stateOf(pr) {
  if (!pr || typeof pr !== 'object' || !Number.isInteger(pr.number)) return 'unknown';
  const s = String(pr.state || '').toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  if (s !== 'OPEN') return 'unknown';
  if (pr.isDraft) return 'draft';
  if (String(pr.mergeable).toUpperCase() === 'CONFLICTING') return 'conflict';
  const c = checksOf(pr);
  if (c.failed || c.pending) return 'checks';
  const d = String(pr.reviewDecision || '').toUpperCase();
  if (d === 'CHANGES_REQUESTED') return 'changes';
  if (d === 'APPROVED') return String(pr.mergeable).toUpperCase() === 'MERGEABLE' ? 'ready' : 'approved';
  if (d === 'REVIEW_REQUIRED' || (pr.reviewRequests || []).length || (pr.latestReviews || []).length) return 'review';
  return 'open';
}

/** The pipeline stage of a state. Intake and Release have no source yet, so no state gives them. */
const STAGE = { draft: 'build', open: 'check', checks: 'check', conflict: 'check', review: 'review', changes: 'review', approved: 'gate', ready: 'merge', merged: 'record', closed: 'record' };
export const stageOf = (state) => STAGE[state] || null;

export const STAGES = [['intake', 'Intake'], ['build', 'Build'], ['check', 'Check'], ['review', 'Review'], ['gate', 'Gate'], ['merge', 'Merge'], ['release', 'Release'], ['record', 'Record']];
const HAS_DATA = new Set(Object.values(STAGE));
/** The board: every stage with the folders in it (open work only; merged and closed show in Record). unknown: no source for the stage. */
export function pipelineOf(items) {
  return STAGES.map(([id, name]) => ({ id, name, count: (items || []).filter((p) => p.stage === id).length, unknown: !HAS_DATA.has(id) }));
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const reviewerOf = (pr) => (pr.latestReviews || []).map((r) => r?.author?.login).filter(Boolean)[0] || (pr.reviewRequests || []).map((r) => r?.login || r?.name).filter(Boolean)[0] || '';

/** One entry per PR for the snapshot, and how many merged today (the drawer count on the Main cabinet). */
export function viewPrs(raw, now) {
  const prs = (Array.isArray(raw) ? raw : []).filter((p) => p && Number.isInteger(p.number)).map((p) => {
    const state = stateOf(p);
    return {
      number: p.number, title: String(p.title || '').slice(0, 140), head: p.headRefName || '', base: p.baseRefName || '', url: p.url || '',
      state, stage: stageOf(state), checks: checksOf(p), reviewer: reviewerOf(p), diff: { additions: p.additions || 0, deletions: p.deletions || 0, files: p.changedFiles || 0 },
      mergedAt: p.mergedAt || null,
    };
  });
  return { prs, mergedToday: prs.filter((p) => p.state === 'merged' && p.mergedAt && sameDay(p.mergedAt, now)).length };
}

/** The Ready to merge entries: a decision summary per change (key point first, a recommendation, the reason). A building that asks for a
 *  Quality record (Operations Hub) lists a change only when a reviewer session is linked to its branch (opts.quality: a set of branches). */
export function readyEntries(prs, opts = {}) {
  return (prs || []).filter((p) => p.state === 'ready' && (!opts.needQuality || (opts.quality && opts.quality.has(p.head)))).map((p) => ({
    id: `merge:${p.repo}:${p.number}`, kind: 'merge', repo: p.repo, number: p.number, title: p.title, url: p.url, head: p.head,
    text: `#${p.number} ${p.title} is ready to merge.`, recommendation: 'Merge',
    reason: `Checks passed (${p.checks ? p.checks.passed : 0}). Approved${p.reviewer ? ' by ' + p.reviewer : ''}. No conflict.`,
  }));
}

/** The reader: one `gh` read per building, kept for ttlMs (60 s) and asked again after that or after invalidate. A read in flight is
 *  shared. A failed read is { ok: false, error: 'PR state unknown', prs: [] }: the last good list is not kept behind it. */
export function createReader({ run, now = Date.now, ttlMs = 60000, failTtlMs = 10000 }) {
  const cache = new Map(), flying = new Map();
  async function fetchOne(key, cwd) {
    const at = now();
    try {
      const data = JSON.parse(await run(readArgs(), cwd));
      if (!Array.isArray(data)) throw new Error('not a list');
      const v = viewPrs(data, at);
      return { ok: true, at, prs: v.prs, mergedToday: v.mergedToday };
    } catch (e) { return { ok: false, at, error: UNKNOWN, why: String(e?.message || e).slice(0, 200), prs: [], mergedToday: 0 }; }
  }
  return {
    async read(key, cwd) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < (hit.ok ? ttlMs : failTtlMs)) return hit;   // a failed read is asked again soon, not kept for a minute
      if (flying.has(key)) return flying.get(key);
      const p = fetchOne(key, cwd).then((r) => { if (flying.get(key) === p) { cache.set(key, r); flying.delete(key); } return r; });   // an invalidated read does not fill the cache
      flying.set(key, p);
      return p;
    },
    /** What is kept now, without a read. */
    peek: (key) => cache.get(key) || null,
    invalidate: (key) => { if (key == null) { cache.clear(); flying.clear(); } else { cache.delete(key); flying.delete(key); } },
  };
}
