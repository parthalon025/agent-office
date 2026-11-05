// Paperclip as an optional HQ above the office (#76). A watcher of an outside system, not a provider: the office never opens,
// drives or closes a Paperclip run. Paperclip owns its goals, heartbeats, routines and budgets; the office reads its REST
// routes and its live events (WebSocket /api/companies/{id}/events/ws) and shows them. Its Claude Code runs reach the office
// like any terminal session, through the office hooks (hook.mjs adds the PAPERCLIP_* ids of the run), once "Supervise in
// office" has set the agent up for that. That PATCH, after the Security room's painted Confirm, is the one write the office
// makes to Paperclip (ADR 0005). It never sends a heartbeat, never assigns or changes a task and never runs a routine.
//
// Facts from the spike (#75, Paperclip 2026.1023.0 on Windows, Node 24.11+): a claude_local agent holds its calls in the
// office only with engine 'cli', dangerouslySkipPermissions false and extraArgs ['--permission-mode', 'default', '--settings',
// <office hooks file>]. The default ACP engine approves every call and ignores extraArgs; without --permission-mode default
// the machine's default (Auto) asks nothing. The shapes of the routes and events come from the Paperclip source (0.3.1,
// server/src/routes, server/src/services/heartbeat.ts, packages/shared/src/types). PATCH /api/agents/:id merges adapterConfig
// key by key (a list such as extraArgs is replaced whole), so the patch carries the whole new extraArgs.
//
// Pure apart from createHq, whose network, clock and timers are injected (tests: test/paperclip.test.mjs with the fake server
// test/fixtures/fake-paperclip.mjs; through the server: test/paperclip-routes.test.mjs).
import path from 'node:path';
import { runIds, cleanIds } from './payload.mjs';

export const DEFAULT_URL = 'http://127.0.0.1:3100';

// ---------- the address: loopback only ----------
/**
 * The Paperclip address the office may use: http on 127.0.0.1, any port, nothing after the port. Returns
 * { ok: true, url: 'http://127.0.0.1:<port>' } or { ok: false, error }. localhost is refused too: it can name another
 * address than 127.0.0.1 (::1, or a hosts file entry), and the rule is one address.
 */
export function checkUrl(raw) {
  const text = String(raw ?? '').trim();
  const refuse = (why) => ({ ok: false, error: `${why} The office connects only to a Paperclip on this computer, at http://127.0.0.1:<port> (for example ${DEFAULT_URL}).` });
  if (!text) return refuse('Type the address of Paperclip.');
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`); } catch { return refuse('That is not an address.'); }
  if (u.protocol !== 'http:') return refuse(`The address must start with http://, not ${u.protocol}//.`);
  if (u.hostname !== '127.0.0.1') return refuse(`${u.hostname || 'That host'} is not 127.0.0.1.`);
  if (u.username || u.password) return refuse('The address must not carry a user name or password.');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return refuse('The address ends after the port.');
  return { ok: true, url: `http://127.0.0.1:${u.port || '80'}` };
}

// ---------- supervision: does an agent's config send its runs through the office? ----------
const ROLE_LABELS = { ceo: 'CEO', cto: 'CTO', cmo: 'CMO', cfo: 'CFO', security: 'Security', engineer: 'Engineer', designer: 'Designer', pm: 'PM', qa: 'QA', devops: 'DevOps', researcher: 'Researcher', general: 'General' };
export const roleLabel = (role) => (ROLE_LABELS[role] || (typeof role === 'string' && role ? role[0].toUpperCase() + role.slice(1) : 'Agent'));

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
// The CLI arguments Paperclip adds to a claude_local run: extraArgs, else the older args (execute.ts reads them in that order).
export const argsOf = (cfg) => { const e = strings(obj(cfg).extraArgs); return e.length ? e : strings(obj(cfg).args); };
const samePath = (a, b) => !!a && !!b && path.win32.normalize(String(a)).toLowerCase() === path.win32.normalize(String(b)).toLowerCase();
// The values of a flag, in order: `--flag value` and `--flag=value`. Claude Code takes the last one of a repeated flag.
function valuesOf(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) { if (i + 1 < args.length) out.push(args[i + 1]); i++; } else if (args[i].startsWith(flag + '=')) out.push(args[i].slice(flag.length + 1));
  }
  return out;
}
const hasFlag = (args, flag) => args.some((a) => a === flag || a.startsWith(flag + '='));
// Flags that let a run decide its own calls: never in a supervised run, and the patch takes them out.
const SELF_APPROVE = ['--dangerously-skip-permissions', '--permission-prompt-tool'];

/** Why a claude CLI argument list does not hold calls in this office ('' = it does): the run as Paperclip starts it. */
export function argsWhy(args, hooksFile) {
  const a = strings(args);
  if (hasFlag(a, '--dangerously-skip-permissions')) return 'It skips permissions (--dangerously-skip-permissions).';
  if (hasFlag(a, '--permission-prompt-tool')) return 'Its own tool answers permission prompts (--permission-prompt-tool).';
  const mode = valuesOf(a, '--permission-mode').pop();
  if (mode !== 'default') return mode ? `It runs in the ${mode} permission mode, so Claude Code runs calls without asking.` : 'It does not set --permission-mode default, so the machine default (Auto) runs calls without asking.';
  if (!valuesOf(a, '--settings').some((f) => samePath(f, hooksFile))) return 'It does not load the office hooks file.';
  return '';
}
/** Why an adapter config does not hold its runs' calls in this office ('' = it does). */
export function configWhy(cfg, hooksFile) {
  const c = obj(cfg);
  if (c.engine !== 'cli') return c.engine ? `It runs on the ${c.engine} engine, which ignores the office hooks.` : 'It runs on the ACP engine (the default), which approves every call and ignores the office hooks.';
  if (c.dangerouslySkipPermissions !== false) return 'Skip permissions is on (dangerouslySkipPermissions is not false).';
  return argsWhy(argsOf(c), hooksFile);
}

/**
 * The supervision of one Paperclip agent: { state, label, why, can }.
 * state: 'supervised' (its runs hold every call Claude Code asks about in the office), 'partly' (a model profile or an open
 * issue of the agent changes the run config), 'unsupervised', or 'unknown' (Paperclip did not show the config).
 * label: '' for a supervised agent, else the words a bot card and the HQ list show (ADR 0001). can: "Supervise in office" can
 * set it up (a claude_local agent that is not supervised yet). issues: the agent's open issues (their adapter overrides).
 * lastRun: { ok, why } from the command line of its last run (adapter.invoke), the last word on what really ran.
 */
export function supervisionOf(agent, hooksFile, { issues = [], lastRun = null } = {}) {
  const a = obj(agent);
  if (a.adapterType !== 'claude_local') {
    const why = `Its runs use ${a.adapterType || 'another adapter'}, not Claude Code, so they never reach the office hooks.`;
    return { state: 'unsupervised', label: 'Unsupervised: runs without the office hooks', why, can: false };
  }
  if (!a.adapterConfig || typeof a.adapterConfig !== 'object') return { state: 'unknown', label: 'Unsupervised: config not shown', why: 'Paperclip did not show its adapter config to the office, so the office cannot tell.', can: false };
  const base = configWhy(a.adapterConfig, hooksFile);
  if (base) return { state: 'unsupervised', label: 'Unsupervised', why: base, can: true };
  // The config is right, but the last run Paperclip started was not (an issue or model profile override, or a run that
  // started before the change): the PATCH would change nothing, so it is not offered. The next run that is held clears it.
  if (lastRun && lastRun.ok === false) return { state: 'unsupervised', label: 'Unsupervised: its last run skipped the office', why: `Its last run: ${lastRun.why}`, can: false };
  // A model profile or an issue's adapter overrides are merged over the config for some runs (heartbeat.ts).
  for (const [key, p] of Object.entries(obj(obj(a.runtimeConfig).modelProfiles))) {
    if (obj(p).enabled === false || !obj(p).adapterConfig) continue;
    const why = configWhy({ ...a.adapterConfig, ...obj(p.adapterConfig) }, hooksFile);
    if (why) return { state: 'partly', label: 'Partly supervised: a model profile skips the office', why: `With the ${key} model profile: ${why}`, can: false };
  }
  for (const i of issues) {
    const o = obj(obj(i).assigneeAdapterOverrides).adapterConfig;
    if (!o || i.assigneeAgentId !== a.id) continue;
    const why = configWhy({ ...a.adapterConfig, ...obj(o) }, hooksFile);
    if (why) return { state: 'partly', label: 'Partly supervised: an issue skips the office', why: `For ${i.identifier || i.title || 'one issue'}: ${why}`, can: false };
  }
  return { state: 'supervised', label: '', why: '', can: false };
}

/**
 * The one PATCH body of "Supervise in office": the CLI engine, skip permissions off, and the run's arguments with the
 * default permission mode and the office hooks file at the end. The agent's other arguments stay; a flag that lets the run
 * decide its own calls, an earlier permission mode and an earlier copy of the office hooks file go.
 */
export function supervisePatch(agent, hooksFile) {
  const args = argsOf(obj(agent).adapterConfig), kept = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dangerously-skip-permissions' || a.startsWith('--dangerously-skip-permissions=')) continue;
    if (a === '--permission-mode' || a === '--permission-prompt-tool') { i++; continue; }
    if (a.startsWith('--permission-mode=') || a.startsWith('--permission-prompt-tool=')) continue;
    if (a === '--settings' && samePath(args[i + 1], hooksFile)) { i++; continue; }
    if (a.startsWith('--settings=') && samePath(a.slice(11), hooksFile)) continue;
    kept.push(a);
  }
  return { adapterConfig: { engine: 'cli', dangerouslySkipPermissions: false, extraArgs: [...kept, '--permission-mode', 'default', '--settings', hooksFile] } };
}

// The ids a run carries (runIds, cleanIds) live in payload.mjs: hook.mjs reads them from the environment Paperclip gives
// Claude Code, and the command hook stays light.
export { runIds, cleanIds };

// ---------- the watcher ----------
const cents = (n) => (Number.isFinite(+n) && +n >= 0 ? Math.round(+n) / 100 : 0);
const ms = (t) => { const v = t ? Date.parse(t) : NaN; return Number.isFinite(v) ? v : null; };
const text = (v, n = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const httpError = (status, message) => Object.assign(new Error(message), { status });
// Run states that end a run (heartbeat.ts). A run that ends refreshes the budgets (Paperclip records its cost).
const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'error']);

/**
 * createHq(deps) -> the Paperclip watcher. deps: { hooksFile() (the office's command hooks file, the path Supervise writes),
 * onChange(), onFeed(text, kind), onRun({ agentId, runId, status }) (a run ended), fetch, WebSocket, setTimer, clearTimer,
 * refetchMs, retryMs }. connect, disconnect, supervise, view (the snapshot part), labelOf (a session's label), knows.
 */
export function createHq(deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const Ws = deps.WebSocket || globalThis.WebSocket;
  const hooksFile = deps.hooksFile || (() => '');
  const changed = () => deps.onChange?.();
  const feed = (t, kind = 'tool') => deps.onFeed?.(t, kind);
  const setTimer = deps.setTimer || ((fn, n) => { const t = setTimeout(fn, n); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer || clearTimeout;
  const REFETCH_MS = deps.refetchMs ?? 800;
  const RETRY_MS = deps.retryMs || [1000, 2000, 5000, 10000, 30000];

  let c = null;   // the connection: { url, companyId, state, error, ws, tries, timer, refetch, busy, companies }
  let d = null;   // what Paperclip said: { company, agents: Map, issues, routines, runs: Map agentId -> run, last: Map agentId -> lastRun }

  async function call(conn, route, init = {}) {
    let res;
    try {
      res = await doFetch(conn.url + route, { ...init, redirect: 'error', signal: AbortSignal.timeout(init.method ? 15000 : 8000), headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    } catch (e) { throw httpError(502, `No Paperclip answers at ${conn.url} (${e.cause?.code || e.name || 'no answer'}).`); }
    const body = await res.text();
    if (res.status === 401 || res.status === 403) throw httpError(502, `Paperclip at ${conn.url} asks for sign-in (${res.status}). The office reads a Paperclip that runs in local_trusted mode (paperclipai run --bind loopback).`);
    if (!res.ok) throw httpError(502, `Paperclip answered ${res.status} for ${route.split('?')[0]}${body ? `: ${text(body, 160)}` : '.'}`);
    try { return body ? JSON.parse(body) : null; } catch { throw httpError(502, `Paperclip at ${conn.url} did not answer JSON for ${route.split('?')[0]}.`); }
  }
  const list = (v) => (Array.isArray(v) ? v : []);

  // Every read of one company. Routines and live runs are optional (an older Paperclip may not have them).
  async function read(conn) {
    const id = encodeURIComponent(conn.companyId);
    const [company, agents, issues, routines, live] = await Promise.all([
      call(conn, `/api/companies/${id}`),
      call(conn, `/api/companies/${id}/agents`),
      call(conn, `/api/companies/${id}/issues?status=todo,in_progress,in_review`).catch(() => []),
      call(conn, `/api/companies/${id}/routines`).catch(() => []),
      call(conn, `/api/companies/${id}/live-runs`).catch(() => []),
    ]);
    if (c !== conn) return;
    const runs = d && d.company && d.company.id === conn.companyId ? d.runs : new Map();
    for (const r of list(live)) if (r && r.agentId && r.id) runs.set(r.agentId, { id: r.id, status: r.status || 'running' });
    d = { company: obj(company), agents: new Map(list(agents).filter((a) => a && a.id).map((a) => [a.id, a])), issues: list(issues), routines: list(routines), runs, last: d && d.last ? d.last : new Map() };
    changed();
  }
  function refetchSoon(conn) {
    if (conn.refetch) return;
    conn.refetch = setTimer(() => { conn.refetch = null; if (c === conn) read(conn).catch((e) => lose(conn, e.message)); }, REFETCH_MS);
  }

  function onEvent(conn, ev) {
    if (!ev || typeof ev !== 'object' || ev.companyId !== conn.companyId || !d) return;
    const p = obj(ev.payload);
    switch (ev.type) {
      case 'heartbeat.run.queued': case 'heartbeat.run.status': {
        if (!p.agentId || !p.runId) return;
        const status = ev.type === 'heartbeat.run.queued' ? 'queued' : String(p.status || 'running');
        d.runs.set(p.agentId, { id: p.runId, status, error: text(p.error, 200) || null });
        if (ENDED.has(status)) { deps.onRun?.({ agentId: p.agentId, runId: p.runId, status }); refetchSoon(conn); }
        changed();
        return;
      }
      case 'agent.status': {
        const a = d.agents.get(p.agentId);
        if (a && typeof p.status === 'string') { a.status = p.status; if (p.lastHeartbeatAt) a.lastHeartbeatAt = p.lastHeartbeatAt; changed(); }
        return;
      }
      case 'heartbeat.run.event': {
        // adapter.invoke carries the command line Paperclip started: the last word on whether this run is held in the office
        if (p.eventType !== 'adapter.invoke') return;
        const a = d.agents.get(p.agentId), args = obj(p.payload).commandArgs;
        if (!a || a.adapterType !== 'claude_local' || !Array.isArray(args)) return;
        const why = argsWhy(args, hooksFile());
        const was = d.last.get(a.id);
        d.last.set(a.id, { run: p.runId, ok: !why, why });
        if (why) feed(`Paperclip started a run of ${text(a.name, 60) || 'an agent'} without the office: ${why} Its tool calls are not held.`, 'wait');
        if (!was || was.ok !== !why) changed();
        return;
      }
      case 'activity.logged': refetchSoon(conn); return;   // agents, issues, routines, budgets: read them again
      default: return;   // run logs and plugin events are not shown
    }
  }

  function openSocket(conn) {
    if (!Ws) { lose(conn, 'This Node has no WebSocket, so the office cannot follow Paperclip live.'); return; }
    let ws;
    try { ws = new Ws(`${conn.url.replace(/^http/, 'ws')}/api/companies/${encodeURIComponent(conn.companyId)}/events/ws`); } catch (e) { lose(conn, e.message); return; }
    conn.ws = ws;
    ws.onopen = () => { if (c !== conn) { try { ws.close(); } catch { /* gone */ } return; } conn.state = 'on'; conn.error = ''; conn.tries = 0; changed(); refetchSoon(conn); };
    ws.onmessage = (m) => { if (c !== conn) return; let ev; try { ev = JSON.parse(String(m.data)); } catch { return; } onEvent(conn, ev); };
    ws.onclose = () => { if (c !== conn || conn.ws !== ws) return; conn.ws = null; lose(conn, 'The live events of Paperclip stopped.'); };
    ws.onerror = () => { /* onclose follows */ };
  }
  // The connection is lost: say why and try again later (1 s, 2 s, 5 s, 10 s, then every 30 s).
  function lose(conn, why) {
    if (c !== conn) return;
    conn.state = 'lost'; conn.error = why;
    if (conn.ws) { const w = conn.ws; conn.ws = null; try { w.close(); } catch { /* gone */ } }
    changed();
    if (conn.timer) return;
    conn.timer = setTimer(async () => {
      conn.timer = null;
      if (c !== conn) return;
      try { await read(conn); if (c === conn) openSocket(conn); } catch (e) { lose(conn, e.message); }
    }, RETRY_MS[Math.min(conn.tries++, RETRY_MS.length - 1)]);
  }

  function stop() {
    if (!c) return;
    const old = c; c = null; d = null;
    if (old.timer) clearTimer(old.timer);
    if (old.refetch) clearTimer(old.refetch);
    if (old.ws) { try { old.ws.close(); } catch { /* gone */ } }
  }

  /**
   * Connect to one company. { url, company?, keep? }. Throws 400 for an address the office refuses, before any request.
   * With several companies and none named, nothing is watched yet: { choose: [{ id, name }] }. keep: a saved connection at
   * start: a Paperclip that does not answer yet is tried again, not given up.
   */
  async function connect({ url, company = null, keep = false } = {}) {
    const u = checkUrl(url);
    if (!u.ok) throw httpError(400, u.error);
    stop();
    const conn = c = { url: u.url, companyId: company ? String(company) : null, state: 'connecting', error: '', ws: null, tries: 0, timer: null, refetch: null, busy: new Set(), companies: null };
    changed();
    try {
      const health = await call(conn, '/api/health');
      if (!health || health.status !== 'ok') throw httpError(502, `${conn.url} is not a Paperclip that is ready (its /api/health did not say ok).`);
      const all = list(await call(conn, '/api/companies')).filter((x) => x && x.id).map((x) => ({ id: String(x.id), name: text(x.name, 80) || String(x.id) }));
      if (c !== conn) return { ok: false };
      if (conn.companyId && !all.some((x) => x.id === conn.companyId)) throw httpError(404, 'Paperclip has no company with that id.');
      if (!conn.companyId) {
        if (!all.length) throw httpError(409, 'Paperclip has no company yet. Make one in Paperclip, then connect again.');
        if (all.length > 1) { conn.state = 'choose'; conn.companies = all; changed(); return { choose: all }; }
        conn.companyId = all[0].id;
      }
      await read(conn);
      if (c !== conn) return { ok: false };
      openSocket(conn);
      return { ok: true, url: conn.url, company: conn.companyId };
    } catch (e) {
      if (c !== conn) throw e;
      if (keep && conn.companyId) { lose(conn, e.message); return { ok: false, error: e.message }; }
      stop(); changed();
      throw e;
    }
  }
  function disconnect() { const had = !!c; stop(); if (had) changed(); }

  const issueOf = (agentId) => {
    const mine = (d ? d.issues : []).filter((i) => i && i.assigneeAgentId === agentId);
    return mine.find((i) => i.status === 'in_progress') || mine.find((i) => i.status === 'in_review') || mine.find((i) => i.status === 'todo') || null;
  };
  const supOf = (a) => supervisionOf(a, hooksFile(), { issues: d ? d.issues.filter((i) => i && i.assigneeAgentId === a.id && i.status !== 'done') : [], lastRun: d ? d.last.get(a.id) : null });
  function agentView(a) {
    const i = issueOf(a.id), hb = obj(obj(a.runtimeConfig).heartbeat), run = d.runs.get(a.id) || null;
    return {
      id: a.id, name: text(a.name, 60) || 'Agent', role: roleLabel(a.role), title: text(a.title, 60), status: text(a.status, 30), kind: text(a.adapterType, 40),
      supervision: supOf(a), run: run ? { id: run.id, status: run.status } : null,
      task: i ? { id: i.id, identifier: text(i.identifier, 30), title: text(i.title, 100), status: i.status } : null,
      budget: { spent: cents(a.spentMonthlyCents), limit: cents(a.budgetMonthlyCents) },
      heartbeat: { on: hb.enabled === true && +hb.intervalSec > 0, every: Math.max(0, +hb.intervalSec || 0), last: ms(a.lastHeartbeatAt) },
      busy: !!(c && c.busy.has(a.id)),
    };
  }
  function routineView(r) {
    const trig = list(r.triggers).filter((t) => t && t.enabled !== false);
    const next = trig.map((t) => ms(t.nextRunAt)).filter((x) => x != null).sort((x, y) => x - y)[0] ?? null;
    const a = r.assigneeAgentId && d.agents.get(r.assigneeAgentId);
    return { id: r.id, title: text(r.title, 100) || 'Routine', status: text(r.status, 30), agent: a ? text(a.name, 60) : '', next, cron: text((trig.find((t) => t.cronExpression) || {}).cronExpression, 60), last: ms(r.lastTriggeredAt) };
  }

  /** The HQ part of the snapshot, or null while the office is not connected. Money in dollars, times in ms. */
  function view() {
    if (!c) return null;
    const base = { state: c.state, url: c.url, error: c.error, companies: c.state === 'choose' ? c.companies : null };
    if (!d) return { ...base, company: null, budget: null, agents: [], routines: [] };
    return {
      ...base,
      company: { id: String(d.company.id || c.companyId), name: text(d.company.name, 80) || 'Paperclip' },
      budget: { spent: cents(d.company.spentMonthlyCents), limit: cents(d.company.budgetMonthlyCents) },
      agents: [...d.agents.values()].filter((a) => a.status !== 'terminated').map(agentView),
      routines: d.routines.filter((r) => r && r.id && r.status !== 'archived').map(routineView),
    };
  }
  /** A Paperclip run's label for its office session (hook ids), or null when the agent is not one of the watched company. */
  function labelOf(ids) {
    const x = cleanIds(ids);
    if (!x || !c || !d || x.company !== c.companyId) return null;
    const a = d.agents.get(x.agent);
    if (!a) return null;
    const v = agentView(a);
    const task = (x.task && d.issues.find((i) => i && i.id === x.task)) || null;
    const t = task ? { identifier: text(task.identifier, 30), title: text(task.title, 100) } : v.task;
    return { agent: v.name, role: v.title || v.role, company: text(d.company.name, 80) || 'Paperclip', task: t ? [t.identifier, t.title].filter(Boolean).join(' ') : '', budget: v.budget, run: x.run || null };
  }
  const knows = (ids) => !!labelOf(ids);

  /** "Supervise in office" for one agent: one PATCH of its adapter config (supervisePatch). The caller checked the Confirm. */
  async function supervise(agentId) {
    const conn = c;
    if (!conn || !d || conn.state === 'choose') throw httpError(409, 'Paperclip is not connected.');
    const a = d.agents.get(String(agentId || ''));
    if (!a) throw httpError(404, 'Paperclip has no such agent in this company.');
    const before = supOf(a);
    if (before.state === 'supervised') return { ok: true, already: true, supervision: before };
    if (!before.can) throw httpError(409, `Supervise in office cannot set up ${text(a.name, 60)}: ${before.why}`);
    if (conn.busy.has(a.id)) throw httpError(409, 'The office is already setting up this agent.');
    const file = hooksFile();
    if (!file) throw httpError(500, 'The office has no hooks file yet.');
    conn.busy.add(a.id); changed();
    try {
      const out = await call(conn, `/api/agents/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: JSON.stringify(supervisePatch(a, file)) });
      if (c !== conn || !d) return { ok: false };
      // Paperclip answers with the agent as saved: its supervision is read from that, not from what the office sent
      if (out && out.id === a.id) d.agents.set(a.id, out);
      d.last.delete(a.id);
      const after = supOf(d.agents.get(a.id));
      feed(after.state === 'supervised'
        ? `Supervise in office: ${text(a.name, 60)} now runs Claude Code with the office hooks. Its next run asks here.`
        : `Supervise in office: Paperclip took the change for ${text(a.name, 60)}, but ${after.why}`);
      return { ok: after.state === 'supervised', supervision: after };
    } finally { conn.busy.delete(a.id); changed(); }
  }

  return { connect, disconnect, supervise, view, labelOf, knows, state: () => (c ? c.state : 'off') };
}
