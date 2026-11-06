// The spend default, message templates and schedules: what the office saves about work it starts later, and the tick that starts it.
// A schedule opens a session through the office's own open (openSession), so it meets every admission check an open does.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { traitsOf, spendLimitFor, DEFAULT_SPEND_LIMIT } from './providers/index.mjs';
import { MODEL_RE, MODES } from './providers/claude-code.mjs';
import { normPath } from './place.mjs';
import * as git from './git.mjs';
import { httpError } from './office-core.mjs';

/**
 * createSchedules({ saved, save, providers, claude, kinds, sessions, openSession, addFeed, broadcast })
 *   -> { defaultSpend, saveSpendLimit, saveTemplate, saveSchedule, runSchedule, runDue, dueNow }.
 * saved: the state (state.mjs); save(): write it. providers: the registry; claude: the Claude Code provider; kinds: the kinds as the page
 * shows them; sessions: the live sessions map; openSession(opts): the office's open.
 */
export function createSchedules({ saved, save: savePersisted, providers, claude, kinds: KINDS, sessions, openSession, addFeed, broadcast }) {
  // The default spend limit of new paid sessions, schedules and goals, in dollars (0 = none). The user changes it in the Attach
  // sessions dialog. Never saved means the built-in default.
  const defaultSpend = () => (Number.isFinite(saved.get('spendLimit')) && saved.get('spendLimit') >= 0 ? saved.get('spendLimit') : DEFAULT_SPEND_LIMIT);
  // No limit (0) is the loosest spend setting: a change to it needs confirmed: true (the wall's painted Confirm, or the
  // Save of the typed field in the Attach sessions dialog), so no single click on the wall removes the limit (#70).
  function saveSpendLimit(x) {
    const n = x.limit === null || x.limit === '' ? 0 : Number(x.limit);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw httpError(400, 'The spend limit is a number from 0 to 1000. 0 means no limit.');
    if (n === 0 && defaultSpend() !== 0 && x.confirmed !== true) throw httpError(409, 'Confirm No limit first.');
    saved.set('spendLimit', n);
    savePersisted();
    return { spendLimit: n };
  }
  const newId = () => crypto.randomBytes(4).toString('hex');

  function saveTemplate(t) {
    const name = String(t.name || '').trim().slice(0, 60), text = String(t.text || '').trim().slice(0, 8000);
    if (!name || !text) throw httpError(400, 'A template needs a name and some text.');
    const i = saved.get('templates').findIndex((x) => x.id === t.id);
    const rec = { id: i >= 0 ? t.id : newId(), name, text };
    if (i >= 0) saved.get('templates')[i] = rec; else saved.get('templates').push(rec);
    savePersisted();
    return rec;
  }

  function saveSchedule(x) {
    const name = String(x.name || '').trim().slice(0, 60), prompt = String(x.prompt || '').trim().slice(0, 8000), cwd = String(x.cwd || '').trim();
    if (!name || !prompt || !cwd) throw httpError(400, 'A schedule needs a name, a folder and a prompt.');
    try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch { throw httpError(400, `Folder not found: ${cwd}`); }
    const kind = x.kind === 'daily' ? 'daily' : 'every';
    const every = Math.max(5, Math.min(7 * 24 * 60, Number(x.every) || 60));
    const at = /^\d{1,2}:\d{2}$/.test(String(x.at)) ? String(x.at) : '09:00';
    // The agent kind (#102): none means Claude Code, so a schedule saved before this keeps running it. The kind checks its own model
    // (a kind that needs one refuses an empty pick); Claude Code keeps its pattern and drops a model it does not know.
    const provider = providers.get(x.provider || undefined);
    const model = provider === claude ? (MODEL_RE.test(String(x.model || '')) ? x.model : '') : String(x.model || '');
    if (provider !== claude) provider.check?.({ model });
    const modes = KINDS.find((k) => k.kind === provider.kind)?.modes || [];
    const rec = {
      id: saved.get('schedules').find((y) => y.id === x.id)?.id || newId(), name, prompt, cwd, kind, every, at, provider: provider.kind,
      model, permissionMode: MODES.has(x.permissionMode) && modes.includes(x.permissionMode) ? x.permissionMode : '',
      // A new one without a limit gets the default; 0 is "no limit" and stays 0. A free kind, or one whose cost is unknown, has none.
      isolation: x.isolation === 'worktree' ? 'worktree' : 'same', maxBudget: spendLimitFor({ paid: traitsOf(provider).paid, cost: traitsOf(provider).cost, requested: x.maxBudget, fallback: defaultSpend() }) ?? 0,
      enabled: x.enabled !== false, lastRun: Date.now(),
    };
    const i = saved.get('schedules').findIndex((y) => y.id === rec.id);
    if (i >= 0) { rec.lastRun = saved.get('schedules')[i].lastRun; saved.get('schedules')[i] = rec; } else saved.get('schedules').push(rec);
    savePersisted();
    return rec;
  }

  function dueNow(sch, now) {
    if (!sch.enabled) return false;
    if (sch.kind === 'every') return now - sch.lastRun >= sch.every * 60000;
    const d = new Date(now), [h, m] = sch.at.split(':').map(Number);
    const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
    return now >= slot && sch.lastRun < slot && now - slot < 10 * 60000; // a missed slot is skipped, not made up
  }

  async function runSchedule(sch) {
    sch.lastRun = Date.now();
    savePersisted();
    for (const s of sessions.values()) if (s.scheduleId === sch.id && s.status !== 'ended') return null; // still busy with the last run
    try {
      // The kind must be ready, the same answer as GET /api/providers. If not, nothing starts and its need is the schedule's last error.
      const kind = sch.provider || claude.kind;
      const st = (await providers.statusCached()).find((p) => p.kind === kind);
      if (!st || st.ready !== true) throw new Error((st?.needs || []).join(' ') || 'This agent kind is not ready.');
      const uid = await openSession({ provider: kind, cwd: sch.cwd, name: sch.name, prompt: sch.prompt, model: sch.model, permissionMode: sch.permissionMode, isolation: sch.isolation, maxBudget: sch.maxBudget, scheduleId: sch.id, where: 'office' });
      delete sch.lastError;
      savePersisted();
      return uid;
    } catch (e) {
      sch.lastError = String(e.message || e).slice(0, 400);
      savePersisted();
      addFeed({ uid: 'schedule', name: sch.name }, 'end', 'schedule could not start: ' + e.message);
      broadcast();
      return null;
    }
  }
  // Due schedules of one repository start one after the other (review M5): each waits until the one before it has opened its
  // session (and made its worktree). A queued schedule counts as run, so the next tick does not queue it again. Other
  // repositories do not wait. git.createWorktree is serialized per repository too; this keeps the order and the load sane.
  const scheduleQueue = git.keyedQueue();
  async function runDue(now) {
    for (const sch of saved.get('schedules').filter((x) => dueNow(x, now))) {
      sch.lastRun = now;
      const g = await git.locate(sch.cwd).catch(() => null);
      void scheduleQueue(normPath(g?.repo || sch.cwd || ''), () => runSchedule(sch));
    }
  }
  return { defaultSpend, saveSpendLimit, saveTemplate, saveSchedule, runSchedule, runDue, dueNow };
}
