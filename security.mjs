// Security room rules (#70): the user's permission grid of action kinds and agent kinds, and what the office does with it.
// A distinct job from risk.mjs (how risky one call is, and its row) and from server.mjs (the wiring): pure, no I/O, no
// timers, so the rules are tested without a server. The grid's names, rows, options and defaults are the shared vocabulary
// in public/vocab.js (the wall screens read the same table); this file adds the rules only the office applies:
//   cleanRules(raw)                  the saved rules (state.json), cut to cells the grid has with values the row offers
//   setRule(rules, change)           one change from the wall, checked: { rules, from, to }, or a status error
//   decide(rules, call)              the check before a hold: { allow, line, message?, quiet } or null (hold as today)
//   preToolDecision(rules, call)     Claude Code's PreToolUse answer: a Deny refuses before Claude Code's own check, and an
//                                    Ask on a row Claude Code does not ask about by itself makes it ask
//   permissionModeFor(rules, b, m)   the permission mode of a new Claude Code office session ('default' while any cell is Ask)
//   openRefusal(rules, provider)     why the office does not open an agent kind now (ungated and off, no cost reports and Deny)
//   costAsk(rules, provider)         an agent without cost reports asks once per session unless its cell is Allow
//   cellsOf(rules, building, col)    the call cells of one agent kind, for an agent whose own config carries them (OpenClaw)
//   enforcement(providers, policies) per agent kind: why a cell is not enforced ('' = it is), for "Not enforced for this agent",
//                                    from what an ungated agent's own config was found to carry (policies) when the office read it,
//                                    and why an Ask cell is only partly enforced (asks), for "Partly enforced"
//   addCost(ledger, at, col, $), costThisMonth(ledger, at)   the Spend screen's cost per agent kind this month
// rules: { office: { 'row|col': value }, buildings: { buildingKey: { 'row|col': value } } }. A default is not stored.
// A provider may list the rows its agent's own config takes (enforces: ['shell']) when it is ungated (gated: false, ADR 0001).
// call: { building, kind, tool, input, root, worktree, provider?, firm? }. building: the session's building key, or null while the
// session is not placed (git not looked up yet). worktree: true when root is inside a git worktree. The rows Read inside
// and Edit inside apply only then, and never for a wide root (risk.mjs wideRoot: the home folder, a drive): any other root
// has no worktree, so its reads and edits are Read or edit outside it (default Ask).
// The rules apply only while the office runs: a stopped office answers no hook, and Claude Code then decides alone.
import { ratingOf, wideRoot } from './risk.mjs';
import './public/vocab.js';

const S = globalThis.OfficeVocab.security;
const COLS = new Set(S.columns.map((c) => c.id));
const own = S.own;
// Building keys that would reach Object.prototype through a plain object. A building key is a normalized folder path or ''.
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const okBuilding = (b) => typeof b === 'string' && b.length <= 400 && !BAD_KEYS.has(b);
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
      if (k !== S.key(row, col)) continue;   // one '|' only
      if (!S.rows[row] || !COLS.has(col) || !S.applies(row, col) || !S.options(row).includes(v)) continue;
      if (!office && S.rows[row].office) continue;
      o[k] = v;
    }
    return o;
  };
  out.office = keep(raw && raw.office, true);
  const bs = raw && raw.buildings && typeof raw.buildings === 'object' ? raw.buildings : {};
  for (const [b, map] of Object.entries(bs)) {
    if (!okBuilding(b)) continue;
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
    if (!okBuilding(building)) throw rulesError(400, 'Give the building.');
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
    const m = own(next.buildings, building) ? next.buildings[building] : {};
    if (value === null) delete m[k]; else m[k] = value;
    if (Object.keys(m).length) next.buildings[building] = m; else delete next.buildings[building];
  }
  const to = S.valueOf(next, building, row, col);
  if (S.loosens(row, from, to) && change.confirmed !== true) throw rulesError(409, 'Confirm the looser rule on the wall first.');
  return { rules: next, from, to };
}

// Rows Claude Code asks about by itself in default mode, unless its own allow rules or permission mode let the call run.
// On these rows an Ask cell keeps the user's Claude Code settings (the office holds what Claude Code asks), so it is only
// partly enforced (enforcement asks). On every other call row (read or edit inside, settings, secrets) Claude Code does
// not ask by itself (it reads files in its folder without asking), so an Ask there makes Claude Code ask (preToolDecision).
const CLAUDE_ASKS = new Set(['files-outside', 'shell', 'web', 'mcp']);
const INSIDE_ROWS = new Set(['read-inside', 'edit-inside']);
const STRICT = { deny: 3, ask: 2, allow: 1 };

// The rule for one call: { risk, action, col, value, unsure }. unsure: the session is not placed yet and some building has
// a stricter override than the office rule, so the value is Ask (hold), never a guess that could be looser.
function verdict(rules, call) {
  const col = S.columnOf(call.kind);
  let { risk, action } = ratingOf(call.tool, call.input, call.root);
  if (INSIDE_ROWS.has(action) && (call.worktree !== true || wideRoot(call.root))) action = 'files-outside';
  if (!col || !S.rows[action] || S.rows[action].office || !S.applies(action, col)) return { risk, action, col, value: null, unsure: false };
  const office = S.valueOf(rules, null, action, col);
  if (call.building != null) return { risk, action, col, value: S.valueOf(rules, call.building, action, col), unsure: false };
  const k = S.key(action, col), all = Object.values((rules && rules.buildings) || {});
  // Only a stricter override matters: a looser one is applied once the session is placed, and the office rule is safe.
  const stricter = all.some((m) => own(m, k) && (STRICT[m[k]] || 0) > (STRICT[office] || 0));
  return stricter ? { risk, action, col, value: 'ask', unsure: true } : { risk, action, col, value: office, unsure: false };
}

/**
 * The check before a hold. Allow: answer yes at once; Deny: answer no at once; Ask (or a call with no row): null, hold
 * as today. line: the feed line. quiet: a provider asked about a low call its rule allows; that is no news (the agent
 * ran such calls without asking before #70), so the feed shows only the call itself. call.provider: the request came
 * from a provider that asks about every call (providers/local.mjs), not from a hook.
 */
export function decide(rules, call) {
  const v = verdict(rules, call);
  // call.firm: the provider must ask the user about this call (an ACP write after a declined or unanswered edit): an Allow
  // rule does not answer it, a Deny rule still does.
  if (v.value === 'allow' && !call.firm) return { allow: true, line: `allowed by Security: ${label(v.action)}`, quiet: !!call.provider && v.risk === 'low' };
  if (v.value === 'deny') return { allow: false, line: `denied by Security: ${label(v.action)}`, message: `Denied by the Security room: ${label(v.action)}.`, quiet: false };
  return null;
}

/**
 * Claude Code's PreToolUse answer: { decision: 'deny' | 'ask', reason, line } or null (no answer: Claude Code decides).
 * Deny refuses the call before Claude Code's own permission check, so its allow rules and modes cannot run it.
 * Ask on a row Claude Code does not ask about by itself (read or edit inside, settings, secrets) makes Claude Code ask;
 * the office then holds the prompt. So does a session not placed yet whose building may differ (unsure). Ask on the
 * other rows (outside files, shell, web, MCP) keeps Claude Code's own rules and mode: it asks as it does, and the office
 * holds what it asks. That Ask is only partly enforced, and the wall says so (enforcement asks).
 */
export function preToolDecision(rules, call) {
  const v = verdict(rules, call);
  if (v.value === 'deny') return { decision: 'deny', reason: `Denied by the Security room: ${label(v.action)}.`, line: `denied by Security: ${label(v.action)}` };
  if (v.value === 'ask' && (v.unsure || !CLAUDE_ASKS.has(v.action))) return { decision: 'ask', reason: `The Security room asks for ${label(v.action).toLowerCase()}.`, line: null };
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

/**
 * True when the office asks the user once before this session runs: its agent reports no cost (provider.cost 'unknown',
 * owner decision Q22) and its "Run without cost reports" cell is not Allow. Ask asks; Allow runs it without the question;
 * Deny never gets here (openRefusal refuses it first), and it still asks if a caller skips that check. An agent kind with
 * no such cell asks. provider: { kind, cost? }.
 */
export function costAsk(rules, provider) {
  if (!provider || provider.cost !== 'unknown') return false;
  const col = S.columnOf(provider.kind);
  if (!col || !S.applies('no-cost', col)) return true;
  return S.valueOf(rules, null, 'no-cost', col) !== 'allow';
}

// The reasons name no agent kind, so a screen can say one reason once for several kinds ("Not enforced for Hermes, dsh.").
const NOT_SET_UP = 'The office has no provider for this agent kind yet. The rule applies when it has one.';
const UNGATED = 'This agent runs this kind of call without asking the office.';
// Short enough for one line on the wall (public/security.js footer). The agent: Claude Code, the only kind with these rows.
const CLAUDE_DECIDES = 'The agent asks only when its own allow rules and permission mode say so.';
/**
 * Per agent kind (column): { reason, rows, asks }. reason '' means the office enforces the cells of that kind; else every
 * cell shows "Not enforced for this agent" with the reason. rows: a reason for one row only. asks: a reason for one row
 * while its cell is Ask ("Partly enforced"): Claude Code decides itself whether to ask on some rows (CLAUDE_ASKS). Allow and
 * Deny on those rows are enforced. The no-cost cell is enforced: Ask asks once per session (costAsk), Deny refuses (openRefusal).
 * providers: the office's providers ({ kind, label, gated?, enforces? }). Paperclip is not built: its row says so.
 * policies: provider kind -> what an ungated agent's own config was found to carry (provider.policy(): { config: { settings:
 * [{ path, have, ok, fix, rows }] }, gaps: [{ row, reason }] }, providers/openclaw.mjs). With one, a row is enforced when no
 * setting it needs is off and config can carry it; else the row says why. Without one (not read yet), the provider's own
 * claim (enforces) counts.
 */
export function enforcement(providers, policies = {}) {
  const out = {};
  for (const c of S.columns) {
    const list = (providers || []).filter((p) => S.columnOf(p.kind) === c.id);
    const rows = {};
    let reason = '';
    const read = list.map((p) => own(policies, p.kind) && policies[p.kind]).find((x) => x && x.config);
    if (!list.length) reason = NOT_SET_UP;
    else if (read) Object.assign(rows, policyRows(read));
    else if (list.some((p) => p.gated === false)) {
      const takes = new Set(list.flatMap((p) => (Array.isArray(p.enforces) ? p.enforces : [])));
      for (const row of CALL_ROWS) if (S.applies(row, c.id) && !takes.has(row)) rows[row] = UNGATED;
    }
    if (S.applies('supervise', c.id)) rows.supervise = 'Paperclip is not connected to this office.';
    const asks = {};
    if (c.id === 'claude-code') for (const row of CLAUDE_ASKS) asks[row] = CLAUDE_DECIDES;
    out[c.id] = { reason, rows, asks };
  }
  return out;
}

// The rows an agent's config does not carry, from its policy: a gap (a cell config cannot express), else a setting a cell
// needs that is off or could not be read. Every other row is enforced: an Allow cell runs, which is what the agent does.
function policyRows(policy) {
  const rows = {};
  for (const x of (policy.config && policy.config.settings) || []) {
    if (x.ok) continue;
    const why = x.have === 'unknown'
      ? `The office could not read ${x.path} in its config, so it cannot confirm this rule.`
      : `Its config does not carry this rule: ${x.path} is ${x.have}.${x.fix ? ` Run: ${x.fix}` : ''}`;
    for (const row of x.rows || []) if (S.rows[row] && !own(rows, row)) rows[row] = why;
  }
  for (const g of policy.gaps || []) if (S.rows[g.row] && !own(rows, g.row) && typeof g.reason === 'string') rows[g.row] = g.reason;
  return rows;
}

/** The call cells of one agent kind (row -> ask | allow | deny) in a building (null: office-wide), for an agent whose own
 *  config carries the rules (providers/openclaw.mjs wantedConfig). The Agents rows are not calls and are left out. */
export function cellsOf(rules, building, col) {
  const out = {};
  for (const row of CALL_ROWS) if (S.applies(row, col)) out[row] = S.valueOf(rules, building ?? null, row, col);
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
