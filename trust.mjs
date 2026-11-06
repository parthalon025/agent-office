// Earned trust (#153, ADR 0009): the office PROPOSES a Security room rule from the user's own answers; it never applies one.
// Owns: the decision ledger, the rule proposer, the grants (a rule the user confirmed from a proposal, with the cell it
// replaced), withdraw, and the trust card per agent kind. A distinct job from security.mjs (what a rule means) and server.mjs
// (the wiring): pure, no I/O, no clock (callers pass `at`), so history fixtures in, proposals out.
//   patternOf(tool, input)            the evidence name of a call ("npm test"), or null for a call that cannot be named safely
//   record(trust, entry)              add one answer of the user to the ledger (a decline drops a dismissal of its cell)
//   propose(ledger, rules, { dismissed, min })   proposals: [{ id, col, building, row, value: 'allow', pattern, count, text }]
//   grant(rules, trust, proposal, at, confirmed) apply one proposal through security.setRule (the painted Confirm: 409 without it)
//   withdraw(rules, trust, id)        restore the cell a grant replaced
//   cards(trust, runs)                clean runs, declined calls, rules granted, per agent kind
// A proposal is a building-scope cell for one agent kind. A cell has no command pattern, so Allow covers the whole row in that
// building for that kind: the pattern is the evidence, and the text says so. Never proposed: the Secrets rows (settings,
// secrets), the Agents rows, a cell that is already Allow or Deny, a streak with a decline or a high-risk call in it.
import { setRule } from './security.mjs';
import './public/vocab.js';

const S = globalThis.OfficeVocab.security;
const own = S.own;

export const MIN_APPROVALS = 5;
export const LEDGER_MAX = 400;
const NEVER = new Set(['settings', 'secrets']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COLS = new Set(S.columns.map((c) => c.id));
const FROM = new Set([null, 'ask', 'allow', 'deny']);
const shellStuff = /[;&|`<>\n\r]|\$\(|\$\{/;

function trustError(status, message) { const e = new Error(message); e.status = status; return e; }
const idOf = (col, building, row) => `${col}|${building}|${row}`;

/** The evidence name of a call. A shell command is its first two words, and only when it is one plain command. */
export function patternOf(tool, input) {
  if (tool === 'Bash' || tool === 'PowerShell') {
    const c = input && typeof input.command === 'string' ? input.command.trim() : '';
    if (!c || shellStuff.test(c)) return null;
    return c.split(/\s+/).slice(0, 2).join(' ').toLowerCase().slice(0, 40);
  }
  return typeof tool === 'string' && tool ? tool.slice(0, 40) : null;
}

const goodEntry = (e) => e && typeof e === 'object' && Number.isFinite(e.at) && COLS.has(e.col) && typeof e.building === 'string' && !BAD_KEYS.has(e.building)
  && typeof e.row === 'string' && typeof e.allow === 'boolean';
const goodGrant = (g) => g && typeof g === 'object' && typeof g.id === 'string' && COLS.has(g.col) && typeof g.building === 'string' && !BAD_KEYS.has(g.building)
  && typeof g.row === 'string' && FROM.has(g.from === undefined ? null : g.from) && Number.isFinite(g.at);

/** The saved earned-trust state, cut to well-formed entries: { ledger, grants, dismissed }. */
export function cleanTrust(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const dismissed = {};
  if (r.dismissed && typeof r.dismissed === 'object') for (const k of Object.keys(r.dismissed)) if (!BAD_KEYS.has(k) && Number.isFinite(r.dismissed[k])) dismissed[k] = r.dismissed[k];
  return {
    ledger: (Array.isArray(r.ledger) ? r.ledger.filter(goodEntry) : []).map((e) => ({ at: e.at, col: e.col, building: e.building, row: e.row, pattern: typeof e.pattern === 'string' ? e.pattern : null, allow: e.allow, risk: typeof e.risk === 'string' ? e.risk : 'medium' })).slice(-LEDGER_MAX),
    grants: (Array.isArray(r.grants) ? r.grants.filter(goodGrant) : []).map((g) => ({ id: g.id, col: g.col, building: g.building, row: g.row, from: g.from === undefined ? null : g.from, at: g.at })),
    dismissed,
  };
}

/** One answer of the user (a held request answered on the page). entry: { at, col, building, row, pattern, allow, risk }. */
export function record(trust, entry) {
  const t = cleanTrust(trust);
  if (!goodEntry(entry)) return t;
  const ledger = [...t.ledger, { at: entry.at, col: entry.col, building: entry.building, row: entry.row, pattern: entry.pattern ?? null, allow: entry.allow, risk: entry.risk || 'medium' }].slice(-LEDGER_MAX);
  const dismissed = { ...t.dismissed };
  if (!entry.allow) delete dismissed[idOf(entry.col, entry.building, entry.row)];
  return { ...t, ledger, dismissed };
}

const buildingName = (b) => (b ? b.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'Other folders');

/** Proposals from the ledger (oldest first). rules: the current Security room rules. opts: { dismissed, min }. */
export function propose(ledger, rules, opts = {}) {
  const min = opts.min || MIN_APPROVALS, dismissed = opts.dismissed || {};
  const streaks = new Map();
  for (const e of Array.isArray(ledger) ? ledger : []) {
    if (!goodEntry(e) || !S.rows[e.row] || S.rows[e.row].office || NEVER.has(e.row) || !S.applies(e.row, e.col)) continue;
    const id = idOf(e.col, e.building, e.row);
    let g = streaks.get(id);
    if (!g) streaks.set(id, g = { col: e.col, building: e.building, row: e.row, count: 0, patterns: {} });
    // A decline or a high-risk call ends the streak. An approval of a call with no safe name is neutral: it is no evidence.
    if (!e.allow || e.risk === 'high') { g.count = 0; g.patterns = {}; continue; }
    if (!e.pattern) continue;
    g.count++;
    g.patterns[e.pattern] = (g.patterns[e.pattern] || 0) + 1;
  }
  const out = [];
  for (const [id, g] of streaks) {
    if (g.count < min || own(dismissed, id)) continue;
    if (S.valueOf(rules, g.building, g.row, g.col) !== 'ask') continue;
    const [pattern] = Object.entries(g.patterns).sort((a, b) => b[1] - a[1])[0];
    const agent = S.columns.find((c) => c.id === g.col).label, row = S.rows[g.row].label, where = buildingName(g.building);
    out.push({
      id, col: g.col, building: g.building, row: g.row, value: 'allow', pattern, count: g.count, agent, rowLabel: row, buildingName: where,
      text: `You approved ${pattern} ${g.count} times for ${agent} in ${where}. Allow ${row} there? This covers every such call in that building, not only ${pattern}.`,
    });
  }
  return out;
}

/** Apply one proposal through the same looser-change path as the wall (confirmed: true). Returns { rules, trust }. */
export function grant(rules, trust, proposal, at, confirmed) {
  const t = cleanTrust(trust);
  const had = S.sourceOf(rules, proposal.building, proposal.row, proposal.col) === 'building' ? S.valueOf(rules, proposal.building, proposal.row, proposal.col) : null;
  const r = setRule(rules, { scope: 'building', building: proposal.building, row: proposal.row, col: proposal.col, value: proposal.value, confirmed: confirmed === true });
  const dismissed = { ...t.dismissed }; delete dismissed[proposal.id];
  return { rules: r.rules, from: r.from, to: r.to, trust: { ...t, dismissed, grants: [...t.grants.filter((g) => g.id !== proposal.id), { id: proposal.id, col: proposal.col, building: proposal.building, row: proposal.row, from: had, at }] } };
}

/** Withdraw a grant: the cell goes back to what it was. A cell the user changed since is left as the user set it. */
export function withdraw(rules, trust, id) {
  const t = cleanTrust(trust);
  const g = t.grants.find((x) => x.id === id);
  if (!g) throw trustError(404, 'No such grant.');
  const grants = t.grants.filter((x) => x.id !== id);
  // The streak that earned the grant stays in the ledger, so the same proposal must not come straight back: it is dismissed
  // until a decline in the cell (record) resets it.
  const dismissed = { ...t.dismissed, [id]: g.at };
  const still = S.sourceOf(rules, g.building, g.row, g.col) === 'building' && S.valueOf(rules, g.building, g.row, g.col) === 'allow';
  if (!still) return { rules, trust: { ...t, grants, dismissed } };
  const r = setRule(rules, { scope: 'building', building: g.building, row: g.row, col: g.col, value: g.from, confirmed: true });
  return { rules: r.rules, from: r.from, to: r.to, trust: { ...t, grants, dismissed } };
}

/** The trust card of each agent kind that has any history. runs: [{ col, failed }] (past and live sessions). */
export function cards(trust, runs) {
  const t = cleanTrust(trust);
  return S.columns.map((c) => {
    const mine = (runs || []).filter((r) => r.col === c.id);
    return {
      col: c.id, agent: c.label, runs: mine.length, clean: mine.filter((r) => !r.failed).length,
      declined: t.ledger.filter((e) => e.col === c.id && !e.allow).length,
      granted: t.grants.filter((g) => g.col === c.id).length,
    };
  }).filter((x) => x.runs || x.declined || x.granted);
}
