// Security room rules (#70): the user's permission grid of action kinds and agent kinds, and what the office does with it.
// A distinct job from risk.mjs (how risky one call is, and its row) and from server.mjs (the wiring): pure, no I/O, no
// timers, so the rules are tested without a server. The grid's names, rows, options and defaults are the shared vocabulary
// in public/vocab.js (the wall screens read the same table); this file adds the rules only the office applies:
//   cleanRules(raw)                  the saved rules (state.json), cut to cells the grid has with values the row offers
//   setRule(rules, change)           one change from the wall, checked: { rules, from, to }, or a status error
//   decide(rules, call)              the check before a hold: { allow, line, message?, quiet } or null (hold as today)
//   preToolDecision(rules, call)     Claude Code's PreToolUse answer: a Deny refuses before Claude Code's own check, and a
//                                    tightened low row (read or edit inside: Ask) makes Claude Code ask
//   permissionModeFor(rules, b, m)   the permission mode of a new Claude Code office session ('default' while any cell is Ask)
//   openRefusal(rules, provider)     why the office does not open an agent kind now (ungated and off, no cost reports and Deny)
//   enforcement(providers)           per agent kind: why a cell is not enforced ('' = it is), for "Not enforced for this agent"
//   addCost(ledger, at, col, $), costThisMonth(ledger, at)   the Spend screen's cost per agent kind this month
// rules: { office: { 'row|col': value }, buildings: { buildingKey: { 'row|col': value } } }. A default is not stored.
// A provider may list the rows its agent's own config takes (enforces: ['shell']) when it is ungated (gated: false, ADR 0001).
import { ratingOf } from './risk.mjs';
import './public/vocab.js';

const S = globalThis.OfficeVocab.security;
const COLS = new Set(S.columns.map((c) => c.id));
const label = (row) => S.rows[row].label;
// The rows that rule tool calls (not the Agents screen).
const CALL_ROWS = Object.keys(S.rows).filter((r) => !S.rows[r].office);

function rulesError(status, message) { const e = new Error(message); e.status = status; return e; }

/** The saved rules, cut to cells the grid has, with values the row offers. Agents rows have no building override. */
export function cleanRules(raw) {
  const out = { office: {}, buildings: {} };
  const keep = (map, office) => {
    const o = {};
    if (!map || typeof map !== 'object') return o;
    for (const [k, v] of Object.entries(map)) {
      const [row, col] = String(k).split('|');
      if (!S.rows[row] || !COLS.has(col) || !S.applies(row, col) || !S.options(row).includes(v)) continue;
      if (!office && S.rows[row].office) continue;
      o[k] = v;
    }
    return o;
  };
  out.office = keep(raw && raw.office, true);
  const bs = raw && raw.buildings && typeof raw.buildings === 'object' ? raw.buildings : {};
  for (const [b, map] of Object.entries(bs)) {
    if (b.length > 400) continue;
    const m = keep(map, false);
    if (Object.keys(m).length) out.buildings[b] = m;
  }
  return out;
}

/**
 * One change from the wall. change: { scope: 'office' | 'building', building, row, col, value, confirmed }.
 * value null in the building scope clears the override (the office-wide rule applies again).
 * A change to Allow or On loosens: it needs confirmed: true (the painted Confirm). Ask and Deny apply at once.
 * The two Secrets rows never take Allow. Returns { rules, from, to } with new rules; the old object is not changed.
 */
export function setRule(rules, change) {
  const { scope, row, col } = change || {};
  const value = change && change.value === undefined ? null : change && change.value;
  if (!S.rows[row]) throw rulesError(400, 'Unknown rule.');
  if (!COLS.has(col) || !S.applies(row, col)) throw rulesError(400, 'That agent kind has no such rule.');
  if (scope !== 'office' && scope !== 'building') throw rulesError(400, 'Give the scope: office or building.');
  const building = scope === 'building' ? change.building : null;
  if (scope === 'building') {
    if (S.rows[row].office) throw rulesError(400, 'The Agents rules are office-wide.');
    if (typeof building !== 'string' || building.length > 400) throw rulesError(400, 'Give the building.');
  }
  if (value !== null || scope === 'office') {
    if (!S.options(row).includes(value)) {
      if (value === 'allow' && S.options(row).includes('ask')) throw rulesError(400, `${label(row)} offer only Ask or Deny.`);
      throw rulesError(400, 'Unknown value.');
    }
  }
  const r = cleanRules(rules);
  const k = S.key(row, col);
  const from = S.valueOf(r, building, row, col);
  const next = { office: { ...r.office }, buildings: Object.fromEntries(Object.entries(r.buildings).map(([b, m]) => [b, { ...m }])) };
  if (scope === 'office') {
    if (value === S.rows[row].def) delete next.office[k]; else next.office[k] = value;
  } else {
    const m = next.buildings[building] || {};
    if (value === null) delete m[k]; else m[k] = value;
    if (Object.keys(m).length) next.buildings[building] = m; else delete next.buildings[building];
  }
  const to = S.valueOf(next, building, row, col);
  if (S.loosens(row, from, to) && change.confirmed !== true) throw rulesError(409, 'Confirm the looser rule on the wall first.');
  return { rules: next, from, to };
}

// The rule for one call. call: { building, kind (the provider kind), tool, input, root }.
function verdict(rules, call) {
  const col = S.columnOf(call.kind);
  const { risk, action } = ratingOf(call.tool, call.input, call.root);
  if (!col || !S.rows[action] || S.rows[action].office || !S.applies(action, col)) return { risk, action, col, value: null };
  return { risk, action, col, value: S.valueOf(rules, call.building ?? null, action, col) };
}

/**
 * The check before a hold. Allow: answer yes at once; Deny: answer no at once; Ask (or a call with no row): null, hold
 * as today. line: the feed line. quiet: a provider asked about a low call its rule allows; that is no news (the agent
 * ran such calls without asking before #70), so the feed shows only the call itself. call.provider: the request came
 * from a provider that asks about every call (providers/local.mjs), not from a hook.
 */
export function decide(rules, call) {
  const v = verdict(rules, call);
  if (v.value === 'allow') return { allow: true, line: `allowed by Security: ${label(v.action)}`, quiet: !!call.provider && v.risk === 'low' };
  if (v.value === 'deny') return { allow: false, line: `denied by Security: ${label(v.action)}`, message: `Denied by the Security room: ${label(v.action)}.`, quiet: false };
  return null;
}

/**
 * Claude Code's PreToolUse answer: { decision: 'deny' | 'ask', reason, line } or null (no answer: Claude Code decides).
 * Deny refuses the call before Claude Code's own permission check, so its allow rules and modes cannot run it.
 * Ask on a row whose default is Allow (the user tightened a read or an edit inside) makes Claude Code ask, because it
 * does not ask about those calls by itself; the office then holds the prompt. Ask on any other row keeps today's
 * behavior: Claude Code asks as it does, and the office holds what it asks.
 */
export function preToolDecision(rules, call) {
  const v = verdict(rules, call);
  if (v.value === 'deny') return { decision: 'deny', reason: `Denied by the Security room: ${label(v.action)}.`, line: `denied by Security: ${label(v.action)}` };
  if (v.value === 'ask' && S.rows[v.action].def === 'allow') return { decision: 'ask', reason: `The Security room asks for ${label(v.action).toLowerCase()}.`, line: null };
  return null;
}

/**
 * The permission mode of a new Claude Code office session. While any of its call cells is Ask (in this building), the
 * session opens in 'default' mode, so Claude Code asks and the rules apply; Allow cells are then answered at once.
 * 'plan' stays (it runs no tool). With no Ask cell the requested mode stays (null: Claude Code's own default).
 */
export function permissionModeFor(rules, building, requested) {
  if (requested === 'plan') return 'plan';
  const anyAsk = CALL_ROWS.some((row) => S.valueOf(rules, building ?? null, row, 'claude-code') === 'ask');
  return anyAsk ? 'default' : requested || null;
}

/** Why the office does not open this agent kind now, or null. provider: { kind, label, gated?, cost? }. */
export function openRefusal(rules, provider) {
  const col = S.columnOf(provider && provider.kind);
  if (!col) return null;
  if (provider.gated === false && S.applies('ungated', col) && S.valueOf(rules, null, 'ungated', col) !== 'on') {
    return `${provider.label} runs tool calls without asking the office. Turn on ${provider.label} on the Agents screen of the Security room first.`;
  }
  if (provider.cost === 'unknown' && S.applies('no-cost', col) && S.valueOf(rules, null, 'no-cost', col) === 'deny') {
    return `${provider.label} does not report cost, and the Security room denies agents without cost reports.`;
  }
  return null;
}

// The reasons name no agent kind, so a screen can say one reason once for several kinds ("Not enforced for Hermes, dsh.").
const NOT_SET_UP = 'The office has no provider for this agent kind yet. The rule applies when it has one.';
const UNGATED = 'This agent runs this kind of call without asking the office.';
/**
 * Per agent kind (column): { reason, rows }. reason '' means the office enforces the cells of that kind; else every
 * cell shows "Not enforced for this agent" with the reason. rows: a reason for one row only.
 * providers: the office's providers ({ kind, label, gated?, enforces? }). Paperclip is not built: its row says so.
 */
export function enforcement(providers) {
  const out = {};
  for (const c of S.columns) {
    const list = (providers || []).filter((p) => S.columnOf(p.kind) === c.id);
    const rows = {};
    let reason = '';
    if (!list.length) reason = NOT_SET_UP;
    else if (list.some((p) => p.gated === false)) {
      const takes = new Set(list.flatMap((p) => (Array.isArray(p.enforces) ? p.enforces : [])));
      for (const row of CALL_ROWS) if (S.applies(row, c.id) && !takes.has(row)) rows[row] = UNGATED;
    }
    if (S.applies('supervise', c.id)) rows.supervise = 'Paperclip is not connected to this office.';
    out[c.id] = { reason, rows };
  }
  return out;
}

// ---------- the Spend screen: cost per agent kind this month ----------
const monthOf = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const KEEP_MONTHS = 3;
/** The ledger with dollars added to an agent kind's month. Keeps the last three months. A new object. */
export function addCost(ledger, at, col, dollars) {
  const n = Number(dollars);
  const out = Object.fromEntries(Object.entries(ledger && typeof ledger === 'object' ? ledger : {}).map(([m, v]) => [m, { ...v }]));
  if (!COLS.has(col) || !(n > 0) || !Number.isFinite(n)) return out;
  const m = monthOf(at);
  out[m] = out[m] || {};
  out[m][col] = Math.round(((out[m][col] || 0) + n) * 1e6) / 1e6;
  for (const old of Object.keys(out).sort().slice(0, -KEEP_MONTHS)) delete out[old];
  return out;
}
/** { month: 'YYYY-MM', byColumn: { col: dollars } } for the month of `at`. */
export function costThisMonth(ledger, at) {
  const month = monthOf(at);
  return { month, byColumn: { ...((ledger && ledger[month]) || {}) } };
}
