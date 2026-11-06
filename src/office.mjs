// The office: its state and its handlers, composed once (createOffice) and reached only through its core (office-core.mjs):
// a route table and handle(request). Nothing here listens, parses a body or writes a socket: the HTTP server (server.mjs) and the
// test driver (test/fixtures/office-inproc.mjs) are its two adapters. What the adapter owes the office at start-up (the files, in
// their order) is in the returned object: own(), claim(), resume().
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as git from './git.mjs';
import * as launch from './launch.mjs';
import { createCampus } from './campus.mjs';
import { slimPayload, cleanIds as cleanPaperclipIds } from './payload.mjs';
import { createHq } from './paperclip.mjs';
import { recap as recapOf, away as awayOf } from './rituals.mjs';
import { createTracker, clip } from './tracker.mjs';
import { createAdmission } from './admission.mjs';
import { createRegistry, providerEvents, traitsOf, DEFAULT_PROVIDER } from './providers/index.mjs';
import { createLocal } from './providers/local.mjs';
import { createExplainer } from './explain.mjs';
import { createAcp, AGENTS as ACP_AGENTS } from './providers/acp.mjs';
import { createAgentFramework } from './providers/agent-framework.mjs';
import { createFoundry } from './providers/foundry.mjs';
import { createCopilotStudio } from './providers/copilot-studio.mjs';
import { createClaudeCode, claudeVersion, MODEL_RE, MODES } from './providers/claude-code.mjs';
import { placeOfSession, adoptLegacy, normPath } from './place.mjs';
import { createState } from './state.mjs';
import { addRecent, recentChoices } from './recent.mjs';
import { cleanRecord, layoutView, catalogView, functionOf } from './archetypes.mjs';
import { createManager, createPlanBoard, officeSource } from './manager.mjs';
import { setPersona, removePersona, personaOf, personaPrompt, addStarters, addStarterTeams, setTeam, removeTeam, teamOf, exportCustom, importCustom, setScreen } from './personas.mjs';
import { createHolds } from './holds.mjs';
import { createNotes, scanNote } from './notes.mjs';
import { createSkills } from './skills.mjs';
import { record as recordTrust, patternOf, propose, grant as grantTrust, withdraw as withdrawTrust, cards as trustCards } from './trust.mjs';
import { setRule, ruleOf, decide, preToolDecision, permissionModeFor, openRefusal, enforcement, addCost, costThisMonth } from './security.mjs';
import { realInside } from './risk.mjs';
import { createExtensions } from './extensions.mjs';
import { createSchedules } from './schedules.mjs';
import * as auth from './auth.mjs';
import '../public/format.js'; // money, plurals and short paths, shared with the page (globalThis.OfficeFormat)
import '../public/vocab.js'; // session vocabulary, shared with the page (globalThis.OfficeVocab)
import '../public/ask.js'; // the ask-first protocol, shared with the page (globalThis.OfficeAsk)
import '../public/wire.js'; // the /events wire format: lean snapshot and patches, shared with the page (globalThis.OfficeWire)
const V = globalThis.OfficeVocab;
const W = globalThis.OfficeWire;
import { createCore, staticRoutes, httpError, askFirst, reply } from './office-core.mjs';
import { createRoomAwareness } from './room-awareness.mjs';
import { hookSettings } from './hook-settings.mjs';
import * as startup from './startup.mjs';
import { officeIdOf as openclawOfficeId, gateRequest as openclawRequest } from './providers/openclaw.mjs';

/**
 * cfg: root (the office folder), port, files (officeFiles), agentToken, pageToken, launchCodes (auth.createLaunchCodes), remote and
 * remotePageToken (auth.remoteConfig), writeSecret(file, text) (owner-only write), cloud (readCloud: the cloud kinds' settings).
 * warmWalker: false keeps the process helper from starting (a test driver). The cloud settings come first and in the adapter:
 * cloudConfig takes the token settings out of process.env before anything starts a process.
 */
export function createOffice(cfg) {
  const { root: ROOT, port: PORT, files: FILES, agentToken: AGENT_TOKEN, pageToken: PAGE_TOKEN, launchCodes, remote: REMOTE, writeSecret, cloud: CLOUD } = cfg;
  const TOKEN_FILE = FILES.token;
  const HOOKS_CMD_FILE = FILES.hooksCmd;
  const HOOKS_HTTP_FILE = FILES.hooksHttp;
  const STATE_FILE = FILES.state;
  const MCP_FILE = FILES.mcp;
  const HISTORY_FILE = FILES.history;
  // How long the office holds a permission prompt before handing it back to the terminal dialog.
  const HEADLESS_ASK_MS = 15 * 60 * 1000; // sessions run inside the office have no terminal dialog to fall back to
  const ASK_TIMEOUT_MS = (Number(process.env.OFFICE_ASK_TIMEOUT_S) || 60) * 1000;
  // A Paperclip run's call (#76): `claude --print` has no terminal dialog, so it waits as long as an office session's (tests: shorter).
  const PAPERCLIP_ASK_MS = (Number(process.env.OFFICE_PAPERCLIP_ASK_S) || HEADLESS_ASK_MS / 1000) * 1000;

  // ---------- setup: hook settings ----------
  // The saved state (state.mjs): each area owns its slice and its cleaner; the server reads a slice by name. Folders that are gone drop
  // out of Recent (cleanRecent, recent.mjs, also drops agent room folders, those of older runs). The Security room rules, the Spend
  // ledger, earned trust, function floors, room records and the rest are cleaned by their own area (SLICES).
  // The office writes its saved state only once it owns its port: the listen callback calls saved.claim(), which writes it whole and
  // owner-only. Before that a change stays in memory: a copy on a busy port writes nothing, also when its recent folders became
  // buildings (and got a floor record) while it asked the running office for a launch link (#92 review).
  let ownPort = false;   // the past sessions (saveHistory) follow the same rule
  const saved = createState({ file: STATE_FILE, writeFirst: writeSecret });
  const savePersisted = () => saved.save();
  const rememberDir = (dir) => {
    saved.set('recent', addRecent(saved.get('recent'), dir));
    savePersisted();
  };

  // The settings files Claude Code gets (hook-settings.mjs); written by the HTTP adapter once the office owns its port.
  const { commandSettings, httpSettings, mcpConfig } = hookSettings({ root: ROOT, port: PORT, agentToken: AGENT_TOKEN });

  // Use HTTP hooks only after a probe proved them on this Claude Code version (npm run probe).
  const CLAUDE_VERSION = claudeVersion();
  const httpProven = () => saved.get('httpHooks')?.ok === true && saved.get('httpHooks').version === CLAUDE_VERSION;
  let hooksMode = process.env.OFFICE_HOOKS === 'command' ? 'command' : (process.env.OFFICE_HOOKS === 'http' || httpProven() ? 'http' : 'command');
  const activeHooksFile = () => (hooksMode === 'http' ? HOOKS_HTTP_FILE : HOOKS_CMD_FILE);

  // ---------- past sessions ----------
  // Sessions that run inside the office are saved, so a restart or a closed session can be reopened
  // with `claude --resume`. They are listed under Past sessions, never on the floor.
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { /* first run */ }
  for (const h of history) h.endedAt = h.endedAt || Date.now(); // whatever was running died with the last server
  let historyTimer = null;
  const HISTORY_CALLS = 40; // tool calls a past record keeps, for the timeline and Export
  function saveHistory() {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => { if (!ownPort) return; try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch { /* ignore */ } }, 800);
  }
  // A reopened session replaces its past record when it has a sid, which is when it records itself (the tracker saves a
  // session at once when its sid first arrives). Until then the past record stays: a reopen that fails before init must
  // not lose the session (#54). While the reopened session is live, its past record is hidden and cannot be reopened again.
  // A session that is open now is recorded too (a crash must leave a resumable record), but it is not past: Past sessions,
  // search and Reopen all treat it as in use until it ends (#105).
  const reopening = new Map(); // uid of the reopened session -> uid of the past record
  function pastInUse() {
    const used = new Set();
    for (const [uid, s] of sessions) if (s.status !== 'ended') used.add(uid);
    for (const [id, past] of reopening) { const s = sessions.get(id); if (s && s.status !== 'ended') used.add(past); }
    return used;
  }
  const pastShown = () => { const used = pastInUse(); return history.filter((h) => !used.has(h.uid)); };
  // A call kept in history.json: the page's lean form, with keys and token values in its command or error masked (the file keeps commands, #72).
  const maskedCall = (c) => { const o = W.leanCall(c), R = globalThis.OfficeFormat.redactSecrets; return { ...o, detail: R(o.detail), ...(o.err ? { err: R(o.err) } : {}) }; };
  function recordHistory(s) {
    if (!s.headless) return;
    if (!s.sid) { if (s.status === 'ended') { failedReopen(s); failedFork(s); } return; }
    forkTrees.delete(s.uid); // it started: the worktree is its own now
    const rec = {
      uid: s.uid, sid: s.sid, provider: s.provider, name: s.name, cwd: s.cwd, model: s.model, mode: s.mode, cost: s.cost, turns: s.turns,
      startedAt: s.startedAt, endedAt: s.endedAt, worktree: s.worktree, replies: s.replies.slice(-40), prompt: s.prompt, budget: s.budget,
      ...(s.costUnknown ? { costUnknown: true } : {}),
      ...(s.error ? { failed: true } : {}), // a failed run, for the trust card (#153)
      // OpenClaw (#77): the Gateway session key its plugin knows the session by, so a Reopen keeps holding its calls.
      ...(s.gatewayKey ? { gatewayKey: s.gatewayKey } : {}),
      // For Export of a past session (#72): the tokens and the last calls, trimmed like the page's own list.
      usage: s.usage, calls: s.calls.slice(-HISTORY_CALLS).map(maskedCall),
    };
    const past = reopening.get(s.uid);
    if (past) { reopening.delete(s.uid); history = history.filter((h) => h.uid !== past); }
    const i = history.findIndex((h) => h.uid === s.uid);
    if (i >= 0) history[i] = rec; else history.unshift(rec);
    history = history.slice(0, 60);
    saveHistory();
  }

  // The provider could not continue the past conversation and started a new one (events.fresh, before the sid). It is a new
  // session, as for an agent kind that cannot resume: the past record stays, and the old replies and cost are not its own.
  function freshReopen(s) {
    if (!reopening.delete(s.uid)) return;
    s.replies = []; s.replySeq = 0; s.costBase = 0; s.cost = null; s.turns = 0; s.prompt = '';
  }

  // A fork (#72) made its worktree before the agent proved it can fork. When the session ends before init, the empty worktree and its
  // branch go with it (it holds no work: the agent never ran in it). This and the catch in forkSession are the one exception to
  // "the office never removes a worktree by itself" (CLAUDE.md): git.discardNew takes only the object createWorktree returned
  // for this fork, never a past record's or another session's worktree.
  const forkTrees = new Map(); // uid of a forked session -> the worktree createWorktree made for it, until it has started
  function failedFork(s) {
    const wt = forkTrees.get(s.uid);
    if (!wt) return;
    forkTrees.delete(s.uid);
    git.discardNew(wt).then(() => addFeed(s, 'start', 'The fork did not start. The new worktree and its branch are removed.'), () => addFeed(s, 'start', `The fork did not start. The new worktree stays at ${wt.root}.`));
  }

  // The reopened session ended before init: the past record stays in Past sessions, and the session shows why.
  function failedReopen(s) {
    if (!reopening.delete(s.uid)) return;
    tracker.failReopen(s);
  }

  // ---------- state ----------
  // The session rules are in tracker.mjs. The server gives it the real clock, git, persistence and broadcast.
  const clients = new Set(); // the open /events feeds: each is a function that writes one chunk
  const tracker = createTracker({
    locate: (cwd) => git.locate(cwd),
    onChange: () => broadcast(),
    releaseHold: (id, decision) => releaseHold(id, decision),
    // The check before a hold: the Security room rules answer Allow and Deny at once (security.mjs decide).
    screen: (s, p, opts) => decide(saved.get('security'), callOf(s, p, opts)),
    persist: {
      history: (s) => recordHistory(s),
      recentDir: (dir) => rememberDir(dir),
      commands: (list) => { saved.set('commands', list); savePersisted(); },
      placed: (s, g) => { adoptNotes(roomPlace(s)); if (g) addRepo(g.repo); },
      spent: (s, dollars) => { saved.set('costs', addCost(saved.get('costs'), Date.now(), V.security.columnOf(s.provider), dollars)); savePersisted(); },
    },
  });
  const { sessions, feed, addFeed, newSession, placeSession, findSession, onHook, endSession } = tracker;

  // ---------- the Security room: the user's permission rules (#70) ----------
  // The rules live in security.mjs and public/vocab.js; this file applies them. A call is rated against the session's root
  // (tracker.rootOf, like the Approve card) in its building. A session not placed yet (git not looked up) has no building
  // (null): the office-wide rule applies unless some building has a stricter override, and then the call is held.
  const buildingOfSession = (s) => (s.placed ? roomPlace(s).buildingKey : null);
  // The root is in a git worktree: the office made one for the session, or git placed the session in a repository whose
  // worktree holds the root. Only then do the rows Read inside and Edit inside apply (a terminal session in the home folder
  // or in a folder outside git has no worktree, so its edits are Ask by default). git gives the long path of the root, and
  // the session's folder can be an 8.3 short name of it (TEMP on GitHub's Windows runner is C:\Users\RUNNER~1\...), so the
  // check is realInside, not a text compare: else a user's rule on Edit inside would not apply to that session.
  function inWorktree(s, root) {
    if (s.worktree && s.worktree.root) return true;
    return !!(s.placed && s.git && s.git.root && root && realInside(s.git.root, root));
  }
  function callOf(s, p, opts = {}) {
    const root = tracker.rootOf(s);
    return { building: buildingOfSession(s), kind: s.provider, tool: p.tool_name, input: p.full_input || p.rate_input || p.tool_input, root, worktree: inWorktree(s, root), provider: opts.provider === true, firm: opts.firm === true };
  }
  // Claude Code's PreToolUse: a Deny rule refuses the call before Claude Code's own permission check (its allow rules and
  // modes cannot run it), and a tightened read or edit inside makes Claude Code ask. Returns the hook's answer, or null.
  function preToolGate(p) {
    if (p.hook_event_name !== 'PreToolUse') return null;
    const s = findSession(p);
    if (!s || s.status === 'ended' || providerOf(s) !== claude) return null;
    const d = preToolDecision(saved.get('security'), callOf(s, p));
    if (!d) return null;
    if (d.decision === 'deny') tracker.refuseCall(s, p, d.reason, d.line);
    return claude.preToolAnswer(d);
  }
  // The building key of a folder for the rules at open: the repository of a worktree, or of the folder; '' outside git.
  async function buildingOfFolder(cwd, worktree) {
    if (worktree && worktree.repo) return normPath(worktree.repo);
    const g = await git.locate(cwd).catch(() => null);
    return g ? normPath(g.repo) : '';
  }
  // One change from the wall (the page's Security room screens). Each change writes a feed line.
  function saveRule(body) {
    const scope = body.scope; // setRule checks it: 'office' or 'building'
    const r = setRule(saved.get('security'), { scope, building: body.building, row: String(body.row || ''), col: String(body.col || ''), value: body.value ?? null, confirmed: body.confirmed === true });
    saved.set('security', r.rules);
    savePersisted();
    const S = V.security, col = S.columns.find((c) => c.id === body.col);
    const where = scope === 'building' ? (body.building ? `the building ${basename(body.building) || body.building}` : 'Other folders') : 'all buildings';
    addFeed({ uid: 'security', name: 'Security' }, 'tool', `${S.rows[body.row].label}, ${col.label}: ${S.word(r.to)} (${where})`);
    broadcast();
    providers.forgetStatus(); // readiness reads this rule (blocked), so the kept GET /api/providers answer is stale (#104)
    void refreshEnforce(true); // an agent whose own config carries the cells checks it again for the new cells
    return { ok: true, from: r.from, to: r.to };
  }
  // Earned trust (#153, trust.mjs). The snapshot carries proposals and trust cards; the user applies a proposal on the wall's
  // painted Confirm (the same looser-change path as a rule: 409 without confirmed: true), withdraws a grant, or dismisses one.
  function trustView() {
    const runs = [...history, ...[...sessions.values()].filter((x) => x.headless && x.status === 'ended' && x.sid && !history.some((h) => h.uid === x.uid))]
      .map((h) => ({ col: V.security.columnOf(h.provider), failed: !!(h.failed || h.error) }));
    return {
      proposals: propose(saved.get('trust').ledger, saved.get('security'), { dismissed: saved.get('trust').dismissed }),
      grants: saved.get('trust').grants, cards: trustCards(saved.get('trust'), runs),
    };
  }
  function applyProposal(body) {
    const p = propose(saved.get('trust').ledger, saved.get('security'), { dismissed: saved.get('trust').dismissed }).find((x) => x.id === String(body.id || ''));
    if (!p) throw httpError(404, 'That proposal is gone.');
    const r = grantTrust(saved.get('security'), saved.get('trust'), p, Date.now(), body.confirmed === true);
    saved.set('security', r.rules); saved.set('trust', r.trust); savePersisted();
    addFeed({ uid: 'security', name: 'Security' }, 'tool', `${p.rowLabel}, ${p.agent}: Allow (${p.buildingName}), earned by ${p.count} approvals`);
    broadcast(); providers.forgetStatus(); void refreshEnforce(true);
    return { ok: true, from: r.from, to: r.to };
  }
  function withdrawGrant(body) {
    const r = withdrawTrust(saved.get('security'), saved.get('trust'), String(body.id || ''));
    saved.set('security', r.rules); saved.set('trust', r.trust); savePersisted();
    addFeed({ uid: 'security', name: 'Security' }, 'tool', `a trust grant was withdrawn: ${r.to ? V.security.word(r.to) : 'unchanged'}`);
    broadcast(); providers.forgetStatus(); void refreshEnforce(true);
    return { ok: true };
  }
  function dismissProposal(body) {
    const id = String(body.id || '');
    if (!propose(saved.get('trust').ledger, saved.get('security'), { dismissed: saved.get('trust').dismissed }).some((x) => x.id === id)) throw httpError(404, 'That proposal is gone.');
    saved.set('trust', { ...saved.get('trust'), dismissed: { ...saved.get('trust').dismissed, [id]: Date.now() } }); savePersisted(); broadcast();
    return { ok: true };
  }
  // What each agent kind enforces (security.mjs enforcement): from the providers of this office, and for an agent whose
  // own config carries the rules (OpenClaw: workspace-only and its office plugin, #77), from what that config was found to carry (provider.policy(), read-only). It is read
  // at start, after a rule change and when the page asks for the agent kinds; a policy is null while the kind is off.
  let ENFORCE = null;
  async function refreshEnforce(fresh = false) {
    const policies = {};
    for (const p of providers.list()) {
      if (typeof p.policy !== 'function') continue;
      try { const v = await p.policy(fresh); if (v) policies[p.kind] = v; } catch { /* unreadable: what the provider claims stays */ }
    }
    const next = enforcement(providers.list(), policies);
    if (JSON.stringify(next) !== JSON.stringify(ENFORCE)) { ENFORCE = next; broadcast(); }
  }

  // ---------- providers: the agent tools behind the sessions (providers/) ----------
  // Every provider reports through the same events into the tracker: Claude Code, Ollama, LM Studio, Agent Framework, the ACP agents and the
  // Microsoft cloud kinds (Azure AI Foundry, Copilot Studio). Claude
  // Code's hooks come in over the hook routes below, and a permission decision goes back as the hook's answer (claude.answer
  // gives the body). The other providers raise their requests through events.permission; events.drop frees one their agent no
  // longer waits for (releaseHold with no decision); events.fresh says a reopen could not continue the conversation (freshReopen).
  // A quiet answer (a low call the local model asks about, allowed by its default cell) changes nothing the page shows: no snapshot.
  const events = providerEvents({ tracker, onChange: () => broadcast(), hold: (r) => { holdRequest(r); if (!r.quiet) broadcast(); }, release: (id) => releaseHold(id, {}), fresh: freshReopen });
  const claude = createClaudeCode({ events, files: () => ({ settings: activeHooksFile(), mcp: MCP_FILE, launcher: path.join(ROOT, 'launch.ps1') }) });
  // The four office tools for agents the office runs itself (no MCP process): the same handlers the /mcp/* routes call.
  // They answer text or throw httpError. Function declarations are hoisted, so they are ready when a local agent calls one.
  const officeTools = {
    inbox: (s) => inboxText(s),
    ask: async (s, question) => (await askUser(s, question).done).text,
    room: async (s) => describeRoom(await roomOf(s)),
    roomUpdate: async (s, args) => updateRoom(await roomOf(s), args),
    mail: (s, to, text) => mailText(s, to, text),
  };
  const ollama = createLocal({ events, kind: 'ollama', baseUrl: process.env.OFFICE_OLLAMA_URL, officeTools });
  const lmstudio = createLocal({ events, kind: 'lmstudio', baseUrl: process.env.OFFICE_LMSTUDIO_URL, officeTools });
  // An Agent Framework team runs on one of the local servers (#23): LM Studio first, the order of its models list.
  const agentFramework = createAgentFramework({ events, servers: [lmstudio, ollama], officeTools });
  // A free local model explains the requests that wait for the user (#149). It runs after the Security room rules and the hold,
  // off the hot path, and only adds text to the request: it never decides. OFFICE_EXPLAIN=off turns it off;
  // OFFICE_EXPLAIN_MODEL names the model (else the first chat model of the first local server that is ready).
  const explainer = String(process.env.OFFICE_EXPLAIN || '').toLowerCase() === 'off' ? null
    : createExplainer({ providers: [lmstudio, ollama], model: process.env.OFFICE_EXPLAIN_MODEL });
  function explainHeld(s, id) {
    const r = explainer && s.pending.find((x) => x.id === id);
    if (!r) return;
    let call;
    try { const R = globalThis.OfficeFormat.redactSecrets; call = { tool: r.tool, detail: R(r.detail), preview: R(r.preview) }; } catch { return; }
    explainer.explain(call).then((e) => {
      if (e && holdQueue.has(id)) { tracker.explainRequest(s.uid, id, e); broadcast(); }
    }, () => {});
  }
  const providers = createRegistry([claude, ollama, lmstudio, agentFramework,
    // ACP agents (providers/acp.mjs): Hermes Agent, DeepSeek Harness, OpenClaw and Copilot CLI, one entry each in its AGENTS list.
    // blocked: the Security room's answer to whether this kind may run now (its Agents screen: an ungated kind is off until
    // turned on, a no-cost Deny). One rule source. tokenFile: the OpenClaw plugin must read this office's token (#77).
    ...Object.keys(ACP_AGENTS).map((kind) => createAcp({ events, kind, tokenFile: TOKEN_FILE,
      blocked: () => openRefusal(saved.get('security'), providers.get(kind)) })),
    // The Microsoft cloud kinds are off until the owner sets them up in the environment (docs/agents.md). Nothing here calls the network
    // or signs in. Like the ungated ACP agents, the Agents screen of the Security room keeps them off until it turns them on.
    ...[['foundry', createFoundry, CLOUD.foundry], ['copilot-studio', createCopilotStudio, CLOUD.studio]].map(([kind, create, config]) => create({ events, config,
      blocked: () => openRefusal(saved.get('security'), providers.get(kind)) }))]);
  const providerOf = (s) => providers.of(s);
  ENFORCE = enforcement(providers.list());
  // The agent kinds as the page offers and shows them (providers/index.mjs describe). Fixed while the server runs.
  const KINDS = providers.kinds();

  const basename = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

  // ---------- Paperclip as an optional HQ (#76, paperclip.mjs) ----------
  // Off until the user connects it (Attach sessions); the connection is kept in state.json (url and company, no secret) and
  // made again at start. The office reads Paperclip and never drives it: no heartbeat, no task, no routine. The one write is
  // Supervise in office (one PATCH of one agent's adapter config, after the Security room's painted Confirm; ADR 0005). Its
  // Claude Code runs then come in through the command hooks file of this office, like terminal sessions, with the run's ids.
  // Paperclip owns the budgets of its runs: the office shows them and sets no second limit (a hook session has no spend limit).
  const PAPERCLIP = { uid: 'paperclip', name: 'Paperclip' };
  const hq = createHq({
    sessions: () => [...sessions.values()], // the plan source links a Paperclip task to the session that runs it (#155)
    hooksFile: () => HOOKS_CMD_FILE.replace(/\\/g, '/'),
    onChange: () => broadcast(),
    onFeed: (text, kind) => addFeed(PAPERCLIP, kind, text),
    // A run ended. One whose held call timed out (the office denied it) and that Paperclip marks succeeded is named, so the
    // success in Paperclip is not read as "the work was done" (spike #75).
    onRun: ({ runId, status }) => {
      if (status !== 'succeeded') return;
      for (const s of sessions.values()) {
        if (!s.paperclip || s.paperclip.run !== runId || s.paperclipDenied !== runId) continue;
        s.paperclipDenied = null;
        addFeed(s, 'wait', 'Paperclip marked this run succeeded, but the office denied a call of it that waited with no answer.');
        broadcast();
      }
    },
  });
  async function connectHq(body) {
    const r = await hq.connect({ url: body.url, company: body.company ? String(body.company) : null });
    if (r && r.ok) {
      const v = hq.view();
      saved.set('paperclip', { url: v.url, company: v.company ? v.company.id : null });
      savePersisted();
      addFeed(PAPERCLIP, 'start', `connected: ${v.company ? v.company.name : 'Paperclip'} at ${v.url}. The office watches it and never sends heartbeats or tasks.`);
    }
    broadcast();
    return { ...r, hq: hq.view() };
  }
  function disconnectHq() {
    hq.disconnect();
    if (saved.get('paperclip')) { saved.set('paperclip', undefined); savePersisted(); addFeed(PAPERCLIP, 'end', 'disconnected. Paperclip runs on as before.'); }
    broadcast();
    return { ok: true };
  }
  // Goal handoff (ADR 0007, #159): the second and last write to Paperclip. Without confirmed: true the answer is 409 with the exact tasks the Confirm shows.
  async function handoffGoalHq(body) {
    const company = hq.view()?.company;
    if (!company) throw httpError(409, 'Paperclip is not connected, so there is no company to hand this goal to.');
    const g = manager.get(String(body.id || ''));
    if (!g) throw httpError(404, 'No such goal.');
    if (body.confirmed !== true) throw askFirst('handoff', `Create ${g.steps.length} tasks in ${company.name || 'Paperclip'}? The office writes these tasks and nothing else. It never assigns, changes or deletes a task.`, { tasks: hq.handoffTasks(g).map((t) => ({ step: t.step, title: t.title, description: t.description })) });
    const r = await manager.handoff(g.id, (goal, written) => hq.handoffGoal(goal, written));
    broadcast();
    if (!r.ok) throw httpError(r.status, r.reason);
    return { ok: true, plans: planBoard.snapshot().plans.filter((p) => p.id === g.id) };
  }
  // Supervise in office (#76): one PATCH, only with the Confirm the Security room's Agents screen paints.
  async function superviseHq(body) {
    if (body.confirmed !== true) throw httpError(409, 'Confirm Supervise in office first. It writes to the agent\'s config in Paperclip.');
    const r = await hq.supervise(String(body.agent || ''));
    broadcast();
    return r;
  }

  // ---------- buildings: repositories and their worktrees (campus.mjs) ----------
  // A repository is known when a session works in it or it is a recent folder. The campus owns the buildings, layouts, room
  // records, change views, tree cache and floor actions; the server hands it the state slice, the live sessions and git.
  const repoKey = normPath;
  const campus = createCampus({
    git, state: saved.slice('layouts', 'rooms', 'merges'), save: savePersisted, sessions: () => sessions.values(), roomPlace: (s) => roomPlace(s), changed: () => broadcast(),
    adoptNotes: (pl) => adoptNotes(pl), feed: (s, k, t) => addFeed(s, k, t), fail: (st, m) => httpError(st, m), askFirst: (k, t) => askFirst(k, t),
    recent: saved.get('recent'),
  });
  const { addRepo, refreshRepo, layoutRecord, seatOfSession, noteRooms, roomsView, layoutsView, changeLayout, changesStale,
    changesView, mergeChange, repoTree, floorAction } = campus;
  campus.start();

  // Finds the claude process above a hook's parent, so the office can close sessions it did not launch.
  // The hook's parent shell dies right after the hook returns, so the walk has to happen while the hook
  // still waits. A persistent PowerShell helper makes that walk in ~100 ms instead of a ~550 ms cold start.
  const WALK = [
    'while (($l = [Console]::In.ReadLine()) -ne $null) {',
    '  $i = [int]$l; $found = 0',
    '  for ($n = 0; $n -lt 10; $n++) {',
    '    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$i"',
    '    if (-not $p) { break }',
    "    if ($p.Name -eq 'claude.exe' -or ($p.Name -eq 'node.exe' -and $p.CommandLine -match 'claude-code')) { $found = $p.ProcessId; break }",
    '    $i = $p.ParentProcessId',
    '  }',
    '  [Console]::Out.WriteLine("$l=$found"); [Console]::Out.Flush()',
    '}',
  ].join('\n');
  let walker = null;
  const walks = new Map();
  function startWalker() {
    const child = spawn(launch.resolveExe('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', WALK], { cwd: launch.helperCwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const [key, pid] = buf.slice(0, i).trim().split('=');
        buf = buf.slice(i + 1);
        const done = walks.get(key);
        if (done) { walks.delete(key); done(Number(pid) || null); }
      }
    });
    child.on('exit', () => { walker = null; for (const done of walks.values()) done(null); walks.clear(); });
    child.stdin.on('error', () => {});
    return child;
  }
  function walkToClaude(ppid) {
    if (process.platform !== 'win32') return Promise.resolve(ppid);
    const key = String(Number(ppid) | 0);
    if (!walker) walker = startWalker();
    return new Promise((resolve) => {
      const t = setTimeout(() => { walks.delete(key); resolve(null); }, 1200);
      walks.set(key, (pid) => { clearTimeout(t); resolve(pid); });
      walker.stdin.write(key + '\n');
    });
  }
  // Warm the helper now so the first session start is fast too.
  if (process.platform === 'win32' && cfg.warmWalker !== false) walker = startWalker();

  let probeSeen = null; // while probing: which events arrived over HTTP

  // The session rules (hook switch, tool calls, stream lines) live in tracker.mjs.

  // answers: false for a message the page sends by itself (Resume's "Continue.", Retry), which must never answer a question (#27 L1).
  function sendMessage(uid, text, attachments = [], { answers = true } = {}) {
    const s = sessions.get(uid);
    if (!s || s.status === 'ended') throw httpError(404, 'That session has left the office.');
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean && !attachments.length) throw httpError(400, 'The message is empty.');
    if (attachments.length && !s.headless) throw httpError(400, 'Attachments work in sessions that run inside the office.');
    // A pending office_ask takes the next message as its answer.
    const q = s.questions[0];
    if (answers && q && clean && holdQueue.has(q.id)) { releaseHold(q.id, { text: clean }); addFeed(s, 'prompt', 'answered in the office: ' + clip(clean, 100)); return { answered: true }; }
    if (s.headless && (s.status !== 'working' || attachments.length)) {
      writeUser(s, standupLine(s) + clean, attachments);
      tracker.startTurn(s, clean || '(attachment)');
      return { sent: true };
    }
    if (!clean) throw httpError(400, 'The message is empty.');
    s.inbox.push({ t: Date.now(), text: clean });
    addFeed(s, 'prompt', 'queued from the office: ' + clip(clean, 100));
    broadcast();
    return { queued: s.inbox.length };
  }

  // ---------- held requests: permission prompts and office_ask questions wait for the user ----------
  // A hold ends with one decision: { allow, always } for a permission prompt, { text } for a question, {} for none (dropped,
  // timed out, or the turn ended). `reply` takes it to the agent: the hook's or office_ask's HTTP answer, or the provider.
  // holds.mjs owns the queue, its timers and the release; this file gives it the tracker and the broadcast.
  const holdQueue = createHolds({ settle: (uid, id) => tracker.settle(uid, id), changed: () => broadcast() });
  const forget = (id) => holdQueue.forget(id);
  const releaseHold = (id, decision) => holdQueue.release(id, decision);

  // The user answered a held permission request on the page: it is evidence for earned trust (trust.mjs). Only a call the wall
  // has a cell for counts. A hold that timed out or went back to the terminal is no answer and is not recorded.
  function noteDecision(id, s, allow) {
    const c = holdQueue.callOf(id);
    if (!c || !s || c.building == null) return;
    const r = ruleOf(c);
    if (!r.col || !r.row || !V.security.rows[r.row]) return;
    saved.set('trust', recordTrust(saved.get('trust'), { at: Date.now(), col: r.col, building: c.building, row: r.row, pattern: patternOf(c.tool, c.input), allow, risk: r.risk }));
    savePersisted();
  }

  // A permission request waits for the user. The session's provider turns the decision into its own answer; on a hook (respond)
  // that answer is the hook's reply. A terminal session's request goes back to the terminal dialog after the short hold.
  // auto: the Security room rules decided (tracker screen). Nothing is held: a hook gets the answer now, a provider on a
  // later tick (its permission() returns the request id first, the seam's timing rule).
  function holdRequest({ s, id, suggestions, auto, call }, respond = null) {
      if (auto) {
      const answer = () => providerOf(s).answer(s, { id, suggestions: [] }, auto);
      if (respond) respond(answer()); else setImmediate(answer);
      return;
    }
    // A Paperclip run (#76) is a terminal session with no terminal: `claude --print` has no dialog to fall back to, so an
    // unanswered call is denied. It gets the hold of an office session, and the feed says what Paperclip will not (spike #75: a
    // run whose held call timed out was still marked succeeded). Every session with Paperclip run ids gets it, also one of a
    // company the office does not watch or while Paperclip is not connected: the company match is for its labels only.
    const paperclip = !s.headless && !!s.paperclip;
    const hold = s.headless ? HEADLESS_ASK_MS : paperclip ? PAPERCLIP_ASK_MS : ASK_TIMEOUT_MS;
    const after = () => {
      if (paperclip) { s.paperclipDenied = s.paperclip.run || true; addFeed(s, 'wait', 'question timed out, the office denied the call. Paperclip may still mark this run succeeded.'); }
      else addFeed(s, 'wait', s.headless ? `question timed out, ${providerOf(s).label} moved on` : 'question went back to the terminal');
    };
    // A Paperclip run gets a deny that says why (fail closed by the office's own answer, not by what print mode does with none).
    const decision = paperclip ? { allow: false, message: 'Agent Office got no answer in time, so this call is denied.' } : {};
    const reply = (d) => { const body = providerOf(s).answer(s, { id, suggestions }, d); if (respond) respond(body); };
    holdQueue.add(id, { uid: s.uid, reply, suggestions, call: call ? callOf(s, call) : undefined, timeout: { ms: hold, decision, after } });
    explainHeld(s, id);
  }

  // The answer of a hook that waits on its HTTP request: a promise that settles with the decision's body.
  function onPermission(p, signal) {
    p.paperclip = cleanPaperclipIds(p.paperclip); // plain ids or nothing, as on /hook (the command hook posts a permission request here)
    const r = tracker.permissionRequest(p);
    if (!r) return {};
    return new Promise((resolve) => {
      holdRequest(r, (body) => resolve(body || {}));
      if (r.auto) return broadcast();
      // The terminal answered first and Claude cancelled the hook: drop the question.
      signal.addEventListener('abort', () => forget(r.id), { once: true });
      broadcast();
    });
  }

  function sessionFor(p) {
    for (const s of sessions.values()) if (p.office_id && s.officeId === p.office_id) return s;
    for (const s of sessions.values()) if (p.pid && s.pid === p.pid && s.status !== 'ended') return s;
    return null;
  }

  // The text office_inbox answers with. The MCP route and the local-model provider (officeTools below) both call it.
  function inboxText(s) {
    if (!s.inbox.length) return 'No new messages.';
    const text = s.inbox.map((m) => '- ' + m.text).join('\n');
    s.inbox = []; addFeed(s, 'tool', 'read the office inbox'); broadcast();
    return text;
  }
  // office_mail (#21): one agent writes to another agent of its goal. manager.mail() applies the rules (a running goal, a named agent of the
  // building, the hop and message caps); what an agent writes is scanned like a notes line, because the next agent reads it as context.
  // The receiver gets it as a message (a turn, or its inbox while it works), and the sender gets a feed line.
  function mailText(s, to, text) {
    const body = String(text ?? '').trim().slice(0, 2000);
    if (!body) return 'Mail failed: the text is empty.';
    const why = scanNote(body);
    if (why) return 'Mail refused: ' + why + '.';
    const r = manager.mail({ from: s.uid, to, text: body });
    if (!r.ok) return 'Mail not sent: ' + r.reason;
    addFeed(s, 'tool', `mailed ${r.to}: ${clip(body, 80)}`);
    broadcast();
    return `Mail sent to ${r.to}.`;
  }
  function deliverMail(toId, fromName, text) {
    try { sendMessage(toId, `Mail from ${fromName}: ${text}`, [], { answers: false }); return true; }
    catch (e) { console.warn(`Manager: mail to ${toId} was not delivered: ${e.message}`); return false; }
  }
  function onMcpMail(p) {
    const s = sessionFor(p);
    return { text: s ? mailText(s, p.to, p.text) : 'Agent Office does not recognise this session, so the mail was not sent.' };
  }
  function onMcpInbox(p) {
    const s = sessionFor(p);
    return { text: s ? inboxText(s) : 'Agent Office does not recognise this session. Start it from the office or with the office settings file.' };
  }

  function onMcpAsk(p, signal) {
    const s = sessionFor(p);
    if (!s) return { text: 'Agent Office does not recognise this session, so the question was not shown. Ask in the terminal.' };
    const a = askUser(s, p.question);
    signal.addEventListener('abort', () => forget(a.id), { once: true });
    return a.done;
  }
  // A question to the user (office_ask). { id, done }: done resolves to { text } when the user answers, or after 10 minutes.
  function askUser(s, question) {
    const id = tracker.askQuestion(s, question);
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    holdQueue.add(id, { uid: s.uid, kind: 'ask', reply: (d) => resolve(d), timeout: { ms: 10 * 60 * 1000, decision: { text: 'No answer from the office after 10 minutes. Continue without it, or ask in the terminal.' } } });
    broadcast();
    return { id, done };
  }


  // OpenClaw (#77): the Agent Office plugin in the OpenClaw Gateway (src/integrations/openclaw-plugin) sends each tool call of an
  // office session here (agent token) and waits. The session is the live OpenClaw session whose Gateway key the plugin names;
  // its provider holds the call like every request (gate: the Security room rules, then the user). The answer is
  // { decision: 'allow' } or { decision: 'deny', reason }; the plugin denies on any other answer and on no answer. When the
  // plugin stops waiting (its limit, a cancelled call), signal aborts, the request closes and the hold goes.
  async function onOpenClawCall(body, signal) {
    const q = openclawRequest(body);
    if (!q.ok) return reply(400, { error: q.error });
    const deny = (reason) => ({ decision: 'deny', reason });
    // A reopened session keeps the key of its past record, so the key names the session, not its uid. The provider gives two live
    // sessions one key never (acp.mjs gatewayKeyOf); were there two, the call is denied, not put on the first one.
    const id = openclawOfficeId(q.call.sessionKey);
    const live = id ? [...sessions.values()].filter((x) => x.provider === 'openclaw' && x.status !== 'ended' && openclawOfficeId(x.gatewayKey) === id) : [];
    if (live.length > 1) return deny('Two Agent Office sessions have this OpenClaw session key, so the office cannot tell which one asks.');
    const s = live[0];
    if (!s) return deny('Agent Office has no open session for this OpenClaw session.');
    const p = providerOf(s);
    if (typeof p.gate !== 'function') return deny('Agent Office cannot hold the calls of this session.');
    const d = await p.gate(s, q.call, signal);
    return d.allow ? { decision: 'allow' } : deny(d.reason || 'Declined in Agent Office.');
  }

  // ---------- the room a session sits in (office_room, office_room_update) ----------
  // An agent can read its room and change two things in it: the notes board (the user's notes,
  // the saved 'notes' slice) and one short pin on the blackboard (the 'pins' slice). Both use the page's key for
  // the room (place.mjs noteKey), so what an agent writes shows on the boards the user looks at.
  // notes.mjs owns the rules (versions, merge, caps); this file only calls it and saves the maps.
  // An agent changes only its own room: the room comes from the calling session, never from the arguments.
  const board = createNotes({ notes: saved.get('notes'), pins: saved.get('pins') });
  // notes.mjs rule errors carry a status; the HTTP layer reads `status`.

  // Where a session sits (place.mjs). The snapshot carries it, so the page keeps no copy of the rules.
  const roomPlace = (s) => placeOfSession(s.git, s.cwd);
  // Room ids carry a hash now. A note or pin saved under the old key moves to the new one the first time its
  // room is seen, so nothing the user wrote is lost. Remove this when old state files are gone.
  function adoptNotes(pl) {
    if (adoptLegacy([saved.get('notes'), saved.get('pins')], pl)) savePersisted();
  }
  // The open sessions the page seats in a room (adapter.js live()).
  const inRoom = (key) => [...sessions.values()].filter((x) => x.status !== 'ended' && x.placed && roomPlace(x).noteKey === key);
  function allFigures() {
    const by = {};
    for (const x of sessions.values()) if (x.status !== 'ended' && x.placed) (by[roomPlace(x).noteKey] ||= []).push(x);
    const out = {};
    for (const k of Object.keys(by)) out[k] = V.figures(by[k]);
    return out;
  }

  // The calling session (found like /mcp/inbox finds it), with its place looked up.
  async function callerRoom(p) {
    const s = sessionFor(p);
    if (!s) throw httpError(404, 'Agent Office does not recognise this session, so it cannot find your room. Start the session from the office, or with the office settings file.');
    return roomOf(s);
  }
  async function roomOf(s) {
    if (!s.cwd) throw httpError(409, 'The office does not know the folder of this session yet. Try again after your next tool call.');
    await placeSession(s, !s.placed);
    return s;
  }
  // What an agent reads about its room and the two things it may change there (room-awareness.mjs).
  const roomAwareness = createRoomAwareness({
    board, roomPlace, inRoom, addFeed, changed: () => { savePersisted(); broadcast(); },
    floorName: (s, pl) => { const st = seatOfSession(s); const f = st && layoutView(layoutRecord(pl.buildingKey, pl.repoPath)).floors.find((x) => x.id === st.floor); return f ? f.name : 'Lobby'; },
  });
  const { describe: describeRoom, update: updateRoom } = roomAwareness;

  function answer(id, allow, always = false) {
    if (!holdQueue.has(id)) throw httpError(409, 'That question was already answered or went back to the terminal.');
    const uid = holdQueue.uidOf(id);
    if (holdQueue.kindOf(id) === 'ask') {
      const s0 = sessions.get(uid);
      if (s0) addFeed(s0, 'prompt', allow ? 'answered yes in the office' : 'answered no in the office');
      return void releaseHold(id, { text: allow ? 'Yes.' : 'No.' });
    }
    const s = sessions.get(uid);
    // The page never offers Always allow on a high-risk request; the server holds the same line (#27 L2).
    if (always && allow && s?.pending.find((r) => r.id === id)?.risk === 'high') throw httpError(400, 'A high-risk request cannot be always allowed.');
    if (s) addFeed(s, 'tool', allow ? (always ? 'approved and always allowed from the office' : 'approved from the office') : 'declined from the office');
    noteDecision(id, s, allow);
    releaseHold(id, { allow, always });
  }

  // ---------- sessions that run inside the office (no terminal) ----------
  // The session's provider runs the agent (providers/). The office marks the message on the session after the provider took it.
  // Stand-up (#151): at an agent's first turn of the day the prompt carries one line that asks for a note on the room's notes board (a desk
  // note the agent writes with office_room_update). Only the agents that have the office tools. Focus mode turns it off.
  const STANDUP_KINDS = new Set(['claude-code', 'ollama', 'lmstudio']);
  function standupLine(s) {
    const R = globalThis.OfficeVocab.rituals, t = Date.now();
    if (!s.headless || !STANDUP_KINDS.has(s.provider) || !R.standupDue(saved.get('standups'), s.name, t, { focus: saved.get('focus') })) return '';
    R.standupDone(saved.get('standups'), s.name, t); savePersisted();
    addFeed(s, 'tool', 'asked for a stand-up note');
    return R.STANDUP + '\n\n';
  }
  function writeUser(s, text, attachments = []) {
    providerOf(s).message(s, { text, attachments });
    tracker.userMessage(s);
  }

  // Control requests (change mode or model, connectors) are Claude Code's. Another provider has no `control`.
  function control(s, request, onDone) {
    const p = providerOf(s);
    if (typeof p.control !== 'function') throw httpError(409, `${p.label} does not take that request.`);
    p.control(s, request, onDone);
  }
  // Dismiss clears a failed turn's error for every surface at once (the rule is tracker.dismissError).
  function dismissError(uid) {
    const s = sessions.get(uid);
    if (!s) throw httpError(404, 'That session is not open.');
    tracker.dismissError(s);
  }
  function doControl(uid, action, value) {
    const s = sessions.get(uid);
    if (!s || !s.headless || s.status === 'ended') throw httpError(404, 'That session is not running in the office.');
    if (action === 'interrupt') {
      providerOf(s).interrupt(s);
      tracker.interrupt(s);
    } else if (action === 'mode') {
      if (!MODES.has(value)) throw httpError(400, 'Unknown permission mode.');
      control(s, { subtype: 'set_permission_mode', mode: value }, (r) => { if (r.response?.mode) s.mode = r.response.mode; broadcast(); });
    } else if (action === 'model') {
      if (!MODEL_RE.test(String(value))) throw httpError(400, 'Unknown model.');
      control(s, { subtype: 'set_model', model: value }, (r) => { if (r.response?.model) s.model = r.response.model; broadcast(); });
    } else throw httpError(400, 'Unknown action.');
  }


  // Extensions: connectors (MCP servers) and plugins of a session (extensions.mjs).
  const extensions = createExtensions({ sessions, control, claude, addFeed, root: ROOT });

  // The provider runs the agent; the office makes the session, seats it and sends the first prompt.
  // building: the session's building key for the Security room rules (null: not known, the office-wide rules).
  // resume: the session id of a past conversation to continue. fork: the session id of one to copy into a new conversation (#72).
  function openHeadless(provider, { cwd, name, prompt, worktree = null, budget = null, resume = null, fork = null, scheduleId = null, model = null, permissionMode = null, prior = null, building = null, deskRole = null }) {
    provider.check?.({}); // before the session exists: a missing program (claude.exe) leaves no ghost session
    // A Claude Code session opens in default mode while any of its Security cells is Ask, so Claude Code asks and the rules apply.
    const asked = permissionMode;
    if (provider === claude) permissionMode = permissionModeFor(saved.get('security'), building, permissionMode);
    const officeId = 'o' + crypto.randomBytes(4).toString('hex');
    // The last slash-command list came from a Claude Code init, so only a Claude Code session starts with it.
    const known = provider === claude ? saved.get('commands') : null;
    // startDir: the launch folder (the worktree when there is one). Requests are rated against it, never against a later cd.
    // costUnknown: the agent reports no cost (ACP), so every surface shows "unknown", never $0.00.
    // supervision: the label of an ungated agent (ADR 0001), for every surface that shows the session.
    const costUnknown = traitsOf(provider).cost === 'unknown', supervision = traitsOf(provider).supervision;
    const s = newSession({ uid: officeId, officeId, provider: provider.kind, name, cwd, startDir: cwd, launched: true, headless: true, status: 'starting', worktree, budget, scheduleId, model,
      commands: known?.commands || [], skills: known?.skills || [], costUnknown, supervision, deskRole });
    placeSession(s, true);
    if (prior) { s.replies = prior.replies || []; s.replySeq = s.replies.reduce((n, r) => Math.max(n, r.id || 0), 0); s.costBase = prior.cost || 0; s.cost = prior.cost || null; s.turns = prior.turns || 0; s.prompt = prior.prompt || ''; }
    // The persona's style is the tone of the system prompt only (#150). The Security room never reads it.
    provider.open(s, { model, permissionMode, budget, resume, fork, tone: personaPrompt(personaOf(saved.get('personas'), name)) });
    if (!worktree) rememberDir(cwd); // a worktree folder is an implementation detail, not a place to start from
    addFeed(s, 'start', fork ? `forked from ${prior?.name || 'a past session'}, in a new worktree on branch ${worktree?.branch}` : resume ? 'reopened in the office' : worktree ? `started in the office on branch ${worktree.branch}` : 'started in the office');
    if (asked && permissionMode !== asked) addFeed(s, 'start', `opened in ${permissionMode} permission mode, not ${asked}: the Security room has Ask rules`);
    if (costUnknown) addFeed(s, 'start', `${provider.label} does not report cost. The office shows it as unknown, and no spend limit can stop it.`);
    if (supervision) addFeed(s, 'start', `${provider.label}: ${supervision}. The feed says what it ran without asking.`);
    if (prompt) { s.prompt = prompt; s.firstPrompt ||= prompt; writeUser(s, standupLine(s) + prompt); addFeed(s, 'prompt', clip(prompt, 100)); }
    broadcast();
    return s.uid;
  }

  // ---------- open / close ----------
  // opts.provider: the agent kind (default Claude Code). The Open dialog offers every kind (#20); a kind without openWindow
  // opens in the office only.
  async function openSession(opts) {
    // Start from a persona (#152): its name, model and agent kind fill what the caller left out. The role and style are prompt text only.
    if (opts.persona) {
      const p = personaOf(saved.get('personas'), String(opts.persona));
      if (!p) throw httpError(404, 'No such character.');
      opts = { ...opts, name: p.name, model: opts.model || p.model || null, provider: opts.provider || p.kind || undefined };
    }
    if (process.platform !== 'win32') throw httpError(501, 'Opening sessions is only implemented for Windows.');
    const cwd = String(opts.cwd || '').trim();
    let stat;
    try { stat = fs.statSync(cwd); } catch { /* handled below */ }
    if (!stat || !stat.isDirectory()) throw httpError(400, `Folder not found: ${cwd || '(empty)'}`);

    const provider = providers.get(opts.provider);
    // Admission (admission.mjs): every refusal and the cost question come before a worktree or a session. An ungated agent needs a
    // room of its own: in the office, without Use this folder, in a folder that is in git.
    const wantsRoom = opts.where !== 'terminal' && opts.isolation !== 'same';
    let located;
    const locOf = async () => (located ??= { loc: wantsRoom ? await git.locate(cwd) : null });
    const plan = ruled(await admission.admit({ mode: opts.scheduleId ? 'schedule' : 'open', provider, opts, requested: opts.maxBudget, confirmed: opts.confirmCost === true,
      ownRoom: async () => !!(await locOf()).loc, ownRoomText: 'opens only in a room of its own: clear Use this folder, in a folder that is in a git repository.' }));
    const { loc } = await locOf();
    const model = opts.model || null, permissionMode = opts.permissionMode || null;
    const prompt = String(opts.prompt || '').slice(0, 8000);

    const name = String(opts.name || '').trim().slice(0, 40) || basename(cwd) || 'session';
    // role: the function floor of the empty desk the user clicked (#92). It seats the agent there (place.mjs seatOf, step 2),
    // from the session's first snapshot, so its room is never noted on another floor.
    const role = opts.role == null || opts.role === '' ? null : String(opts.role);
    if (role && !functionOf(role)) throw httpError(400, 'No such floor.');
    if (opts.where !== 'terminal') {
      // Each agent gets its own room: a new worktree, unless the caller says isolation: 'same' ("Use this folder").
      // A folder outside git cannot get one; that session works in the folder, and its feed says so.
      let workdir = cwd, worktree = null, noRoom = false;
      if (wantsRoom) {
        if (loc) {
          const wt = await git.createWorktree(cwd, name);
          workdir = wt.path; worktree = { root: wt.root, branch: wt.branch, repo: wt.repo, base: wt.base || null };
          // The building knows the new room before the bot sits in it (the room board reads its files at once).
          addRepo(wt.repo); await refreshRepo(repoKey(wt.repo));
        } else noRoom = true;
      }
      if (worktree) rememberDir(cwd);
      // A paid provider gets the default spend limit unless the caller sets one (0 clears it). A local provider has none (#33),
      // and neither has one whose cost is unknown: nothing could stop it at a limit.
      const budget = plan.budget;
      const building = await buildingOfFolder(workdir, worktree);
      const uid = openHeadless(provider, { cwd: workdir, name, prompt, worktree, budget, scheduleId: opts.scheduleId || null, model, permissionMode, building, deskRole: role });
      if (noRoom) { const s = sessions.get(uid); if (s) { addFeed(s, 'start', 'This folder is not in git, so the agent has no room of its own.'); broadcast(); } }
      return uid;
    }
    if (typeof provider.openWindow !== 'function') throw httpError(400, `${provider.label} does not open in a terminal window.`);
    const officeId = 'o' + crypto.randomBytes(4).toString('hex');
    const s = newSession({ uid: officeId, officeId, provider: provider.kind, name, cwd, startDir: cwd, launched: true, status: 'starting', model, deskRole: role });
    placeSession(s, true);
    // The window's Claude Code asks too while a Security cell is Ask; its own dialog answers what the office lets go back.
    const windowMode = provider === claude ? permissionModeFor(saved.get('security'), await buildingOfFolder(cwd, null), permissionMode) : permissionMode;
    provider.openWindow(s, { model, permissionMode: windowMode, prompt });
    rememberDir(cwd);
    addFeed(s, 'start', 'opened a new window');
    broadcast();
    return s.uid;
  }

  // Admission (admission.mjs) is the one ordered check before a session starts: provider check, Security refusal, own room only
  // (ADR 0001), preflight, the cost question (an agent that reports no cost runs only after the user's yes, owner decision Q22;
  // a 200 with confirm: 'cost', not an error), the spend limit. `ruled` turns its answer into the route's error or question.
  const admission = createAdmission({ rules: () => saved.get('security'), defaultSpend: () => defaultSpend() });
  function ruled(v) {
    if (v.kind === 'refusal') throw httpError(v.status, v.text);
    if (v.kind === 'question') throw askFirst(v.ask, v.text);
    return v;
  }

  // A past session opens again with its own provider (providers.reopenPlan). A provider that can resume continues the
  // conversation (Claude Code --resume); another one starts a fresh session in the same folder, and the record stays.
  // The permission mode starts as the default (or what the Security room rules need).
  async function reopenSession(uid, { confirmed = false } = {}) {
    const check = () => {
      const rec = history.find((h) => h.uid === uid);
      if (!rec) throw httpError(404, 'That past session is gone.');
      if (pastInUse().has(uid)) throw httpError(409, 'That session is open again. Close it first, or wait until it has started.');
      // Its room was removed (Remove in Changes): its folder is now the main folder, where it never worked. Reopen would continue
      // it there, on the user's branch, so the office says so and opens nothing. Fork (a new worktree) stays possible.
      if (rec.roomGone) throw httpError(409, `Its room was removed (branch ${rec.roomGone.branch}). Reopen would run it in your main folder, so the office does not reopen it. Open a new session${traitsOf(providers.get(rec.provider)).features.includes('fork') ? ', or fork it into a new worktree' : ''}.`);
      if (!fs.existsSync(rec.cwd)) throw httpError(409, `Its folder is gone: ${rec.cwd}. It may have been a removed worktree.`);
      return rec;
    };
    const first = check();
    const provider = providers.get(first.provider);
    ruled(await admission.admit({ mode: 'reopen', provider, confirmed, ownRoom: !!first.worktree, ownRoomText: 'reopens only in its own worktree. This past session ran in your folder: open a new session instead.' }));
    // The building for the rules, and what a provider learns at a handshake (an ACP agent: whether it can resume), are looked
    // up before the last check: from that check to reopening.set nothing waits, so a second reopen that comes meanwhile is
    // refused (#54).
    const building = await buildingOfFolder(first.cwd, first.worktree);
    if (provider.learn) await provider.learn();
    const plan = providers.reopenPlan(check());
    const id = openHeadless(plan.provider, { ...plan.opts, building });
    if (plan.note) { const s = sessions.get(id); if (s) { addFeed(s, 'start', plan.note); broadcast(); } }
    if (!plan.fresh) reopening.set(id, uid); // the past record leaves history when the new session has started (recordHistory)
    return id;
  }

  // Fork (#72): a copy of a past session in a new worktree, for an agent kind that declares 'fork'. It writes (a worktree and a session),
  // so the office holds it until the user says yes: the first call is 409 with confirm: 'fork' and the question, and the page sends the
  // same call again with confirmed: true. That yes also covers the cost question of an agent that reports no cost (confirmCost). The
  // past record stays. The worktree branches from the repository the session was made in (its main folder), not from the old worktree.
  async function forkSession(uid, { confirmed = false } = {}) {
    const rec = history.find((h) => h.uid === uid);
    if (!rec) throw httpError(404, 'That past session is gone.');
    const provider = providers.get(rec.provider);
    const from = rec.worktree?.repo && fs.existsSync(rec.worktree.repo) ? rec.worktree.repo : rec.cwd;
    // The record's own problems come after the refusals and the capability check, before the question (admission.mjs recordProblem).
    const recordProblem = () => !rec.sid ? 'That session never started, so there is nothing to fork.' : (!from || !fs.existsSync(from)) ? `Its folder is gone: ${rec.cwd}.` : null;
    const plan = ruled(await admission.admit({ mode: 'fork', provider, confirmed, recordProblem,
      forkText: `Fork ${rec.name} into a new worktree? The copy gets the conversation so far and its own branch. The files start from the current commit of the main folder, not from the changes of the old session. ${traitsOf(provider).cost === 'unknown' ? `${provider.label} does not report cost, so the office shows it as unknown and no spend limit can stop it.` : ''}`.trim() }));
    const name = `${rec.name} fork`.slice(0, 40);
    // An agent room of its own (#69): on the floor of the branch it was made from, known to the building before the bot sits.
    const wt = await git.createWorktree(from, name);
    rememberDir(from);
    const budget = plan.budget;
    const worktree = { root: wt.root, branch: wt.branch, repo: wt.repo, base: wt.base || null };
    try {
      addRepo(wt.repo); await refreshRepo(repoKey(wt.repo));
      const building = await buildingOfFolder(wt.path, worktree);
      const uid = openHeadless(provider, { cwd: wt.path, name, prompt: '', worktree, budget, fork: rec.sid, prior: rec, model: rec.model || null, building });
      forkTrees.set(uid, wt);
      return uid;
    } catch (e) {
      await git.discardNew(wt).catch(() => {}); // no session opened: the worktree this call made would be left over
      throw e;
    }
  }

  function closeSession(uid) {
    const s = sessions.get(uid);
    if (!s) throw httpError(404, 'No such session.');
    if (s.status === 'ended') { sessions.delete(uid); reopening.delete(uid); broadcast(); return; }
    reopening.delete(uid); // the user closed it: that is not a failed reopen, and the past record stays
    return providerOf(s).close(s).then(() => {
      endSession(s, 'closed from the office');
      broadcast();
    });
  }

  // ---------- HTTP hook probe ----------
  // Runs one tiny Haiku session with the HTTP hook settings and checks the events arrived over HTTP.
  async function probeHttp() {
    const need = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
    probeSeen = new Set();
    const run = await new Promise((resolve) => {
      claude.cli(['--settings', HOOKS_HTTP_FILE, '--model', 'haiku', '--permission-mode', 'default', '-p', 'Run the bash command: echo http-probe-ok  Then say done.'],
        { cwd: ROOT, env: { ...process.env, OFFICE_ID: 'probe' }, timeout: 120000, windowsHide: true },
        (err, out) => resolve({ err: err && err.message, out: String(out || '').slice(0, 200) }));
    });
    const seen = [...probeSeen];
    probeSeen = null;
    for (const [uid, s] of sessions) if (s.officeId === 'probe') sessions.delete(uid);
    const missing = need.filter((e) => !seen.includes(e));
    const ok = !run.err && !missing.length;
    saved.set('httpHooks', { ok, version: CLAUDE_VERSION, at: new Date().toISOString(), seen, missing });
    savePersisted();
    if (!ok) hooksMode = 'command';
    else if (process.env.OFFICE_HOOKS !== 'command') hooksMode = 'http';
    broadcast();
    return { ok, mode: hooksMode, version: CLAUDE_VERSION, seen, missing, error: run.err || null };
  }

  // ---------- Manager goals: the office plan source (#156, spec #130) ----------
  // manager.mjs holds the rules; this is the wiring. A goal is split into steps (one per line of the goal: the planner is injected, and the
  // model ladder of #74 replaces it later), approved first, and each step goes to an idle agent that sits in the same building. The spend limit is
  // checked by the Manager before each dispatch. Goals are saved in the state file. While a Paperclip company is connected the office is not the
  // planner (one planner per building): a goal is refused (409, confirm: 'goal') until the same call comes with confirmed: true.
  const planLines = async (goal) => String(goal).split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean).map((text) => ({ text }));
  const goalAgents = (building) => [...sessions.values()].filter((s) => s.status !== 'ended' && buildingOfSession(s) === building).map((s) => {
    let paid = true; try { paid = traitsOf(providers.of(s)).paid; } catch { /* a kind that left: count it as paid */ }
    return { id: s.uid, name: s.name, role: s.deskRole || '', room: '', free: s.status === 'idle' && !s.error, paid, tiers: tiersOf(s, paid) };
  });
  // The model ladder (#74, manager.mjs): a free agent is the local tier, a Claude Code agent takes the three Claude tiers. Another paid kind
  // (an ACP agent) picks its own model, so it has no ladder tier and takes no ladder step.
  function tiersOf(s, paid) {
    if (!paid) return ['local'];
    return s.provider === 'claude-code' || !s.provider ? ['haiku', 'sonnet', 'opus'] : [];
  }
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const stepSeen = new Set(); // agents that began the turn of their step (a terminal session starts it with its next hook)
  const manager = createManager({
    planner: planLines,
    agents: goalAgents,
    // A Claude Code agent is set to the tier's model before the step starts (control set_model, the dock's model switch); a free agent keeps its model.
    dispatch: (agent, task, ctx) => {
      const s = sessions.get(agent.id);
      if (ctx?.tier && ctx.tier !== 'local' && s?.headless && s.status !== 'ended' && s.model !== ctx.tier) {
        try { doControl(agent.id, 'model', ctx.tier); } catch (e) { console.warn(`Manager: could not set the model: ${e.message}`); }
      }
      sendMessage(agent.id, task, [], { answers: false }); stepSeen.delete(agent.id);
    },
    ready: (building) => [...new Set(goalAgents(building).flatMap((a) => a.tiers))],
    callsOf: (id, since) => (sessions.get(id)?.calls || []).filter((c) => c.t >= since && !c.agent).map((c) => ({ key: `${c.name}:${c.detail}`, ok: c.ok, changed: c.ok === true && EDIT_TOOLS.has(c.name) })),
    deliver: (to, from, text) => deliverMail(to, from, text), // false: not delivered, so the mail is refused and not counted
    paperclip: () => !!(saved.get('paperclip')?.company || hq.view()?.company),
    interrupt: (id) => { const s = sessions.get(id); if (s && s.status === 'working') tracker.interrupt(s); },
    spendOf: (id) => Number(sessions.get(id)?.cost) || 0,
    onChange: () => { saved.set('goals', manager.export()); savePersisted(); broadcast(); },
  });
  manager.restore(saved.get('goals'));
  const planBoard = createPlanBoard({ sources: [officeSource(manager), hq.planSource] });
  // Called after every state change: a step ends with the turn of its agent, and a freed agent may take a waiting step.
  let goalTickQueued = false, freeSig = '';
  function goalTick() {
    if (goalTickQueued) return;
    goalTickQueued = true;
    setImmediate(async () => {
      goalTickQueued = false;
      try {
        for (const id of manager.workingAgents()) {
          await manager.check(id); // the model ladder: a stage signal takes the step one tier up
          const s = sessions.get(id);
          if (!s || s.status === 'ended') { stepSeen.delete(id); await manager.finish(id, { ok: false, text: 'The agent left the office.' }); }
          else if (s.status !== 'idle') stepSeen.add(id);
          else if (stepSeen.has(id)) { stepSeen.delete(id); await manager.finish(id, { ok: !s.error, text: s.error ? s.error.text : '' }); }
        }
        const sig = [...sessions.values()].filter((s) => s.status === 'idle').map((s) => s.uid + '@' + buildingOfSession(s)).sort().join();
        if (sig !== freeSig) { freeSig = sig; await manager.agentFreed(); }
      } catch (e) { console.warn(`Manager: ${e.message}`); }
    });
  }
  function startGoal(body) {
    const building = String(body.building || '');
    const company = saved.get('paperclip')?.company || hq.view()?.company;
    if (company && body.confirmed !== true) throw askFirst('goal', 'A Paperclip company is connected, so Paperclip plans the work. Start an office goal anyway? Two planners then assign work at once.');
    const limit = body.spendLimit == null ? defaultSpend() : Number(body.spendLimit);
    if (!Number.isFinite(limit) || limit < 0) throw httpError(400, 'The spend limit must be a number of dollars, 0 or more.');
    return manager.submit(building, body.goal, { approveFirst: body.approveFirst !== false, spendLimit: limit })
      .then((id) => ({ ok: true, id, plans: planBoard.snapshot().plans.filter((p) => p.id === id) }))
      .catch((e) => { throw e.status ? e : httpError(400, e.message); });
  }

  // The spend default, templates and schedules (schedules.mjs).
  const schedules = createSchedules({ saved, save: savePersisted, providers, claude, kinds: KINDS, sessions, openSession, addFeed, broadcast });
  const { defaultSpend, saveSpendLimit, saveTemplate, saveSchedule, runSchedule } = schedules;
  setInterval(() => { void schedules.runDue(Date.now()); }, 30000).unref();

  // ---------- past sessions: list and search ----------
  function pastSummary(h) {
    const last = h.replies?.length ? h.replies[h.replies.length - 1].text : '';
    // provider: the agent kind. A record from before providers has none: it is Claude Code's (as in providers.reopenPlan).
    // agent and features (#72): its kind's label (for Export) and what it has beyond the seam (the Fork button).
    return { uid: h.uid, name: h.name, ...kindInfo(h), provider: h.provider || DEFAULT_PROVIDER, cwd: h.cwd, model: h.model, cost: h.cost, costUnknown: h.costUnknown === true, turns: h.turns, startedAt: h.startedAt, endedAt: h.endedAt,
      branch: h.worktree?.branch || null, worktreeRoot: h.worktree?.root || null, last: clip(String(last).replace(/\s+/g, ' '), 140), firstAsk: clip(h.prompt || '', 140) };
  }
  // Export (#72): a session, live or past, as Markdown with its call timeline. Every agent kind has it (Q29): the office wrote the record.
  function exportSession(uid) {
    const live = sessions.get(uid);
    const src = live ? fullSession(live) : history.find((h) => h.uid === uid);
    if (!src) throw httpError(404, 'No such session.');
    const full = live ? src : { ...src, ...kindInfo(src) };
    const F = globalThis.OfficeFormat;
    return { filename: F.exportFileName(full), text: F.exportText(full) };
  }

  // Skills an agent kind writes (#72), for the kinds that declare 'skills'. list and read answer at once; save and delete write
  // outside the worktree, so they are held until the user says yes (409 with confirm: 'skill', then the same call with confirmed: true).
  function skillsOf(kind) {
    const provider = providers.get(kind ? String(kind) : undefined);
    const dir = traitsOf(provider).features.includes('skills') && typeof provider.skillsDir === 'function' ? provider.skillsDir() : null;
    if (!dir) throw httpError(404, `${provider.label} has no skills the office can show.`);
    return { provider, skills: createSkills({ dir }) };
  }
  function skillAction(action, body) {
    const { provider, skills } = skillsOf(body.provider);
    if (action === 'list') return { agent: provider.label, dir: skills.dir, skills: skills.list() };
    const name = String(body.name ?? '');
    if (action === 'read') return skills.read(name);
    skills.read(name); // 400 or 404 before the question
    if (body.confirmed !== true) {
      throw askFirst('skill', action === 'delete'
        ? `Delete the skill ${name}? ${provider.label} loses it for good. Its folder is removed.`
        : `Save your changes to the skill ${name}? ${provider.label} follows this skill in later sessions.`);
    }
    return action === 'delete' ? skills.remove(name) : skills.save(name, String(body.text ?? ''));
  }

  function search(q) {
    const needle = String(q || '').trim().toLowerCase();
    if (needle.length < 2) return [];
    const out = [];
    const scan = (rec, where) => {
      const hay = [[rec.name, 'name'], [rec.cwd, 'folder'], [rec.prompt, 'ask'], ...(rec.replies || []).map((r) => [r.text, 'reply'])];
      for (const [text, kind] of hay) {
        const t = String(text || ''), i = t.toLowerCase().indexOf(needle);
        if (i < 0) continue;
        out.push({ uid: rec.uid, name: rec.name, where, kind, snippet: clip(t.slice(Math.max(0, i - 50), i + 110).replace(/\s+/g, ' '), 160), t: rec.endedAt || rec.startedAt });
        return;
      }
    };
    const shown = pastShown(), asPast = new Set(shown.map((h) => h.uid));
    for (const h of shown) scan(h, 'past');
    for (const s of sessions.values()) if (s.headless && !asPast.has(s.uid)) scan(s, 'live'); // a session shows once: past when it has ended, live while it is open
    return out.slice(0, 30);
  }
  // A session's folder, whether it is running or in the past list.
  const folderOf = (uid) => { const s = sessions.get(uid) || history.find((h) => h.uid === uid); if (!s) throw httpError(404, 'No such session.'); return s; };

  // ---------- housekeeping ----------
  setInterval(() => {
    let changed = false;
    for (const [uid, s] of sessions) {
      if (s.status === 'ended') {
        if (Date.now() - s.endedAt > 120_000) { sessions.delete(uid); reopening.delete(uid); changed = true; }
        continue;
      }
      if (s.pid) {
        try { process.kill(s.pid, 0); } catch (e) {
          if (e.code !== 'EPERM') { endSession(s, 'terminal went away'); changed = true; }
        }
      }
    }
    if (changed) broadcast();
  }, 5000).unref();

  const STARTUP_DIR = startup.startupDir(process.env.APPDATA); // Windows sign-in entry; see startup.mjs

  // ---------- plan usage ----------
  // Hooks do not report plan usage, but Claude Code gives it to the status line command
  // (rate_limits: five_hour and seven_day, each used_percentage and resets_at). A status line
  // script can save that JSON to a file; the office only reads it. Set OFFICE_RATE_FILE to
  // point somewhere else. No file, or a window that has already reset, means no meter.
  const RATE_FILE = process.env.OFFICE_RATE_FILE || path.join(os.homedir(), '.claude', 'rate_limits_state.json');
  let plan = null;
  function readWindow(w, now) {
    const pct = Number(w?.used_percentage), at = Number(w?.resets_at) * 1000;
    return Number.isFinite(pct) && Number.isFinite(at) && at > now ? { percent: Math.max(0, Math.min(100, pct)), resetsAt: at } : null;
  }
  function readPlan() {
    let next = null;
    try {
      const j = JSON.parse(fs.readFileSync(RATE_FILE, 'utf8'));
      const now = Date.now();
      const week = readWindow(j.rate_limits?.seven_day, now), fiveHour = readWindow(j.rate_limits?.five_hour, now);
      if (week || fiveHour) next = { week, fiveHour, capturedAt: Number(j.captured_at) * 1000 || null };
    } catch { /* no file: no meter */ }
    if (JSON.stringify(next) !== JSON.stringify(plan)) { plan = next; broadcast(); }
  }
  setInterval(readPlan, 15000).unref();

  // One session with all its data and its place: GET /api/session (full data on request; the snapshot is lean).
  // agent and features: the agent kind's name and what it has beyond the seam (#72), read now because an ACP agent says some of it at its
  // handshake. The page shows a feature only when the kind declares it (vocab.js featuresOf).
  const kindInfo = (s) => { try { const p = providers.of(s); return { agent: p.label, features: traitsOf(p).features }; } catch { return { agent: '', features: [] }; } };
  // hq: a Paperclip run's label (its agent, role, company, task and budget, #76), while the office watches that company.
  const fullSession = (s) => ({ ...s, ...kindInfo(s), persona: personaOf(saved.get('personas'), s.name), place: s.placed ? roomPlace(s) : null, seat: seatOfSession(s), hq: s.paperclip ? hq.labelOf(s.paperclip) : null });
  const CATALOG = catalogView();
  // What /events sends: only what the page reads, with caps per session (public/wire.js lean).
  const snapshot = () => (W.lean({
    sessions: [...sessions.values()].map(fullSession),
    plan,
    figures: allFigures(),    // noteKey -> room figures (sessions, working, waiting, toolCalls, tokens, cost, priced, unknown, todosDone, todosTotal, lastEvent)
    notes: saved.get('notes'),   // noteKey -> { text, at, v, by? }: each room's notes board (v: version counter; a cleared board stays with text '' and at 0; by: the agent session that last wrote it)
    screens: saved.get('screens'),   // room key -> the blackboard view the user chose (personas.mjs setScreen); a room with none shows Overview
    pins: saved.get('pins'),     // noteKey -> { text, by, at }: a short message an agent pinned on the room's blackboard
    repos: campus.reposView(),
    // The Security room (#70): the rules (office-wide and per building), why a cell is not enforced for an agent kind
    // (security.mjs enforcement), and the Spend screen (the default spend limit, cost per agent kind this month).
    security: { rules: saved.get('security'), enforce: ENFORCE, trust: trustView(), spend: { limit: defaultSpend(), ...costThisMonth(saved.get('costs'), Date.now()) } },
    kinds: KINDS,             // the agent kinds: the label of each session's kind, and the Open dialog's options before readiness comes
    plans: planBoard.snapshot(), // Manager board (#154, #156): every plan of every source, with its source word and the steps' state words
    hq: hq.view(),            // Paperclip HQ (#76): null until connected; company, budget, agents (role, task, supervision, run), routines
    // Function floors (#92): each building's floors (archetypes.mjs layoutView), each room's floors and name, and the catalog
    layouts: layoutsView(), rooms: roomsView(), catalog: CATALOG,
    changes: changesView(),   // paper flow (#93): building key -> { ok, at, error, mergedToday, prs, ready } from gh
    rituals: { focus: saved.get('focus'), merges: saved.get('merges').slice(0, 20) }, // Focus mode and the recent merges (the merged moment, #151)
  }));
  // A page gets the whole snapshot when it connects, then one patch per broadcast with only what changed (wire.js).
  // State changes within BROADCAST_MS go out as one patch, so a burst of hooks sends at most 10 messages a second.
  const BROADCAST_MS = 100;
  const wire = W.sender();
  let pending = null;
  readPlan();
  function broadcast() {
    goalTick();    // a step ends with its agent's turn (#156)
    noteRooms();   // every state change: a room gets its floor and its name even while no page is connected (#92)
    if (!pending) pending = setTimeout(flush, BROADCAST_MS);
  }
  function flush() {
    clearTimeout(pending); pending = null;
    if (!clients.size) { wire.reset(); return; }   // no page has the base: the next one connects to a new one
    const p = wire.next(snapshot());
    if (!p) return;
    const data = `data: ${JSON.stringify(p)}\n\n`;
    for (const write of clients) write(data);
  }
  // A page connects: the others get what changed until now, so all pages share one base, and the new one gets it whole.
  function connectPage(write) {
    if (clients.size) flush(); else { wire.reset(); wire.next(snapshot()); }
    write(`data: ${JSON.stringify(wire.full())}\n\n`);
    clients.add(write);
  }
  setInterval(() => { for (const write of clients) write(': ping\n\n'); }, 20000).unref();

  // ---------- routes: the table of the office core (office-core.mjs) ----------
  // Method, path, route group (auth.mjs: public, launch, agent, page) and handler, once each. The HTTP server gates a request by its
  // group (core.groupOf), parses the body and calls core.handle; a test calls core.handle itself. A handler gives a value (sent as
  // JSON) or reply(...); it throws httpError(...) or askFirst(...).
  const R = (method, p, group, run) => ({ method, path: p, group, run });
  const routes = [
    ...staticRoutes(ROOT),
    R('POST', '/remote/signin', 'launch', ({ remote }) => {
      // Remote sign-in: the gate saw a valid Access login, so the page gets its cookie with no launch code. The cookie ends
      // with the Access token. A feed line and a log line say who signed in.
      if (!remote) throw httpError(404, 'Not found');
      addFeed({ uid: 'remote', name: 'Remote' }, 'start', `signed in from ${remote.email}`);
      console.log(`Remote sign-in: ${remote.email}`);
      broadcast();
      return reply(200, { ok: true }, { headers: { 'set-cookie': auth.remoteCookie(PORT, cfg.remotePageToken, remote.exp, Date.now()) } });
    }),
    // A launch code works once, for 5 minutes. The cookie is HttpOnly, so page scripts never see the token.
    R('POST', '/launch', 'launch', ({ body }) => (launchCodes.take(body.code)
      ? reply(200, { ok: true }, { headers: { 'set-cookie': auth.pageCookie(PORT, PAGE_TOKEN) } })
      : reply(401, { error: auth.LINK_DEAD }))),

    R('GET', '/api/auth', 'page', () => ({ ok: true })), // the page asks: does my cookie work?
    R('GET', '/events', 'page', () => reply(200, '', { stream: (write) => { connectPage(write); return () => clients.delete(write); } })),
    R('GET', '/api/session', 'page', ({ query }) => {
      const s = sessions.get(String(query.get('uid') || ''));
      // feed: what the session did, in short lines (the last 200 of the office keep them; the snapshot does not carry them)
      return s ? { session: fullSession(s), feed: feed.filter((f) => f.uid === s.uid) } : reply(404, { error: 'No such session.' });
    }),
    R('GET', '/api/choices', 'page', ({ query }) => ({ folders: recentChoices(saved.get('recent'), query.get('first') || '') })),
    // Each agent kind with its readiness, what it needs and its models (providers/index.mjs status), for the settings view (#20).
    R('GET', '/api/providers', 'page', async ({ query }) => { const list = await providers.statusCached({ fresh: query.get('fresh') === '1' }); void refreshEnforce(); return { providers: list }; }),
    // Paperclip HQ (#76): what the office reads from it now (tests and scripts; the page gets it in the snapshot).
    R('GET', '/api/paperclip', 'page', () => ({ hq: hq.view() })),
    R('GET', '/api/info', 'page', () => ({
      port: PORT, hooksFile: activeHooksFile(), recent: saved.get('recent'), home: os.homedir(),
      settingsSnippet: JSON.stringify(hooksMode === 'http' ? httpSettings : commandSettings, null, 2),
      agentToken: AGENT_TOKEN, // the Attach sessions dialog hides it until the user clicks Show (#60)
      launchCommand: `claude --settings "${activeHooksFile()}" --mcp-config "${MCP_FILE}"`,
      startup: startup.status(STARTUP_DIR, ROOT, PORT),
      remote: auth.remoteInfo(REMOTE), // off, on with its address, or the setting that is missing (the Attach sessions dialog)
      hooksMode, claudeVersion: CLAUDE_VERSION, templates: saved.get('templates'), schedules: saved.get('schedules'), spendLimit: defaultSpend(),
    })),
    // The weekly recap and the while-you-were-away list (#151): computed from the feed, the merges and the history (rituals.mjs).
    R('GET', '/api/recap', 'page', ({ query }) => {
      const now = Date.now(), since = Number(query.get('since')) || 0;
      const live = [...sessions.values()].filter((s) => s.headless).map((s) => ({ name: s.name, cost: s.cost, startedAt: s.startedAt, endedAt: s.endedAt, worktree: s.worktree }));
      const hist = [...live, ...history.filter((h) => !sessions.has(h.uid))];
      return { ...recapOf({ feed, merges: saved.get('merges'), history: hist, now }), away: awayOf({ feed, since, now }), focus: saved.get('focus') };
    }),
    R('GET', '/api/personas', 'page', () => ({ personas: saved.get('personas'), teams: saved.get('teams'), screens: saved.get('screens') })),
    R('GET', '/api/custom/export', 'page', () => exportCustom(saved.slice('personas', 'teams', 'screens', 'layouts'))),

    R('POST', '/hook', 'agent', async ({ body }) => {
      body.paperclip = cleanPaperclipIds(body.paperclip); // plain ids or nothing (hook.mjs reads them from a Paperclip run's environment)
      const out = onHook(body);
      const pre = preToolGate(body); // a Security room Deny refuses the call before it runs (hook.mjs forwards the answer)
      if (pre) return pre;
      if (body.hook_ppid && !body.office_id) {
        const s = findSession(body);
        if (s && !s.pid) { const pid = await walkToClaude(body.hook_ppid); if (pid) { s.pid = pid; launch.processStart(pid).then((t) => { s.pidStart = t; }); broadcast(); } }
      }
      return out || { ok: true };
    }),
    R('POST', '/hook/http', 'agent', ({ body, headers, signal }) => {
      const p = slimPayload(body, String(headers['x-office-id'] || '').trim() || null);
      if (probeSeen && p.office_id === 'probe') probeSeen.add(p.hook_event_name);
      if (p.hook_event_name === 'PermissionRequest') return onPermission(p, signal);
      const out = onHook(p);
      const pre = preToolGate(p);
      if (pre) return JSON.stringify(pre);
      return out ? JSON.stringify(out) : '';
    }),
    R('POST', '/hook/permission', 'agent', ({ body, signal }) => onPermission(body, signal)),
    R('POST', '/hook/openclaw', 'agent', ({ body, signal }) => onOpenClawCall(body, signal)),
    R('POST', '/mcp/inbox', 'agent', ({ body }) => onMcpInbox(body)),
    R('POST', '/mcp/ask', 'agent', ({ body, signal }) => onMcpAsk(body, signal)),
    R('POST', '/mcp/mail', 'agent', ({ body }) => onMcpMail(body)),
    R('POST', '/mcp/room', 'agent', async ({ body }) => ({ text: describeRoom(await callerRoom(body)) })),
    R('POST', '/mcp/room/update', 'agent', async ({ body }) => ({ text: updateRoom(await callerRoom(body), body) })),

    // Only the office on 4317 in the main folder owns the entry (#108); the others get 403 with the reason.
    R('POST', '/api/startup', 'page', ({ body }) => startup.change(STARTUP_DIR, ROOT, process.execPath, PORT, body.enabled)),
    R('POST', '/api/launch-link', 'page', () => ({ url: auth.launchUrl(PORT, launchCodes.mint()) })), // a second npm start asks for one
    R('POST', '/api/probe-http', 'page', () => probeHttp()),
    R('POST', '/api/persona/save', 'page', ({ body }) => { const p = setPersona(saved.get('personas'), String(body.name || ''), body); savePersisted(); broadcast(); return { ok: true, persona: p }; }),
    R('POST', '/api/persona/starters', 'page', () => { const n = addStarters(saved.get('personas')) + addStarterTeams(saved.get('teams')); if (n) { savePersisted(); broadcast(); } return { ok: true, added: n }; }),
    R('POST', '/api/team/save', 'page', ({ body }) => { const t = setTeam(saved.get('teams'), String(body.name || ''), body); savePersisted(); return { ok: true, team: t }; }),
    R('POST', '/api/team/delete', 'page', ({ body }) => { removeTeam(saved.get('teams'), String(body.name || '')); savePersisted(); return { ok: true }; }),
    // A squad: each member opens as its own agent from its persona, one after the other, each in a room of its own. A member that fails does not stop the rest.
    R('POST', '/api/team/start', 'page', async ({ body }) => {
      const team = teamOf(saved.get('teams'), String(body.team || ''));
      if (!team) throw httpError(404, 'No such team.');
      const started = [];
      for (const member of team.members) {
        try { started.push({ name: member, uid: await openSession({ cwd: body.cwd, persona: member, prompt: body.prompt, isolation: body.isolation, where: 'office', confirmCost: body.confirmCost === true }) }); }
        catch (e) { started.push({ name: member, error: e.message }); }
      }
      return { ok: started.some((m) => m.uid), started };
    }),
    R('POST', '/api/custom/import', 'page', ({ body }) => {
      const c = importCustom(body.data, { cleanLayout: cleanRecord });
      Object.assign(saved.get('personas'), c.personas); Object.assign(saved.get('teams'), c.teams); Object.assign(saved.get('screens'), c.screens); Object.assign(saved.get('layouts'), c.layouts);
      savePersisted(); broadcast();
      return { ok: true, personas: Object.keys(c.personas).length, teams: Object.keys(c.teams).length, screens: Object.keys(c.screens).length, layouts: Object.keys(c.layouts).length };
    }),
    R('POST', '/api/screen/set', 'page', ({ body }) => { setScreen(saved.get('screens'), String(body.key ?? ''), body.view); savePersisted(); broadcast(); return { ok: true }; }),
    R('POST', '/api/persona/delete', 'page', ({ body }) => { removePersona(saved.get('personas'), String(body.name || '')); savePersisted(); broadcast(); return { ok: true }; }),
    R('POST', '/api/notes/save', 'page', ({ body }) => {
      // the notes board of a room: the user's own reminders, kept in state.json
      const key = String(body.key || '');
      if (!key || key.length > 400) throw httpError(400, 'Unknown board.');
      // base: the version the editor started from. When the board moved on, notes.mjs merges three ways and
      // returns the merged text; the editor shows it.
      const r = board.save(key, String(body.text ?? ''), body.base, body.sent === true);
      savePersisted(); broadcast();
      return { ok: true, version: r.version, text: r.text, merged: r.merged };
    }),
    R('POST', '/api/tree', 'page', async ({ body }) => repoTree(String(body.root || ''))),
    R('POST', '/api/branches', 'page', ({ body }) => campus.branches(body.repo)),
    R('POST', '/api/floor/create', 'page', ({ body }) => floorAction('create-floor', body)),
    R('POST', '/api/floor/stale', 'page', ({ body }) => campus.staleFloors(body.repo)),
    R('POST', '/api/floor/cleanup', 'page', ({ body }) => floorAction('cleanup-floors', body)),
    R('POST', '/api/floor/delete', 'page', ({ body }) => floorAction('delete-floor', body)),
    R('POST', '/api/room/create', 'page', ({ body }) => floorAction('create-room', body)),
    R('POST', '/api/room/delete', 'page', ({ body }) => floorAction('remove-room', body)),
    R('POST', '/api/message', 'page', ({ body }) => ({ ok: true, ...sendMessage(String(body.uid), body.text, Array.isArray(body.attachments) ? body.attachments : [], { answers: body.answers !== false }) })),
    R('POST', '/api/answer', 'page', ({ body }) => { answer(String(body.id), body.allow === true, body.always === true); return { ok: true }; }),
    R('POST', '/api/open', 'page', async ({ body }) => ({ uid: await openSession(body) })),
    R('POST', '/api/layout', 'page', ({ body }) => changeLayout(body)),
    R('POST', '/api/reopen', 'page', async ({ body }) => ({ uid: await reopenSession(String(body.uid), { confirmed: body.confirmCost === true }) })),
    R('POST', '/api/dismiss', 'page', ({ body }) => { dismissError(String(body.uid)); return { ok: true }; }),
    R('POST', '/api/interrupt', 'page', ({ body }) => { doControl(String(body.uid), 'interrupt'); return { ok: true }; }),
    R('POST', '/api/ext/list', 'page', ({ body }) => extensions.list(body.uid)),
    R('POST', '/api/ext', 'page', ({ body }) => extensions.action(body)),
    R('POST', '/api/control', 'page', ({ body }) => { doControl(String(body.uid), String(body.action), body.value); return { ok: true }; }),
    R('POST', '/api/history', 'page', () => ({ sessions: pastShown().map(pastSummary) })),
    R('POST', '/api/history/forget', 'page', ({ body }) => { history = history.filter((h) => h.uid !== String(body.uid)); saveHistory(); return { ok: true }; }),
    R('POST', '/api/search', 'page', ({ body }) => ({ results: search(body.q) })),
    R('POST', '/api/fork', 'page', async ({ body }) => ({ uid: await forkSession(String(body.uid), { confirmed: body.confirmed === true }) })),
    R('POST', '/api/export', 'page', ({ body }) => exportSession(String(body.uid))),
    ...['list', 'read', 'save', 'delete'].map((action) => R('POST', `/api/skills/${action}`, 'page', ({ body }) => skillAction(action, body))),
    R('POST', '/api/changes', 'page', async ({ body }) => { const r = folderOf(String(body.uid)); return { ...(await git.changes(r.cwd)), worktree: r.worktree || null, name: r.name }; }),
    R('POST', '/api/worktree/remove', 'page', async ({ body }) => {
      const r = folderOf(String(body.uid));
      if (sessions.get(r.uid) && sessions.get(r.uid).status !== 'ended') throw httpError(409, 'Close the session first.');
      const out = await git.removeWorktree(r.worktree || {}, body.force === true);
      // The past record keeps the main folder as its folder (Fork and Search read it) and says which room is gone, so Reopen
      // refuses: it would run the agent in the user's own folder (reopenSession).
      const h = history.find((x) => x.uid === r.uid); if (h) { const repo = h.worktree?.repo; if (h.worktree) h.roomGone = { branch: h.worktree.branch, root: h.worktree.root }; h.worktree = null; if (repo) h.cwd = repo; saveHistory(); }
      return out;
    }),
    R('POST', '/api/pr', 'page', async ({ body }) => {
      const r = folderOf(String(body.uid));
      if (!r.worktree) throw httpError(409, 'Pull requests need a worktree session, so the changes stay off your main branch.');
      const out = await git.createPr(r.cwd, r.worktree.branch, r.name);
      const bk = buildingOfSession(r); if (bk != null) changesStale(bk);
      return out;
    }),
    R('POST', '/api/merge', 'page', ({ body }) => mergeChange(body)),
    R('POST', '/api/settings/focus', 'page', ({ body }) => { saved.set('focus', body.on === true); savePersisted(); broadcast(); return { focus: saved.get('focus') }; }),
    R('POST', '/api/settings/spend', 'page', ({ body }) => { const r = saveSpendLimit(body); broadcast(); return r; }),
    // One Security room rule from the wall: { scope: 'office' | 'building', building, row, col, value, confirmed } (security.mjs setRule).
    R('POST', '/api/security/set', 'page', ({ body }) => saveRule(body)),
    // Earned trust (#153): apply (needs confirmed: true), withdraw or dismiss a proposal. Never automatic.
    R('POST', '/api/trust/apply', 'page', ({ body }) => applyProposal(body)),
    R('POST', '/api/trust/withdraw', 'page', ({ body }) => withdrawGrant(body)),
    R('POST', '/api/trust/dismiss', 'page', ({ body }) => dismissProposal(body)),
    // Paperclip HQ (#76): { url, company? } (127.0.0.1 only: 400 for any other address, before any request), and
    // Supervise in office { agent, confirmed: true } (409 without the Confirm), the one write to Paperclip.
    R('POST', '/api/paperclip/connect', 'page', ({ body }) => connectHq(body)),
    R('POST', '/api/paperclip/disconnect', 'page', () => disconnectHq()),
    R('POST', '/api/paperclip/supervise', 'page', ({ body }) => superviseHq(body)),
    // Manager goals (#156): start { building, goal, approveFirst?, spendLimit?, confirmed? }, approve, cancel and retry { id, step }.
    R('POST', '/api/goal/start', 'page', ({ body }) => startGoal(body)),
    R('POST', '/api/goal/approve', 'page', async ({ body }) => { if (!await manager.approve(String(body.id))) throw httpError(409, 'That goal does not wait for approval.'); return { ok: true }; }),
    R('POST', '/api/goal/handoff', 'page', ({ body }) => handoffGoalHq(body)),
    R('POST', '/api/goal/cancel', 'page', ({ body }) => { if (!manager.cancel(String(body.id))) throw httpError(409, 'That goal is done or stopped.'); return { ok: true }; }),
    R('POST', '/api/goal/retry', 'page', async ({ body }) => { const r = await manager.retry(String(body.id), String(body.step)); if (!r.ok) throw httpError(409, r.reason); return { ok: true }; }),
    R('POST', '/api/template/save', 'page', ({ body }) => saveTemplate(body)),
    R('POST', '/api/template/delete', 'page', ({ body }) => { saved.set('templates', saved.get('templates').filter((t) => t.id !== String(body.id))); savePersisted(); return { ok: true }; }),
    R('POST', '/api/schedule/save', 'page', ({ body }) => saveSchedule(body)),
    R('POST', '/api/schedule/delete', 'page', ({ body }) => { saved.set('schedules', saved.get('schedules').filter((t) => t.id !== String(body.id))); savePersisted(); return { ok: true }; }),
    R('POST', '/api/schedule/run', 'page', async ({ body }) => { const sch = saved.get('schedules').find((t) => t.id === String(body.id)); if (!sch) throw httpError(404, 'No such schedule.'); return { uid: await runSchedule(sch) }; }),
    R('POST', '/api/close', 'page', async ({ body }) => { await closeSession(String(body.uid)); return { ok: true }; }),
  ];
  const core = createCore({ routes });

  // What the adapter calls at start-up, in this order, after it listens: own() (the saved state and the past sessions may write
  // from now on), then its own writes of the token and settings files, then claim() (both state files, whole and owner-only),
  // then resume() (the sign-in entry, what an ungated agent's config carries, the Paperclip connection made before).
  return {
    core, subscribe: (write) => { connectPage(write); return () => clients.delete(write); },
    settings: { commandSettings, httpSettings, mcpConfig },
    own() { ownPort = true; },
    claim() { saved.claim(); writeSecret(HISTORY_FILE, JSON.stringify(history)); },
    resume() {
      // An entry that starts the office at sign-in and still names the old root server.mjs now names src/server.mjs (only the owner office may).
      if (startup.migrate(STARTUP_DIR, ROOT, process.execPath, PORT)) console.log('The Start with Windows entry now points at src/server.mjs.');
      // What an ungated agent's own config carries, for the Security room wall (read-only; nothing is read while it is off).
      void refreshEnforce();
      // Paperclip HQ (#76): the connection the user made before, again (a Paperclip that is not up yet is tried again later).
      if (saved.get('paperclip') && saved.get('paperclip').url) hq.connect({ url: saved.get('paperclip').url, company: saved.get('paperclip').company || null, keep: true }).catch((e) => console.warn(`Paperclip: ${e.message}`));
    },
    hooks: { mode: () => hooksMode, file: activeHooksFile, version: CLAUDE_VERSION },
    /** Ends what the office started that would hold a process open (the process helper). */
    stop() { if (walker) { walker.kill(); walker = null; } },
  };
}
