// Manager: the rules that turn one goal into steps handed to agents. A pure core, like tracker.mjs: everything outside
// the rules is injected, so importing this module starts nothing and a test needs no server, model or timer.
//
//   createManager({ planner, agents, dispatch, interrupt?, deliver?, spendOf?, board?, defaultSpendLimit?, clock?, makeId?, onChange?, managerName?, limits? })
//
//   planner(goal, agents)        -> Promise<[{ text, role?, room?, bot? }]>   any provider can plan (a local model, a paid one, a fake)
//   agents(building)             -> [{ id, name, role, room, free, paid? }]    who could take a step right now. paid is false for a local model.
//   dispatch(agent, task, ctx)   -> void | Promise                            start the step on that agent; ctx = { goalId, stepId }
//   interrupt(agentId)           -> void                                       optional: stop a step on cancel
//   deliver(to, from, text, hops)-> void                                       optional: put an allowed mail into the receiver's inbox
//   spendOf(agentId)             -> number                                     optional: dollars the agent has spent so far
//   board(report)                -> void                                       optional: the user's view. Called with { goalId, building, goal, status, text, todos } after
//                                                                              every change, only when the status, the to-dos or the text changed. Not wired to the server yet.
//                                                                              Owner decision (e1, default): when it is wired, `text` goes to its own section of the room
//                                                                              board, never over the user's notes. The report has no room or notes key yet; the wiring adds it.
//   defaultSpendLimit            number                                        optional: dollars for a goal that asks for none of its own (default 2; 0 = none)
//
// A goal that can reach a paid agent gets the default spend limit (providers/index.mjs spendLimitFor) unless submit() says otherwise: a
// number is that limit, 0 is no limit. A goal that only local agents can take has none, because they cost $0.
// Steps run one after the other. A spend limit is checked before every dispatch, never after. Agent mail has two caps:
// a hop cap (a reply chain is cut) and a message cap per goal. snapshot() and events() let the server show the same
// plan again on every scene mount (the design system does not restore a plan itself).
//
// Plan source contract (#154, spec #130). The board, the page and the snapshot read plans only through createPlanBoard, never from a
// planner. A plan source is one object:
//
//   { kind, list(building?), subscribe?(fn) }
//   kind                  'office' | 'paperclip'   who plans: the word is OfficeVocab.plan.sourceWord(kind)
//   list(building?)       -> [{ id, building, goal, status?, reason?, frozen?, steps: [{ id, title, state, owner?, cost?, ...extra }] }]
//                            state is pending, working, finished or error (OfficeVocab.plan.stepWord); owner is the agent's name; cost is dollars or null.
//                            A source may add per step: raw (its own state name), model, budget { spent, limit }, uid (the agent's desk), skipped and skippedWhy (a run that skipped
//                            the office). frozen: the plan is the last one read and the source is not connected (status 'not-connected'); the board never shows it as current.
//                            list may throw when the plan cannot be read: the board then names the source as unreadable (never a stale plan).
//   subscribe(fn)         -> unsubscribe()          optional: fn() is called after every change of the plan
//
// The office Manager below is one implementation (officeSource(manager)). Another source (Paperclip) needs no change here.
// createPlanBoard({ sources, onChange }).snapshot() -> { plans: [... + source, sourceWord, steps with word], unreadable: [{ source, word }] }.
// The model ladder is not part of this contract (#74).
import crypto from 'node:crypto';
import { DEFAULT_SPEND_LIMIT, spendLimitFor } from './providers/index.mjs';
import { NOTES_MAX } from './notes.mjs';
import './public/vocab.js';

export const DEFAULT_LIMITS = { maxSteps: 12, maxHops: 4, maxMessages: 30, maxAttempts: 3, boardMax: NOTES_MAX - 100 }; // boardMax: the board text must fit a notes board
const STATUS_TO_DS = { pending: 'resting', working: 'working', finished: 'finished', error: 'error' };
const MARK = { pending: '[ ]', working: '[~]', finished: '[x]', error: '[!]' };
const WORD = { planning: 'Planning', 'awaiting-approval': 'Waiting for your approval', running: 'Running', finished: 'Done', blocked: 'Blocked', stopped: 'Stopped', failed: 'Failed', cancelled: 'Cancelled' };
const GOAL_MAX = 2000; // a longer goal is refused (never planned from a cut text); the board shows 300
const BOARD_GOAL = 300, BOARD_STEP = 240, BOARD_OWNER = 40; // 12 steps of 240 and a goal of 300 leave room for status, reason and spend
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function createManager(deps = {}) {
  if (typeof deps.planner !== 'function') throw new Error('createManager needs a planner');
  if (typeof deps.agents !== 'function') throw new Error('createManager needs agents()');
  if (typeof deps.dispatch !== 'function') throw new Error('createManager needs dispatch()');
  const now = deps.clock || Date.now;
  const makeId = deps.makeId || (() => crypto.randomBytes(4).toString('hex'));
  const onChange = deps.onChange || (() => {});
  const spendOf = deps.spendOf || (() => 0);
  const defaultSpend = deps.defaultSpendLimit ?? DEFAULT_SPEND_LIMIT;
  const limits = { ...DEFAULT_LIMITS, ...(deps.limits || {}) };
  const managerName = deps.managerName || ((b) => 'Manager');
  const goals = new Map();
  const listeners = new Set();
  const reserved = new Set(); // agents given a step here, whether or not the server shows them busy yet

  /** The plan as a to-do list (TodoWrite shape, read by OfficeVocab.todoStatus): the step that works is in_progress, a failed step is error (not a TodoWrite status; the vocab shows it as error). */
  const todosOf = (g) => g.steps.map((s) => ({ content: s.text, activeForm: s.owner ? `${s.owner}: ${s.text}` : s.text, status: s.status === 'finished' ? 'completed' : s.status === 'working' ? 'in_progress' : s.status === 'error' ? 'error' : 'pending' }));

  /** The board text: goal and status first, one line per step, then what the user must know (reason, waiting, spend). The plural of steps follows format.js `plural`. */
  function boardText(g) {
    const done = g.steps.filter((s) => s.status === 'finished').length;
    const head = [`Goal: ${clip(g.goal, BOARD_GOAL)}`, `${WORD[g.status] || g.status}${g.steps.length ? `. ${done} of ${g.steps.length} ${g.steps.length === 1 ? 'step' : 'steps'} done.` : '.'}`];
    const tail = [];
    if (g.reason) tail.push(clip(g.reason, BOARD_STEP));
    if (g.waitingFor) tail.push('The next step waits for a free agent.');
    if (g.spendLimit > 0) tail.push(`Spent $${spent(g).toFixed(2)} of $${g.spendLimit.toFixed(2)}.`);
    // The status, the wait and the spend lines are what the user must see, so they are never clipped (the goal line is cut at 300, the reason at
    // 240, an owner name at 40). The step lines shrink together (240, 180, 120, ... characters of text) until everything fits; every line keeps its mark.
    const build = (n) => head.concat(g.steps.map((s) => {
      let line = `${MARK[s.status] || '[ ]'} ${clip(s.text, n)}`;
      if (s.owner) line += ` (${clip(s.owner, BOARD_OWNER)})`;
      if (s.status === 'error' && s.result) line += `: ${clip(s.result, n)}`;
      return line;
    }), tail).join('\n');
    let text = build(BOARD_STEP);
    for (let n = BOARD_STEP - 60; text.length > limits.boardMax && n >= 20; n -= 60) text = build(n);
    return text.length > limits.boardMax ? clip(text, limits.boardMax) : text; // only with a goal of 300 and 12 steps that no shrinking saves: not reachable with the caps above
  }

  /** Keep the board current: every change reports once, a repeat of the same text reports nothing. The text always carries the status word and the mark of
   *  every step (boardText never clips the status word or a mark), so a change of status or of one to-do is always a change of text. A bad board never stops a goal. */
  function report(g) {
    if (typeof deps.board !== 'function') return;
    const text = boardText(g), todos = todosOf(g);
    if (text === g.lastBoard) return;
    g.lastBoard = text;
    try { deps.board({ goalId: g.id, building: g.building, goal: g.goal, status: g.status, text, todos }); } catch { /* the board is a view only */ }
  }

  const touch = (g) => { g.updatedAt = now(); report(g); onChange(g.id); for (const fn of [...listeners]) { try { fn(g.id); } catch { /* a listener never stops a goal */ } } };
  const spent = (g) => {
    let total = 0;
    for (const [id, base] of g.baseline) total += Math.max(0, (Number(spendOf(id)) || 0) - base);
    return total;
  };

  /** The best free agent for a step: its named bot first, then role and room. null when nobody is free. */
  function pick(g, step) {
    const free = deps.agents(g.building).filter((a) => a.free && !reserved.has(a.id));
    let best = null, bestScore = -1;
    for (const a of free) {
      let score = 0;
      if (step.bot && a.name === step.bot) score += 4;
      if (step.role && a.role === step.role) score += 2;
      if (step.room && a.room === step.room) score += 1;
      if (score > bestScore) { best = a; bestScore = score; }
    }
    return best;
  }

  /** The goal's spend limit in dollars, 0 for none. Local agents only (none paid, at least one agent): no limit. */
  function limitOf(building, requested) {
    const agents = deps.agents(String(building || ''));
    const paid = agents.length === 0 || agents.some((a) => a.paid !== false);
    return spendLimitFor({ paid, requested, fallback: defaultSpend }) ?? 0;
  }

  function stop(g, status, reason) { g.status = status; g.reason = reason; g.waitingFor = ''; touch(g); }

  /** Give the next pending step to a free agent. Called after every change that could free one. */
  async function pump(g) {
    if (g.status !== 'running' || g.pumping) return;
    if (g.steps.some((s) => s.status === 'working')) return; // one step at a time
    const step = g.steps.find((s) => s.status === 'pending');
    if (!step) {
      if (g.steps.every((s) => s.status === 'finished')) stop(g, 'finished', '');
      return;
    }
    // The spend limit is checked here, before the agent is asked to do anything.
    if (g.spendLimit > 0 && spent(g) >= g.spendLimit) { stop(g, 'stopped', 'Spend limit reached'); return; }
    const agent = pick(g, step);
    if (!agent) { g.waitingFor = step.id; touch(g); return; }
    g.waitingFor = '';
    g.pumping = true;
    step.status = 'working'; step.owner = agent.name; step.agentId = agent.id; step.attempts += 1;
    reserved.add(agent.id);
    if (!g.baseline.has(agent.id)) g.baseline.set(agent.id, Number(spendOf(agent.id)) || 0);
    touch(g);
    try {
      await deps.dispatch(agent, step.text, { goalId: g.id, stepId: step.id });
    } catch (e) {
      reserved.delete(agent.id);
      step.status = 'error'; step.result = clip(e && e.message || e, 300);
      stop(g, 'blocked', `Step failed: ${step.text}`);
    } finally { g.pumping = false; }
  }

  return {
    /** A goal in. Plans it, then runs it, or waits for approve() when approveFirst is set. Resolves to the goal id. */
    async submit(building, goal, opts = {}) {
      const text = String(goal || '').trim();
      if (!text) throw new Error('A goal is required.');
      if (text.length > GOAL_MAX) throw new Error(`The goal is too long. Keep it under ${GOAL_MAX} characters.`);
      const g = {
        id: 'g' + makeId(), building: String(building || ''), goal: text, status: 'planning', reason: '', steps: [],
        approveFirst: opts.approveFirst === true, spendLimit: limitOf(building, opts.spendLimit), messages: 0,
        baseline: new Map(), lastBoard: '', waitingFor: '', pumping: false, createdAt: now(), updatedAt: now(),
      };
      goals.set(g.id, g);
      touch(g);
      let raw;
      try { raw = await deps.planner(text, deps.agents(g.building)); } catch (e) { stop(g, 'failed', 'Could not make a plan: ' + clip(e && e.message || e, 200)); return g.id; }
      const steps = (Array.isArray(raw) ? raw : []).filter((x) => x && String(x.text || '').trim()).slice(0, limits.maxSteps);
      if (!steps.length) { stop(g, 'failed', 'The plan has no steps.'); return g.id; }
      g.steps = steps.map((x, i) => ({
        id: `${g.id}-${i + 1}`, text: clip(String(x.text).trim(), 300), role: x.role || '', room: x.room || '', bot: x.bot || '',
        status: 'pending', owner: x.bot || '', agentId: '', result: '', attempts: 0,
      }));
      g.status = g.approveFirst ? 'awaiting-approval' : 'running';
      touch(g);
      if (g.status === 'running') await pump(g);
      return g.id;
    },

    /** The user approves a held plan. */
    async approve(goalId) {
      const g = goals.get(goalId);
      if (!g || g.status !== 'awaiting-approval') return false;
      g.status = 'running'; touch(g);
      await pump(g);
      return true;
    },

    /** A step's agent finished its turn. ok = false marks the step failed and holds the goal for retry. */
    async finish(agentId, { ok = true, text = '' } = {}) {
      for (const g of goals.values()) {
        const step = g.steps.find((s) => s.status === 'working' && s.agentId === agentId);
        if (!step) continue;
        reserved.delete(agentId);
        step.result = clip(text, 300);
        if (ok) { step.status = 'finished'; touch(g); await pump(g); }
        else { step.status = 'error'; stop(g, 'blocked', `Step failed: ${step.text}`); }
        return true;
      }
      return false;
    },

    /** Run a failed step again (a new agent may take it). */
    async retry(goalId, stepId) {
      const g = goals.get(goalId);
      const step = g && g.steps.find((s) => s.id === stepId);
      if (!step || step.status !== 'error') return { ok: false, reason: 'That step has not failed.' };
      if (step.attempts >= limits.maxAttempts) return { ok: false, reason: `The step already ran ${step.attempts} times.` };
      step.status = 'pending'; step.result = ''; step.agentId = '';
      g.status = 'running'; g.reason = ''; touch(g);
      await pump(g);
      return { ok: true };
    },

    /** Something freed an agent: try to give the waiting step out. */
    async agentFreed() { for (const g of goals.values()) await pump(g); },

    /** Stop a goal. The agent of a running step is interrupted. */
    cancel(goalId) {
      const g = goals.get(goalId);
      if (!g || ['finished', 'cancelled'].includes(g.status)) return false;
      for (const s of g.steps) if (s.status === 'working') { reserved.delete(s.agentId); if (deps.interrupt) deps.interrupt(s.agentId); s.status = 'pending'; s.owner = s.bot || ''; s.agentId = ''; }
      stop(g, 'cancelled', 'Stopped by the user');
      return true;
    },

    /**
     * Agent mail inside a goal. hops counts the messages in a reply chain. Refused: the goal is not running,
     * the chain is too long, or the goal sent too many messages. Allowed mail goes to deps.deliver.
     */
    route({ goalId, from, to, text, hops = 0 }) {
      const g = goals.get(goalId);
      if (!g || g.status !== 'running') return { ok: false, reason: 'The goal is not running.' };
      if (hops >= limits.maxHops) return { ok: false, reason: `The reply chain reached ${limits.maxHops} messages.` };
      if (g.messages >= limits.maxMessages) return { ok: false, reason: `The goal reached ${limits.maxMessages} messages.` };
      g.messages += 1;
      if (deps.deliver) deps.deliver(to, from, String(text ?? ''), hops + 1);
      touch(g);
      return { ok: true, hops: hops + 1 };
    },

    get(goalId) { return goals.get(goalId) || null; },

    /** The agents that hold a running step now (the server finishes a step when its agent's turn ends). */
    workingAgents() { const out = []; for (const g of goals.values()) for (const s of g.steps) if (s.status === 'working' && s.agentId) out.push(s.agentId); return out; },

    /** Plain data of every goal for the state file (#156). restore() takes it back. */
    export() {
      return [...goals.values()].map((g) => ({
        id: g.id, building: g.building, goal: g.goal, status: g.status, reason: g.reason, approveFirst: g.approveFirst, spendLimit: g.spendLimit,
        messages: g.messages, createdAt: g.createdAt, updatedAt: g.updatedAt, baseline: [...g.baseline],
        steps: g.steps.map((s) => ({ id: s.id, text: s.text, role: s.role, room: s.room, bot: s.bot, status: s.status, owner: s.owner, result: s.result, attempts: s.attempts })),
      }));
    },

    /** Load saved goals at the office start. The agent of a running step is gone, so that step is an error step and the goal waits for retry
     *  or stop; a plan that was still being made failed. A record that does not fit is dropped. Nothing is dispatched here. */
    restore(list) {
      for (const r of Array.isArray(list) ? list : []) {
        if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !Array.isArray(r.steps) || typeof r.goal !== 'string' || goals.has(r.id)) continue;
        const st = (v, ok, d) => (ok.includes(v) ? v : d);
        const g = {
          id: r.id, building: String(r.building || ''), goal: r.goal, status: st(r.status, Object.keys(WORD), 'failed'), reason: String(r.reason || ''),
          approveFirst: r.approveFirst === true, spendLimit: Number.isFinite(r.spendLimit) && r.spendLimit >= 0 ? r.spendLimit : 0,
          messages: Number.isInteger(r.messages) ? r.messages : 0, baseline: new Map((Array.isArray(r.baseline) ? r.baseline : []).filter((e) => Array.isArray(e) && Number.isFinite(e[1]))),
          lastBoard: '', waitingFor: '', pumping: false, createdAt: Number(r.createdAt) || now(), updatedAt: Number(r.updatedAt) || now(),
          steps: r.steps.filter((s) => s && typeof s.id === 'string' && typeof s.text === 'string').slice(0, limits.maxSteps).map((s) => ({
            id: s.id, text: s.text, role: String(s.role || ''), room: String(s.room || ''), bot: String(s.bot || ''), status: st(s.status, Object.keys(MARK), 'pending'),
            owner: String(s.owner || ''), agentId: '', result: String(s.result || ''), attempts: Number.isInteger(s.attempts) ? s.attempts : 0,
          })),
        };
        if (g.status === 'planning') { g.status = 'failed'; g.reason = 'The office restarted before the plan was ready.'; }
        const ran = g.steps.filter((s) => s.status === 'working');
        for (const s of ran) { s.status = 'error'; s.result = 'The office restarted while this step ran.'; }
        if (ran.length) { g.status = 'blocked'; g.reason = `The office restarted. Retry or stop: ${ran[0].text}`; }
        goals.set(g.id, g);
      }
    },

    /** Call fn after every change of any goal. Returns the function that stops it. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** The goal's plan as a to-do list, or [] for an unknown goal. */
    todos(goalId) { const g = goals.get(goalId); return g ? todosOf(g) : []; },

    /** Plain data for every goal (no Maps), safe to send in the sessions snapshot. */
    snapshot() {
      return [...goals.values()].map((g) => ({
        id: g.id, building: g.building, goal: g.goal, status: g.status, reason: g.reason, approveFirst: g.approveFirst,
        spendLimit: g.spendLimit, spent: spent(g), messages: g.messages, waitingFor: g.waitingFor, updatedAt: g.updatedAt,
        steps: g.steps.map((s) => ({ id: s.id, text: s.text, role: s.role, room: s.room, owner: s.owner, status: s.status, result: s.result, attempts: s.attempts })),
      }));
    },

    /** The design system events that show a goal's plan: `plan`, then `plan.step` for each step that moved. */
    events(goalId) {
      const out = [];
      for (const g of goals.values()) {
        if (goalId && g.id !== goalId) continue;
        if (!g.steps.length || g.status === 'cancelled') continue;
        const bot = managerName(g.building);
        out.push({ type: 'plan', bot, goal: g.goal, steps: g.steps.map((s) => ({ id: s.id, text: s.text, status: 'resting', owner: s.owner })) });
        for (const s of g.steps) if (s.status !== 'pending') out.push({ type: 'plan.step', bot, id: s.id, status: STATUS_TO_DS[s.status], owner: s.owner });
      }
      return out;
    },
  };
}

/** The office Manager as a plan source (the contract at the top of this file). Office steps carry no cost of their own: the goal's spend is on the goal. */
export function officeSource(manager) {
  return {
    kind: 'office',
    list(building) {
      return manager.snapshot().filter((g) => !building || g.building === building).map((g) => ({
        id: g.id, building: g.building, goal: g.goal, status: g.status, reason: g.reason,
        steps: g.steps.map((s) => ({ id: s.id, title: s.text, state: s.status, owner: s.owner, cost: null })),
      }));
    },
    subscribe: (fn) => manager.subscribe(fn),
  };
}

/** The one reader of plan sources: the board, the page and the snapshot read this. A source that throws is listed as unreadable, and its plans are left out. */
export function createPlanBoard({ sources = [], onChange = () => {} } = {}) {
  const P = globalThis.OfficeVocab.plan;
  const stops = sources.map((src) => { try { return typeof src.subscribe === 'function' ? src.subscribe(() => onChange(src.kind)) : () => {}; } catch { return () => {}; } });
  return {
    snapshot(building) {
      const plans = [], unreadable = [];
      for (const src of sources) {
        let mapped;
        try {
          mapped = src.list(building).map((p) => ({
            id: p.id, building: p.building, goal: p.goal, status: p.status || '', reason: p.reason || '', frozen: p.frozen === true, source: src.kind, sourceWord: P.sourceWord(src.kind),
            steps: p.steps.map((s) => {
              const state = P.stepState(s.state);
              return { id: s.id, title: s.title, state, word: P.stepWord(state), owner: s.owner || '', cost: Number.isFinite(s.cost) ? s.cost : null,
                raw: s.raw || '', model: s.model || '', budget: s.budget || null, uid: s.uid || '', skipped: s.skipped === true, skippedWhy: s.skippedWhy || '' };
            }),
          }));
        } catch { unreadable.push({ source: src.kind, word: P.sourceWord(src.kind) }); continue; }
        plans.push(...mapped);
      }
      return { plans, unreadable };
    },
    close() { for (const stop of stops) stop(); },
  };
}
